/**
 * Empty token-account cleanup — the SOL rent that a wallet loses track of.
 *
 * Every SPL token account a wallet has ever touched holds ~0.00204 SOL of rent
 * deposit. When the token balance is zero that account is dead weight, and the
 * deposit only comes back when the account itself is closed. This finds those
 * accounts, closes them in one signed transaction (chunked so the message stays
 * inside the size limit), and returns the rent to the wallet.
 *
 * Safety rules, all enforced before anything is signed:
 *  - only accounts the wallet owns, with a zero balance and not frozen;
 *  - an account whose close authority belongs to someone else is left alone;
 *  - the exact transaction is simulated first, and the simulation must show the
 *    wallet's lamports rising by the closed accounts' rent minus the fee, and
 *    every target account gone. If any of that differs, nothing is signed.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  unpackAccount,
} from '@solana/spl-token'
import { simulateAndCapture } from './transactionPreview'
import { BASE_FEE_LAMPORTS, TX_TIMEOUTS, inspectTransaction } from './tx'

/** Rent-exempt reserve of a token account (~0.00203928 SOL). */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n

/** Accounts per transaction: the message must stay under the 1232-byte limit. */
export const MAX_CLOSE_PER_TRANSACTION = 8

export interface EmptyTokenAccount {
  address: string
  mint: string
  programId: string
  lamports: bigint
}

export interface ClosableTokenAccountInput {
  amount: bigint
  state?: string
  closeAuthority?: string | null
  owner: string
}

/**
 * Whether this wallet may close the account. A frozen account is excluded even
 * when empty: the freeze authority still controls it, and closing it would hide
 * a state the owner did not set.
 */
export function isClosableTokenAccount(input: ClosableTokenAccountInput): boolean {
  if (input.amount !== 0n) return false
  if (input.state === 'frozen') return false
  if (input.closeAuthority && input.closeAuthority !== input.owner) return false
  return true
}

/** Deterministic order (largest rent first) so the summary is stable. */
export function sortByRent(accounts: EmptyTokenAccount[]): EmptyTokenAccount[] {
  return [...accounts].sort((left, right) => {
    if (left.lamports === right.lamports) return left.address.localeCompare(right.address)
    return left.lamports > right.lamports ? -1 : 1
  })
}

export function sumLamports(accounts: readonly EmptyTokenAccount[]): bigint {
  return accounts.reduce((total, account) => total + account.lamports, 0n)
}

export function chunkTargets<T>(items: readonly T[], size = MAX_CLOSE_PER_TRANSACTION): T[][] {
  if (size < 1) return []
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

/**
 * Close instructions for one chunk. Every rent deposit goes to the wallet that
 * owns the accounts, never to a third party.
 */
export function buildCloseInstructions(
  targets: readonly EmptyTokenAccount[],
  owner: PublicKey,
): TransactionInstruction[] {
  return targets.map((target) =>
    createCloseAccountInstruction(
      new PublicKey(target.address),
      owner,
      owner,
      [],
      new PublicKey(target.programId),
    ),
  )
}

/**
 * Live lookup of empty, unfrozen token accounts (SPL Token and Token-2022).
 * A failed program query is not treated as "no accounts": the caller shows the
 * row only when the lookup actually answered.
 */
export async function findEmptyTokenAccounts(
  connection: Connection,
  ownerAddress: string,
): Promise<EmptyTokenAccount[]> {
  const owner = new PublicKey(ownerAddress)
  const found: EmptyTokenAccount[] = []
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const response = await connection.getParsedTokenAccountsByOwner(owner, { programId })
    for (const item of response.value) {
      const data = item.account.data
      if (!('parsed' in data)) continue
      const info = data.parsed?.info
      if (!info?.mint || !info.tokenAmount) continue
      const amount = BigInt(info.tokenAmount.amount ?? '0')
      const state = typeof info.state === 'string' ? info.state : undefined
      const closeAuthority = typeof info.closeAuthority === 'string' ? info.closeAuthority : null
      if (!isClosableTokenAccount({ amount, state, closeAuthority, owner: ownerAddress })) continue
      found.push({
        address: item.pubkey.toBase58(),
        mint: info.mint,
        programId: programId.toBase58(),
        lamports: BigInt(item.account.lamports),
      })
    }
  }
  return sortByRent(found)
}

export interface CloseEmptyAccountsResult {
  signature: string
  reclaimedLamports: bigint
  closed: number
}

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

