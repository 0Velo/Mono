import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { base64ToBytes, type SwapQuote, type SwapTransaction } from './swap'
import { inspectTransaction, TxOutcomeError, type TransactionHooks } from './tx'
import {
  SwapGuardError,
  accountKeysWithLookups,
  assertSwapSimulation,
  assertSwapTransaction,
  resolveStaticAccountKeys,
  type SwapSimulationLike,
} from './swapGuard'
import {
  PREVIEW_TTL_MS,
  assertMessageMatches,
  buildTransactionPreview,
  captureMessageBytes,
  simulateAndCapture,
  toSwapSimulation,
  type TransactionPreview,
} from './transactionPreview'

export type SwapStep = 'guard' | 'simulate' | 'sign' | 'send' | 'confirm'

export interface ExecuteSwapOptions {
  connection: Connection
  keypair: Keypair
  built: SwapTransaction
  quote: SwapQuote
  onStep?: (step: SwapStep) => void
  hooks?: TransactionHooks
}

export interface PreparedSwapExecution {
  transaction: VersionedTransaction
  messageBytes: Uint8Array
  preview: TransactionPreview
  owner: string
  quoteIdentity: string
  lastValidBlockHeight: number
  createdAt: number
}

export class SwapExecutionError extends Error {
  step: SwapStep
  constructor(step: SwapStep, message: string) {
    super(message)
    this.name = 'SwapExecutionError'
    this.step = step
  }
}

const RPC_TIMEOUT_MS = 20_000
const CONFIRM_TIMEOUT_MS = 90_000
const CONFIRM_POLL_MS = 1_500

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function notifyTerminal(hooks?: TransactionHooks): void {
  try {
    hooks?.onTerminal?.()
  } catch {
    // A stale local marker is reconciled again; it must not hide a chain result.
  }
}

