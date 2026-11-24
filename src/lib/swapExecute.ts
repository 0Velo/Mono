/**
 * The only path that signs and broadcasts a Jupiter swap.
 *
 * Order is deliberate and must not be reordered: deserialize → structural
 * guard → simulate and verify the balance changes → sign → send → confirm.
 * A transaction that fails any step is never signed, so nothing irreversible
 * happens on the strength of a remote API response alone.
 */
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js'
import { base64ToBytes, type SwapQuote, type SwapTransaction } from './swap'
import {
  SwapGuardError,
  accountKeysWithLookups,
  assertSwapSimulation,
  assertSwapTransaction,
  resolveStaticAccountKeys,
  type SwapSimulationLike,
} from './swapGuard'

export type SwapStep = 'guard' | 'simulate' | 'sign' | 'send' | 'confirm'

export interface ExecuteSwapOptions {
  connection: Connection
  keypair: Keypair
  built: SwapTransaction
  quote: SwapQuote
  onStep?: (step: SwapStep) => void
}

export class SwapExecutionError extends Error {
  step: SwapStep
  constructor(step: SwapStep, message: string) {
    super(message)
    this.name = 'SwapExecutionError'
    this.step = step
  }
}

/** Fetches the address lookup tables a v0 message references. */
export async function resolveLookupKeys(
  connection: Connection,
  tx: VersionedTransaction,
): Promise<PublicKey[]> {
  const staticKeys = resolveStaticAccountKeys(tx)
  if (staticKeys) return staticKeys

  const tables: AddressLookupTableAccount[] = []
  for (const lookup of tx.message.addressTableLookups ?? []) {
    const info = await connection.getAccountInfo(lookup.accountKey, 'confirmed')
    if (!info) {
      throw new SwapGuardError(
        'lookup-unresolved',
        lookup.accountKey.toBase58(),
        '스왑 주소 테이블을 불러오지 못했습니다. 서명하지 않았습니다.',
      )
    }
    tables.push(
      new AddressLookupTableAccount({
        key: lookup.accountKey,
        state: AddressLookupTableAccount.deserialize(info.data),
      }),
    )
  }
  return accountKeysWithLookups(tx, tables)
}

export async function executeSwap({
  connection,
  keypair,
  built,
  quote,
  onStep,
}: ExecuteSwapOptions): Promise<string> {
  const user = keypair.publicKey.toBase58()

  let tx: VersionedTransaction
  try {
    tx = VersionedTransaction.deserialize(base64ToBytes(built.transaction))
  } catch {
    throw new SwapExecutionError('guard', '스왑 트랜잭션을 읽지 못했습니다. 다시 시도해 주세요.')
  }

  onStep?.('guard')
  const keys = await resolveLookupKeys(connection, tx)
  assertSwapTransaction(tx, user, keys)

  onStep?.('simulate')
  let simulation: SwapSimulationLike
  try {
    simulation = (await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    })) as unknown as SwapSimulationLike
  } catch (error) {
    throw new SwapExecutionError(
      'simulate',
      `스왑 시뮬레이션에 실패했습니다. ${
        error instanceof Error && error.message ? `(${error.message})` : ''
      }`.trim(),
    )
  }
  assertSwapSimulation(simulation, {
    owner: user,
    inputMint: quote.inputMint,
    inAmount: quote.inAmount,
    outputMint: quote.outputMint,
    minOut: quote.otherAmountThreshold,
  })

  onStep?.('sign')
  tx.sign([keypair])

  onStep?.('send')
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: 'confirmed',
  })

  onStep?.('confirm')
  const blockhash = tx.message.recentBlockhash
  const lastValidBlockHeight =
    built.lastValidBlockHeight ?? (await connection.getBlockHeight('confirmed')) + 150
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  )
  if (confirmation.value.err) {
    throw new SwapExecutionError('confirm', '스왑 트랜잭션이 컨펌되지 않았습니다. Solscan에서 상태를 확인하세요.')
  }
  return signature
}
