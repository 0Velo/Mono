import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import bs58 from 'bs58'
import { fromBaseUnits } from './format'

export const BASE_FEE_LAMPORTS = 5000n
export const ATA_RENT_LAMPORTS = 2_039_280n
export const LAMPORTS_PER_SOL = 1_000_000_000n

export interface FeeEstimate {
  feeLamports: bigint
  rentLamports: bigint
  totalLamports: bigint
  createsAta: boolean
}

export interface SignedTransactionAttempt {
  signature: string
  blockhash: string
  lastValidBlockHeight: number
}

export type TransactionResolution = 'confirmed' | 'failed' | 'expired' | 'pending' | 'unknown'

export class TxOutcomeError extends Error {
  outcome: 'failed' | 'expired' | 'pending' | 'unknown'
  signature: string
  constructor(outcome: 'failed' | 'expired' | 'pending' | 'unknown', signature: string, message: string) {
    super(message)
    this.name = 'TxOutcomeError'
    this.outcome = outcome
    this.signature = signature
  }
}

export interface TransactionHooks {
  /** Called after signing and before any bytes are sent to an RPC. */
  onSigned?: (attempt: SignedTransactionAttempt) => void
  /** Called only after the RPC confirms a terminal result or expiry. */
  onTerminal?: () => void
}

export async function resolveTokenProgram(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const info = await withTimeout(
    connection.getAccountInfo(mint),
    STEP_TIMEOUT_MS,
    '토큰 발행 계정을 확인하지 못했습니다. 네트워크를 확인하고 다시 시도하세요.',
  )
  if (!info) throw new Error('토큰 발행 계정을 찾지 못했습니다.')
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID
  throw new Error('지원하지 않는 토큰 프로그램입니다. 안전을 위해 전송을 중단했습니다.')
}

export async function estimateFee(
  connection: Connection,
  kind: 'sol' | 'spl',
  owner: PublicKey,
  mint: string | null,
  recipient: string | null,
): Promise<FeeEstimate> {
  let createsAta = false
  if (kind === 'spl' && mint && recipient) {
    const mintKey = new PublicKey(mint)
    const programId = await resolveTokenProgram(connection, mintKey)
    const ata = getAssociatedTokenAddressSync(mintKey, new PublicKey(recipient), false, programId)
    const info = await withTimeout(
      connection.getAccountInfo(ata),
      STEP_TIMEOUT_MS,
      '받는 토큰 계정 확인이 시간 초과되었습니다. 수수료를 확인하기 전에는 진행할 수 없습니다.',
    )
    createsAta = !info
  }
  const feeLamports = BASE_FEE_LAMPORTS
  const rentLamports = createsAta ? ATA_RENT_LAMPORTS : 0n
  return {
    feeLamports,
    rentLamports,
    totalLamports: feeLamports + rentLamports,
    createsAta,
  }
}

const STEP_TIMEOUT_MS = 20_000
const CONFIRM_TIMEOUT_MS = 90_000
const CONFIRM_POLL_MS = 1_500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Rejects instead of hanging forever when an RPC call never answers. */
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

/** Query the same signed transaction; never create a replacement signature. */
export async function inspectTransaction(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<TransactionResolution> {
  try {
    const response = await withTimeout(
      connection.getSignatureStatuses([signature], { searchTransactionHistory: true }),
      10_000,
      'timeout',
    )
    const status = response.value[0] ?? null
    if (status) {
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return status.err ? 'failed' : 'confirmed'
      }
      return 'pending'
    }
    const height = await withTimeout(connection.getBlockHeight('confirmed'), 10_000, 'timeout')
    // A missing status after expiry proves the blockhash is no longer usable,
    // not that the signature was never included (RPC history can be incomplete).
    return height > lastValidBlockHeight ? 'expired' : 'pending'
  } catch {
    return 'unknown'
  }
}

function notifyTerminal(hooks?: TransactionHooks): void {
  try {
    hooks?.onTerminal?.()
  } catch {
    // A stale local marker can be checked again; it must not hide an RPC result.
  }
}

