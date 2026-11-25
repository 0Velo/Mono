import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
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
import { MEMO_PROGRAM_ID, sanitizeMemo } from './solanaPay'
import {
  PREVIEW_TTL_MS,
  assertMessageMatches,
  buildTransactionPreview,
  captureMessageBytes,
  simulateAndCapture,
  type TransactionPreview,
} from './transactionPreview'

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
  /**
   * Called the moment the RPC has accepted the signed bytes. From here the
   * transfer can land even if confirmation is slow, so the UI must stop
   * showing a "sending" spinner and switch to an explicit tracking state.
   */
  onSubmitted?: (attempt: SignedTransactionAttempt) => void
  /** Called only after the RPC confirms a terminal result or expiry. */
  onTerminal?: () => void
}

export async function resolveTokenProgram(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const info = await withTimeout(
    connection.getAccountInfo(mint),
    TX_TIMEOUTS.stepMs,
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
      TX_TIMEOUTS.stepMs,
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

/**
 * Every network step is bounded. A phone that loses its socket, an RPC that
 * accepts the connection and never answers, or a Devnet validator that stops
 * producing blocks must all end in a visible state instead of a spinner that
 * never stops. Mutable so the test suite can prove each deadline in milliseconds.
 */
export const TX_TIMEOUTS = {
  /** One RPC request: blockhash, height, simulate, broadcast. */
  stepMs: 12_000,
  /** One status/height read inside the confirmation loop. */
  statusMs: 8_000,
  /** Total confirmation polling window before the outcome is reported. */
  confirmMs: 30_000,
  /** Gap between status polls. */
  pollMs: 1_200,
}

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
      TX_TIMEOUTS.statusMs,
      'timeout',
    )
    const status = response.value[0] ?? null
    if (status) {
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return status.err ? 'failed' : 'confirmed'
      }
      return 'pending'
    }
    const height = await withTimeout(
      connection.getBlockHeight('confirmed'),
      TX_TIMEOUTS.statusMs,
      'timeout',
    )
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