function quoteIdentity(quote: SwapQuote): string {
  return JSON.stringify({
    base: quote.base,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    otherAmountThreshold: quote.otherAmountThreshold,
    slippageBps: quote.slippageBps,
    raw: quote.raw,
  })
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
    const info = await withTimeout(
      connection.getAccountInfo(lookup.accountKey, 'confirmed'),
      RPC_TIMEOUT_MS,
      '스왑 주소 테이블 조회가 시간 초과되었습니다. 서명하지 않았습니다.',
    )
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

export async function prepareSwap({
  connection,
  keypair,
  built,
  quote,
  onStep,
}: Omit<ExecuteSwapOptions, 'hooks'>): Promise<PreparedSwapExecution> {
  const user = keypair.publicKey.toBase58()
  let tx: VersionedTransaction
  try {
    tx = VersionedTransaction.deserialize(base64ToBytes(built.transaction))
  } catch {
    throw new SwapExecutionError('guard', '스왑 트랜잭션을 읽지 못했습니다. 다시 시도해 주세요.')
  }

  onStep?.('guard')
  const lastValidBlockHeight = built.lastValidBlockHeight
  if (typeof lastValidBlockHeight !== 'number' || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 0) {
    throw new SwapExecutionError(
      'guard',
      '스왑 트랜잭션의 실제 만료 높이를 확인할 수 없어 서명하지 않았습니다.',
    )
  }
  const keys = await resolveLookupKeys(connection, tx)
  const guardReport = assertSwapTransaction(tx, user, keys)

  onStep?.('simulate')
  const snapshot = await simulateAndCapture(connection, tx, keys, guardReport.programs)
  const simulation = toSwapSimulation(snapshot, keys, user) as SwapSimulationLike
  assertSwapSimulation(simulation, {
    owner: user,
    inputMint: quote.inputMint,
    inAmount: quote.inAmount,
    outputMint: quote.outputMint,
    minOut: quote.otherAmountThreshold,
  })
  const preview = buildTransactionPreview(snapshot, user, user, [user])
  const currentHeight = await withTimeout(
    connection.getBlockHeight('confirmed'),
    RPC_TIMEOUT_MS,
    '스왑 블록 높이를 확인하지 못했습니다. 서명하지 않았습니다.',
  )
  if (currentHeight > lastValidBlockHeight) {
    throw new SwapExecutionError('simulate', '시뮬레이션 중 스왑 블록해시가 만료됐습니다. 새 견적부터 다시 확인하세요.')
  }

  return {
    transaction: tx,
    messageBytes: captureMessageBytes(tx),
    preview,
    owner: user,
    quoteIdentity: quoteIdentity(quote),
    lastValidBlockHeight,
    createdAt: Date.now(),
  }
}

export async function signPreparedSwap({
  connection,
  keypair,
  prepared,
  quote,
  hooks,
  onStep,
}: {
  connection: Connection
  keypair: Keypair
  prepared: PreparedSwapExecution
  quote: SwapQuote
  hooks?: TransactionHooks
  onStep?: (step: SwapStep) => void
}): Promise<string> {
  const user = keypair.publicKey.toBase58()
  if (prepared.owner !== user || prepared.quoteIdentity !== quoteIdentity(quote)) {
    throw new SwapExecutionError('guard', '미리보기 당시 지갑 또는 견적이 변경됐습니다. 다시 시뮬레이션해 주세요.')
  }
  if (Date.now() - prepared.createdAt > PREVIEW_TTL_MS) {
    throw new SwapExecutionError('guard', '스왑 미리보기가 만료됐습니다. 새 시뮬레이션을 확인해 주세요.')
  }
  const currentHeight = await withTimeout(
    connection.getBlockHeight('confirmed'),
    RPC_TIMEOUT_MS,
    '스왑 블록 높이를 확인하지 못했습니다. 서명하지 않았습니다.',
  )
  if (currentHeight > prepared.lastValidBlockHeight) {
    throw new SwapExecutionError('guard', '스왑 미리보기 블록해시가 만료됐습니다. 새 견적부터 다시 확인하세요.')
  }

  assertMessageMatches(prepared.transaction, prepared.messageBytes)
  onStep?.('sign')
  prepared.transaction.sign([keypair])
  assertMessageMatches(prepared.transaction, prepared.messageBytes)
  const signatureBytes = prepared.transaction.signatures[0]
  const localSignature = signatureBytes ? bs58.encode(signatureBytes) : ''
  if (!localSignature) throw new SwapExecutionError('sign', '서명을 만들지 못해 스왑을 전송하지 않았습니다.')
  const blockhash = prepared.transaction.message.recentBlockhash
  hooks?.onSigned?.({
    signature: localSignature,
    blockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
  })

  onStep?.('send')
  let rpcSignature: string
  try {
    rpcSignature = await withTimeout(
      connection.sendRawTransaction(prepared.transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      }),
      RPC_TIMEOUT_MS,
      '스왑 RPC 응답이 시간 초과되었습니다.',
    )
  } catch {
    const resolution = await inspectTransaction(connection, localSignature, prepared.lastValidBlockHeight)
    if (resolution === 'confirmed') {
      notifyTerminal(hooks)
      return localSignature
    }
    if (resolution === 'failed') {
      notifyTerminal(hooks)
      throw new TxOutcomeError('failed', localSignature, '스왑 실패가 확인됐습니다. 같은 전송은 재시도하지 않았습니다.')
    }
    if (resolution === 'expired') {
      throw new TxOutcomeError('expired', localSignature, '블록해시는 만료됐지만 과거 포함 여부는 확인되지 않았습니다. 재전송하지 마세요.')
    }
    if (resolution === 'pending') {
      throw new TxOutcomeError('pending', localSignature, '동일한 스왑 서명이 처리 중일 수 있습니다. 새 트랜잭션을 만들지 마세요.')
    }
    throw new TxOutcomeError('unknown', localSignature, '스왑 RPC 응답이 끊겨 결과가 불명확합니다. 같은 서명을 확인하세요.')
  }

  if (rpcSignature !== localSignature) {
    const resolution = await inspectTransaction(connection, localSignature, prepared.lastValidBlockHeight)
    if (resolution === 'confirmed') {
      notifyTerminal(hooks)
      return localSignature
    }
    if (resolution === 'failed') {
      notifyTerminal(hooks)
      throw new TxOutcomeError('failed', localSignature, '스왑 실패가 확인됐습니다. 같은 전송을 다시 보내지 않았습니다.')
    }
    if (resolution === 'expired') {
      throw new TxOutcomeError('expired', localSignature, 'RPC signature 불일치와 블록해시 만료가 확인됐지만 과거 포함 여부는 미확정입니다.')
    }
    if (resolution === 'pending') {
      throw new TxOutcomeError('pending', localSignature, 'RPC signature 불일치가 있어 로컬 서명의 확정을 계속 확인해야 합니다.')
    }
    throw new TxOutcomeError('unknown', localSignature, 'RPC가 로컬 서명과 다른 값을 반환했습니다. 상태 확인 전 재전송하지 마세요.')
  }

  onStep?.('confirm')
  const startedAt = Date.now()
  let lastResolution: 'confirmed' | 'failed' | 'expired' | 'pending' | 'unknown' = 'unknown'
  while (Date.now() - startedAt < CONFIRM_TIMEOUT_MS) {
    const resolution = await inspectTransaction(connection, localSignature, prepared.lastValidBlockHeight)
    lastResolution = resolution
    if (resolution === 'confirmed') {
      notifyTerminal(hooks)
      return localSignature
    }
    if (resolution === 'failed') {
      notifyTerminal(hooks)
      throw new TxOutcomeError('failed', localSignature, '스왑 실패가 확정됐습니다. Solscan에서 같은 서명을 확인하세요.')
    }
    if (resolution === 'expired') {
      throw new TxOutcomeError('expired', localSignature, '블록해시는 만료됐지만 과거 포함 여부는 확인되지 않았습니다. 재전송하지 마세요.')
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS))
  }
  if (lastResolution === 'pending') {
    throw new TxOutcomeError('pending', localSignature, '같은 스왑 서명이 아직 확정되지 않았습니다. 상태 조회를 계속하세요.')
  }
  throw new TxOutcomeError('unknown', localSignature, '스왑 확정 응답이 지연되고 있습니다. 같은 전송을 다시 시작하지 말고 서명을 확인하세요.')
}

/** Compatibility wrapper: prepare and validate, then sign the exact previewed message. */
export async function executeSwap(options: ExecuteSwapOptions): Promise<string> {
  const prepared = await prepareSwap(options)
  return signPreparedSwap({ ...options, prepared })
}