/** Polls HTTPS signature status, which also works when iOS drops WebSockets. */
async function confirm(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  hooks?: TransactionHooks,
): Promise<void> {
  const startedAt = Date.now()
  let lastResolution: TransactionResolution = 'unknown'
  while (Date.now() - startedAt < CONFIRM_TIMEOUT_MS) {
    const outcome = await inspectTransaction(connection, signature, lastValidBlockHeight)
    lastResolution = outcome
    if (outcome === 'confirmed') {
      notifyTerminal(hooks)
      return
    }
    if (outcome === 'failed') {
      notifyTerminal(hooks)
      throw new TxOutcomeError('failed', signature, '트랜잭션 실패가 확인됐습니다. 같은 서명을 다시 보내지 않았습니다.')
    }
    if (outcome === 'expired') {
      throw new TxOutcomeError('expired', signature, '블록해시는 만료됐지만 조회 기록만으로 미포함을 단정할 수 없습니다. 결과 확인 전 재전송하지 마세요.')
    }
    await sleep(CONFIRM_POLL_MS)
  }
  if (lastResolution === 'pending') {
    throw new TxOutcomeError('pending', signature, '같은 서명이 아직 확정되지 않았습니다. 완료 여부를 계속 확인하세요.')
  }
  throw new TxOutcomeError(
    'unknown',
    signature,
    '전송 결과를 확인하지 못했습니다. 같은 송금을 다시 보내지 말고 이 서명의 상태를 먼저 확인하세요.',
  )
}

async function submit(
  connection: Connection,
  tx: Transaction,
  signer: Keypair,
  hooks?: TransactionHooks,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await withTimeout(
    connection.getLatestBlockhash('confirmed'),
    STEP_TIMEOUT_MS,
    'RPC에서 응답이 없습니다. 네트워크나 RPC 설정을 확인하세요.',
  )
  tx.recentBlockhash = blockhash
  tx.feePayer = signer.publicKey
  tx.sign(signer)
  const localSignature = tx.signature ? bs58.encode(tx.signature) : ''
  if (!localSignature) throw new Error('서명을 만들지 못했습니다. 전송하지 않았습니다.')
  hooks?.onSigned?.({ signature: localSignature, blockhash, lastValidBlockHeight })

  let rpcSignature: string
  try {
    rpcSignature = await withTimeout(
      connection.sendRawTransaction(tx.serialize(), maxRetriesOptions()),
      STEP_TIMEOUT_MS,
      'RPC 응답 시간이 초과되었습니다.',
    )
  } catch {
    const outcome = await inspectTransaction(connection, localSignature, lastValidBlockHeight)
    if (outcome === 'confirmed') {
      notifyTerminal(hooks)
      return localSignature
    }
    if (outcome === 'failed') {
      notifyTerminal(hooks)
      throw new TxOutcomeError('failed', localSignature, 'RPC 응답은 끊겼지만 실패 상태가 확인됐습니다.')
    }
    if (outcome === 'expired') {
      throw new TxOutcomeError('expired', localSignature, 'RPC 응답이 끊겼고 블록해시가 만료됐지만 과거 포함 여부는 확인되지 않았습니다. 재전송하지 마세요.')
    }
    if (outcome === 'pending') {
      throw new TxOutcomeError('pending', localSignature, 'RPC 응답은 지연됐지만 동일 서명이 처리 중일 수 있습니다. 새 서명을 만들지 마세요.')
    }
    throw new TxOutcomeError(
      'unknown',
      localSignature,
      'RPC 응답이 끊겨 전송 결과가 불명확합니다. 같은 전송을 다시 시도하지 말고 동일 서명을 확인하세요.',
    )
  }

  if (rpcSignature !== localSignature) {
    const outcome = await inspectTransaction(connection, localSignature, lastValidBlockHeight)
    if (outcome === 'confirmed') {
      notifyTerminal(hooks)
      return localSignature
    }
    if (outcome === 'failed') {
      notifyTerminal(hooks)
      throw new TxOutcomeError('failed', localSignature, 'RPC signature 불일치가 있었지만 로컬 서명의 실패가 확인됐습니다.')
    }
    if (outcome === 'expired') {
      throw new TxOutcomeError('expired', localSignature, 'RPC signature 불일치가 있었고 블록해시는 만료됐지만 과거 포함 여부는 미확정입니다.')
    }
    if (outcome === 'pending') {
      throw new TxOutcomeError('pending', localSignature, 'RPC signature 불일치가 있어 로컬 서명의 확정을 계속 확인해야 합니다.')
    }
    throw new TxOutcomeError('unknown', localSignature, 'RPC가 로컬 서명과 다른 서명을 반환했습니다. 상태 확인 전 재전송하지 마세요.')
  }

  await confirm(connection, localSignature, lastValidBlockHeight, hooks)
  return localSignature
}