function notifySubmitted(hooks: TransactionHooks | undefined, attempt: SignedTransactionAttempt): void {
  try {
    hooks?.onSubmitted?.(attempt)
  } catch {
    // The bytes are already with the RPC; a UI callback must not change the outcome.
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
  while (Date.now() - startedAt < TX_TIMEOUTS.confirmMs) {
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
    await sleep(TX_TIMEOUTS.pollMs)
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

export interface PreparedSend {
  transaction: VersionedTransaction
  messageBytes: Uint8Array
  preview: TransactionPreview
  owner: string
  recipient: string
  kind: 'sol' | 'spl'
  mint: string | null
  amount: bigint
  decimals: number
  memo: string | null
  blockhash: string
  lastValidBlockHeight: number
  rentLamports: bigint
  createsAta: boolean
  createdAt: number
}

/**
 * A Solana Pay memo travels as one account-less instruction of the Memo
 * program: it writes text next to the transfer, moves no funds and adds no
 * signer, so the simulated lamport/token deltas stay exactly the transfer's.
 */
export function buildMemoInstruction(memo: string | null): TransactionInstruction | null {
  const text = sanitizeMemo(memo)
  if (!text) return null
  return new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: [],
    data: Buffer.from(text, 'utf8'),
  })
}

async function prepareSendMessage(
  connection: Connection,
  signer: Keypair,
  recipient: PublicKey,
  kind: 'sol' | 'spl',
  amount: bigint,
  decimals: number,
  mint: PublicKey | null,
  instructions: TransactionInstruction[],
  addresses: PublicKey[],
  createsAta: boolean,
  memo: string | null = null,
): Promise<PreparedSend> {
  const blockhashResponse = await withTimeout(
    connection.getLatestBlockhash('confirmed'),
    TX_TIMEOUTS.stepMs,
    'RPC에서 응답이 없습니다. 네트워크나 RPC 설정을 확인하세요.',
  )
  const { blockhash, lastValidBlockHeight } = blockhashResponse
  if (!blockhash || !Number.isSafeInteger(lastValidBlockHeight)) {
    throw new Error('유효한 블록해시를 받지 못해 서명하지 않았습니다.')
  }
  const memoText = sanitizeMemo(memo)
  const memoIx = buildMemoInstruction(memoText || null)
  const allInstructions = memoIx ? [...instructions, memoIx] : instructions
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: allInstructions,
    }).compileToV0Message(),
  )
  const programs = Array.from(new Set(allInstructions.map((instruction) => instruction.programId.toBase58())))
  const snapshot = await simulateAndCapture(connection, transaction, addresses, programs)
  const owner = signer.publicKey.toBase58()
  const recipientAddress = recipient.toBase58()
  const preview = buildTransactionPreview(
    snapshot,
    owner,
    recipientAddress,
    [owner, recipientAddress],
    mint ? { [mint.toBase58()]: decimals } : {},
  )
  const ownerSol = preview.nativeChanges.find((change) => change.address === owner)
  if (!ownerSol) throw new Error('지갑 SOL 잔액 변화가 미리보기에 없습니다. 서명하지 않았습니다.')
  let rentLamports = 0n
  if (kind === 'sol') {
    const recipientSol = preview.nativeChanges.find((change) => change.address === recipientAddress)
    if (!recipientSol || BigInt(recipientSol.deltaLamports) !== amount) {
      throw new Error('시뮬레이션에서 받는 SOL 금액이 요청과 다릅니다. 서명하지 않았습니다.')
    }
    if (BigInt(ownerSol.deltaLamports) !== -(amount + BigInt(snapshot.feeLamports))) {
      throw new Error('시뮬레이션에서 지갑의 SOL 차감액이 예상과 다릅니다. 서명하지 않았습니다.')
    }
  } else if (mint) {
    const sourceDelta = preview.tokenChanges.find(
      (change) => change.owner === owner && change.mint === mint.toBase58(),
    )
    const recipientDelta = preview.tokenChanges.find(
      (change) => change.owner === recipientAddress && change.mint === mint.toBase58(),
    )
    if (!sourceDelta || BigInt(sourceDelta.deltaAmount) !== -amount) {
      throw new Error('시뮬레이션에서 보낼 토큰 수량이 요청과 다릅니다. 서명하지 않았습니다.')
    }
    if (!recipientDelta || BigInt(recipientDelta.deltaAmount) <= 0n || BigInt(recipientDelta.deltaAmount) > amount) {
      throw new Error('시뮬레이션에서 받는 토큰 수량을 안전하게 확인하지 못했습니다. 서명하지 않았습니다.')
    }
    const destinationAta = addresses[2]
    if (createsAta && destinationAta) {
      const account = snapshot.accounts.find((entry) => entry.address === destinationAta.toBase58())
      if (!account?.before && account?.after) rentLamports = BigInt(account.after.lamports)
    }
    if (BigInt(ownerSol.deltaLamports) !== -(BigInt(snapshot.feeLamports) + rentLamports)) {
      throw new Error('시뮬레이션에서 SOL 수수료·계정 생성 비용이 예상과 다릅니다. 서명하지 않았습니다.')
    }
  }

  return {
    transaction,
    messageBytes: captureMessageBytes(transaction),
    preview,
    owner,
    recipient: recipientAddress,
    kind,
    mint: mint?.toBase58() ?? null,
    amount,
    decimals,
    memo: memoText || null,
    blockhash,
    lastValidBlockHeight,
    rentLamports,
    createsAta,
    createdAt: Date.now(),
  }
}

export async function prepareSolSend(
  connection: Connection,
  signer: Keypair,
  recipient: string,
  lamports: bigint,
  memo: string | null = null,
): Promise<PreparedSend> {
  if (lamports <= 0n) throw new Error('보낼 수량을 입력하세요.')
  const to = new PublicKey(recipient)
  if (to.equals(signer.publicKey)) throw new Error('본인 주소로는 보낼 수 없습니다.')
  const instruction = SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: to, lamports })
  return prepareSendMessage(
    connection,
    signer,
    to,
    'sol',
    lamports,
    9,
    null,
    [instruction],
    [signer.publicKey, to],
    false,
    memo,
  )
}

export async function prepareSplSend(
  connection: Connection,
  signer: Keypair,
  mintAddress: string,
  recipient: string,
  amount: bigint,
  decimals: number,
  memo: string | null = null,
): Promise<PreparedSend> {
  if (amount <= 0n) throw new Error('보낼 수량을 입력하세요.')
  const mint = new PublicKey(mintAddress)
  const to = new PublicKey(recipient)
  if (to.equals(signer.publicKey)) throw new Error('본인 주소로는 보낼 수 없습니다.')
  const programId = await resolveTokenProgram(connection, mint)
  const sourceAta = getAssociatedTokenAddressSync(mint, signer.publicKey, false, programId)
  const destinationAta = getAssociatedTokenAddressSync(mint, to, false, programId)
  const instructions: TransactionInstruction[] = []
  const destinationInfo = await withTimeout(
    connection.getAccountInfo(destinationAta),
    TX_TIMEOUTS.stepMs,
    '받는 토큰 계정을 확인하지 못했습니다. 네트워크를 확인하세요.',
  )
  const createsAta = !destinationInfo
  if (createsAta) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        destinationAta,
        to,
        mint,
        programId,
      ),
    )
  }
  instructions.push(
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
  return prepareSendMessage(
    connection,
    signer,
    to,
    'spl',
    amount,
    decimals,
    mint,
    instructions,
    [signer.publicKey, sourceAta, destinationAta],
    createsAta,
    memo,
  )
}