async function confirmClose(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < TX_TIMEOUTS.confirmMs) {
    const outcome = await inspectTransaction(connection, signature, lastValidBlockHeight)
    if (outcome === 'confirmed') return
    if (outcome === 'failed') {
      throw new Error('빈 계정 정리 트랜잭션이 실패했습니다. 계정은 그대로 남아 있습니다.')
    }
    if (outcome === 'expired') {
      throw new Error('블록해시가 만료됐습니다. 정리 결과를 활동 내역에서 확인해 주세요.')
    }
    await new Promise((resolve) => setTimeout(resolve, TX_TIMEOUTS.pollMs))
  }
  throw new Error('정리 결과 확인이 지연되고 있습니다. 잠시 후 활동 내역에서 확인해 주세요.')
}

/**
 * Closes the given empty accounts and returns the SOL that came back.
 * The caller must already have the wallet unlocked: the keypair signs here.
 */
export async function closeEmptyTokenAccounts(
  connection: Connection,
  signer: Keypair,
  targets: readonly EmptyTokenAccount[],
): Promise<CloseEmptyAccountsResult> {
  if (targets.length === 0) throw new Error('닫을 빈 토큰 계정이 없습니다.')
  const owner = signer.publicKey
  const ownerAddress = owner.toBase58()
  let reclaimedLamports = 0n
  let closed = 0
  let signature = ''

  for (const chunk of chunkTargets(targets)) {
    const instructions = buildCloseInstructions(chunk, owner)
    const { blockhash, lastValidBlockHeight } = await withTimeout(
      connection.getLatestBlockhash('confirmed'),
      TX_TIMEOUTS.stepMs,
      '블록해시를 받지 못했습니다. 서명하지 않았습니다.',
    )
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message(),
    )
    const programs = Array.from(new Set(chunk.map((target) => target.programId)))
    const snapshot = await simulateAndCapture(
      connection,
      transaction,
      [owner, ...chunk.map((target) => new PublicKey(target.address))],
      programs,
    )

    const ownerState = snapshot.accounts.find((account) => account.address === ownerAddress)
    if (!ownerState?.before) {
      throw new Error('지갑 계정 상태를 확인하지 못했습니다. 서명하지 않았습니다.')
    }
    const expectedGain = sumLamports(chunk) - BigInt(snapshot.feeLamports)
    const actualGain = BigInt((ownerState.after?.lamports ?? 0) - ownerState.before.lamports)
    if (actualGain !== expectedGain) {
      throw new Error('시뮬레이션에서 회수 금액이 예상과 다릅니다. 서명하지 않았습니다.')
    }
    for (const target of chunk) {
      const state = snapshot.accounts.find((account) => account.address === target.address)
      if (!state?.before) {
        throw new Error('빈 토큰 계정 상태를 확인하지 못했습니다. 서명하지 않았습니다.')
      }
      const decoded = unpackAccount(new PublicKey(target.address), state.before, new PublicKey(target.programId))
      if (decoded.amount !== 0n) {
        throw new Error('잔액이 생긴 토큰 계정이 있어 정리를 중단했습니다. 서명하지 않았습니다.')
      }
      if (decoded.isFrozen) {
        throw new Error('동결된 토큰 계정이 있어 정리를 중단했습니다. 서명하지 않았습니다.')
      }
      if (decoded.closeAuthority && !decoded.closeAuthority.equals(owner)) {
        throw new Error('다른 지갑이 닫을 수 있는 계정이 있어 정리를 중단했습니다. 서명하지 않았습니다.')
      }
      if (state.after) {
        throw new Error('시뮬레이션에서 닫히지 않은 계정이 있습니다. 서명하지 않았습니다.')
      }
    }
    if (!ownerState.after) throw new Error('시뮬레이션 결과를 확인하지 못했습니다. 서명하지 않았습니다.')
    if (BigInt(ownerState.after.lamports) <= 0n) {
      throw new Error('시뮬레이션 잔액이 올바르지 않습니다. 서명하지 않았습니다.')
    }

    transaction.sign([signer])
    signature = await withTimeout(
      connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      }),
      TX_TIMEOUTS.stepMs,
      'RPC 응답 시간이 초과됐습니다. 정리 결과를 활동 내역에서 확인해 주세요.',
    )
    await confirmClose(connection, signature, lastValidBlockHeight)
    reclaimedLamports += expectedGain
    closed += chunk.length
  }

  return { signature, reclaimedLamports, closed }
}

/** Message fee for a close transaction with one signer. */
export function closeTransactionFee(): bigint {
  return BASE_FEE_LAMPORTS
}