function maxRetriesOptions() {
  return { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' as const }
}

export async function sendSol(
  connection: Connection,
  signer: Keypair,
  recipient: string,
  lamports: bigint,
  hooks?: TransactionHooks,
): Promise<string> {
  if (lamports <= 0n) throw new Error('보낼 수량을 입력하세요.')
  const to = new PublicKey(recipient)
  if (to.equals(signer.publicKey)) throw new Error('본인 주소로는 보낼 수 없습니다.')
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: to,
      lamports,
    }),
  )
  return submit(connection, tx, signer, hooks)
}

export async function sendSplToken(
  connection: Connection,
  signer: Keypair,
  mintAddress: string,
  recipient: string,
  amount: bigint,
  decimals: number,
  hooks?: TransactionHooks,
): Promise<string> {
  if (amount <= 0n) throw new Error('보낼 수량을 입력하세요.')
  const mint = new PublicKey(mintAddress)
  const to = new PublicKey(recipient)
  if (to.equals(signer.publicKey)) throw new Error('본인 주소로는 보낼 수 없습니다.')
  const programId = await resolveTokenProgram(connection, mint)
  const sourceAta = getAssociatedTokenAddressSync(mint, signer.publicKey, false, programId)
  const destinationAta = getAssociatedTokenAddressSync(mint, to, false, programId)

  const tx = new Transaction()
  const destinationInfo = await withTimeout(
    connection.getAccountInfo(destinationAta),
    STEP_TIMEOUT_MS,
    '받는 토큰 계정을 확인하지 못했습니다. 네트워크를 확인하고 다시 시도하세요.',
  )
  if (!destinationInfo) {
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        destinationAta,
        to,
        mint,
        programId,
      ),
    )
  }
  tx.add(
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      destinationAta,
      signer.publicKey,
      amount,
      decimals,
      [],
      programId,
    ),
  )
  return submit(connection, tx, signer, hooks)
}

export async function maxTransferableSol(
  connection: Connection,
  owner: PublicKey,
): Promise<bigint> {
  const balance = BigInt(await withTimeout(
    connection.getBalance(owner),
    STEP_TIMEOUT_MS,
    'SOL 잔액 조회가 시간 초과되었습니다.',
  ))
  const fee = BASE_FEE_LAMPORTS
  return balance > fee ? balance - fee : 0n
}

export type SendAffordabilityReason = 'ok' | 'amount' | 'insufficient-asset' | 'insufficient-fee'

export interface SendAffordabilityInput {
  kind: 'sol' | 'spl'
  /** Base units of the asset being sent. */
  amount: bigint
  /** Balance of that asset in base units. */
  balance: bigint
  /** SOL balance in lamports (pays the fee and any new token account). */
  solBalance: bigint
  feeLamports: bigint
  rentLamports: bigint
}

/**
 * Whether a send can actually be paid for.
 *
 * Sending a whole SPL balance is not enough to know a send will succeed: the
 * network fee — and the ~0.00204 SOL rent when the recipient has no token
 * account yet — comes out of the SOL balance, which the token balance says
 * nothing about. Checking both before enabling the button is what stops a
 * "보내기" that can only fail at the RPC.
 */