async function submitPrepared(
  connection: Connection,
  prepared: PreparedSend,
  signer: Keypair,
  hooks?: TransactionHooks,
): Promise<string> {
  if (prepared.owner !== signer.publicKey.toBase58()) {
    throw new Error('미리보기 당시 지갑과 현재 지갑이 다릅니다. 다시 시뮬레이션해 주세요.')
  }
  if (Date.now() - prepared.createdAt > PREVIEW_TTL_MS) {
    throw new Error('미리보기가 오래되어 만료됐습니다. 다시 시뮬레이션해 주세요.')
  }
  const currentHeight = await withTimeout(
    connection.getBlockHeight('confirmed'),
    TX_TIMEOUTS.stepMs,
    '블록 높이를 확인하지 못했습니다. 서명하지 않았습니다.',
  )
  if (currentHeight > prepared.lastValidBlockHeight) {
    throw new Error('미리보기 블록해시가 만료됐습니다. 새 시뮬레이션을 확인해 주세요.')
  }
  assertMessageMatches(prepared.transaction, prepared.messageBytes)
  prepared.transaction.sign([signer])
  assertMessageMatches(prepared.transaction, prepared.messageBytes)
  const signatureBytes = prepared.transaction.signatures[0]
  const localSignature = signatureBytes ? bs58.encode(signatureBytes) : ''
  if (!localSignature) throw new Error('서명을 만들지 못했습니다. 전송하지 않았습니다.')
  hooks?.onSigned?.({
    signature: localSignature,
    blockhash: prepared.blockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
  })

  let rpcSignature: string
  try {
    rpcSignature = await withTimeout(
      connection.sendRawTransaction(prepared.transaction.serialize(), maxRetriesOptions()),
      TX_TIMEOUTS.stepMs,
      'RPC 응답 시간이 초과되었습니다.',
    )
  } catch {
    const outcome = await inspectTransaction(connection, localSignature, prepared.lastValidBlockHeight)
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

  notifySubmitted(hooks, {
    signature: localSignature,
    blockhash: prepared.blockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
  })

  if (rpcSignature !== localSignature) {
    const outcome = await inspectTransaction(connection, localSignature, prepared.lastValidBlockHeight)
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

  await confirm(connection, localSignature, prepared.lastValidBlockHeight, hooks)
  return localSignature
}

export async function signPreparedSend(
  connection: Connection,
  prepared: PreparedSend,
  signer: Keypair,
  hooks?: TransactionHooks,
): Promise<string> {
  return submitPrepared(connection, prepared, signer, hooks)
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
  const prepared = await prepareSolSend(connection, signer, recipient, lamports)
  return submitPrepared(connection, prepared, signer, hooks)
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
  const prepared = await prepareSplSend(connection, signer, mintAddress, recipient, amount, decimals)
  return submitPrepared(connection, prepared, signer, hooks)
}

export async function maxTransferableSol(
  connection: Connection,
  owner: PublicKey,
): Promise<bigint> {
  const balance = BigInt(await withTimeout(
    connection.getBalance(owner),
    TX_TIMEOUTS.stepMs,
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
  /** Network fee in lamports, so an outgoing SOL amount can exclude it. */
  feeLamports?: number
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
  watchedAddresses: string[] = [],
): Promise<HistoryItem[]> {
  const addresses = Array.from(new Set([ownerAddress, ...watchedAddresses].filter(Boolean)))
  const signaturesByAddress = new Map<string, Awaited<ReturnType<Connection['getSignaturesForAddress']>>[number]>()
  let ownerQueryError: unknown = null

  // Public RPCs rate-limit bursts, so query monitored token accounts in small batches.
  for (let offset = 0; offset < addresses.length; offset += 4) {
    const batch = addresses.slice(offset, offset + 4)
    await Promise.all(batch.map(async (address) => {
      try {
        const entries = await connection.getSignaturesForAddress(new PublicKey(address), { limit })
        for (const entry of entries) {
          const current = signaturesByAddress.get(entry.signature)
          if (!current || entry.slot > current.slot) signaturesByAddress.set(entry.signature, entry)
        }
      } catch (error) {
        if (address === ownerAddress) ownerQueryError = error
      }
    }))
  }

  if (signaturesByAddress.size === 0 && ownerQueryError) throw ownerQueryError
  const signatures = Array.from(signaturesByAddress.values())
    .sort((a, b) => b.slot - a.slot)
    .slice(0, limit)
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
    if (Number.isSafeInteger(tx.meta.fee) && tx.meta.fee >= 0) item.feeLamports = tx.meta.fee
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