export function assessSend(input: SendAffordabilityInput): {
  ok: boolean
  reason: SendAffordabilityReason
  shortfallLamports: bigint
} {
  if (input.amount <= 0n) return { ok: false, reason: 'amount', shortfallLamports: 0n }
  if (input.amount > input.balance) {
    return { ok: false, reason: 'insufficient-asset', shortfallLamports: 0n }
  }
  const reserve = input.feeLamports + input.rentLamports
  if (input.kind === 'sol') {
    const needed = input.amount + reserve
    if (needed > input.solBalance) {
      return { ok: false, reason: 'insufficient-fee', shortfallLamports: needed - input.solBalance }
    }
    return { ok: true, reason: 'ok', shortfallLamports: 0n }
  }
  if (reserve > input.solBalance) {
    return { ok: false, reason: 'insufficient-fee', shortfallLamports: reserve - input.solBalance }
  }
  return { ok: true, reason: 'ok', shortfallLamports: 0n }
}

export interface TokenDelta {
  mint: string
  amount: string
  decimals: number
  uiAmount: number
}

export interface HistoryItem {
  signature: string
  slot: number
  blockTime: number | null
  failed: boolean
  detailed: boolean
  solDelta: number
  tokenDeltas: TokenDelta[]
  memo?: string
}

function keyToAddress(key: any): string {
  if (!key) return ''
  if (typeof key === 'string') return key
  if (typeof key.toBase58 === 'function') return key.toBase58()
  if (typeof key.pubkey === 'string') return key.pubkey
  if (typeof key.pubkey?.toBase58 === 'function') return key.pubkey.toBase58()
  return ''
}

/**
 * Signatures come first, then details for the newest few. The public RPC
 * rate-limits parallel getTransaction calls, so details are fetched in small
 * sequential pairs and any failure simply leaves the row un-detailed.
 */
export async function fetchHistory(
  connection: Connection,
  ownerAddress: string,
  limit = 20,
): Promise<HistoryItem[]> {
  const signatures = await connection.getSignaturesForAddress(new PublicKey(ownerAddress), { limit })
  if (signatures.length === 0) return []

  const items: HistoryItem[] = signatures.map((entry) => ({
    signature: entry.signature,
    slot: entry.slot,
    blockTime: entry.blockTime ?? null,
    failed: Boolean(entry.err),
    detailed: false,
    solDelta: 0,
    tokenDeltas: [],
    memo: entry.memo ?? undefined,
  }))

  const detailLimit = Math.min(items.length, 10)
  for (let index = 0; index < detailLimit; index += 1) {
    const item = items[index]
    try {
      const tx: any = await connection.getParsedTransaction(item.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      })
      if (!tx?.meta) continue
      applyTransaction(item, tx, ownerAddress)
      item.detailed = true
    } catch {
      /* leave the row without detail */
    }
    await new Promise((resolve) => setTimeout(resolve, 90))
  }

  return items
}

function applyTransaction(item: HistoryItem, tx: any, ownerAddress: string): void {
  const message: any = tx.transaction?.message
  const keys: string[] = (message?.accountKeys ?? []).map(keyToAddress)
  const ownerIndex = keys.indexOf(ownerAddress)

  if (ownerIndex >= 0) {
    const pre = tx.meta.preBalances?.[ownerIndex] ?? 0
    const post = tx.meta.postBalances?.[ownerIndex] ?? 0
    item.solDelta = post - pre
  }

  const preBalances = new Map<string, bigint>()
  for (const balance of tx.meta.preTokenBalances ?? []) {
    if (balance?.owner !== ownerAddress) continue
    preBalances.set(
      `${balance.mint}:${balance.accountIndex}`,
      BigInt(balance?.uiTokenAmount?.amount ?? '0'),
    )
  }

  const deltas: TokenDelta[] = []
  for (const balance of tx.meta.postTokenBalances ?? []) {
    if (balance?.owner !== ownerAddress) continue
    const key = `${balance.mint}:${balance.accountIndex}`
    const post = BigInt(balance?.uiTokenAmount?.amount ?? '0')
    const pre = preBalances.get(key) ?? 0n
    const delta = post - pre
    if (delta === 0n) continue
    const decimals = balance?.uiTokenAmount?.decimals ?? 0
    deltas.push({
      mint: balance.mint,
      amount: delta.toString(),
      decimals,
      uiAmount: Number(fromBaseUnits(delta < 0n ? -delta : delta, decimals)),
    })
  }
  item.tokenDeltas = deltas
}
