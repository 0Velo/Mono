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

export async function resolveTokenProgram(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  try {
    const info = await connection.getAccountInfo(mint)
    if (info?.owner?.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
  } catch {
    /* default to the classic token program */
  }
  return TOKEN_PROGRAM_ID
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
    try {
      const mintKey = new PublicKey(mint)
      const programId = await resolveTokenProgram(connection, mintKey)
      const ata = getAssociatedTokenAddressSync(mintKey, new PublicKey(recipient), false, programId)
      const info = await connection.getAccountInfo(ata)
      createsAta = !info
    } catch {
      createsAta = false
    }
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

/**
 * Confirms by polling getSignatureStatuses over plain HTTPS instead of
 * connection.confirmTransaction(), which waits on a WebSocket subscription.
 * The page CSP allows `https:` but not `wss:`, and iOS home-screen apps drop
 * sockets easily, so that wait could hang with the spinner on screen.
 */
async function confirm(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < CONFIRM_TIMEOUT_MS) {
    // Height first, status second: if the blockhash has expired AND the status
    // is still empty afterwards, the transaction can never land.
    let expired = false
    try {
      const height = await withTimeout(connection.getBlockHeight('confirmed'), 10_000, 'timeout')
      expired = height > lastValidBlockHeight
    } catch {
      /* transient RPC error: keep polling until the deadline */
    }

    let status: { err: unknown; confirmationStatus?: string } | null = null
    try {
      const res = await withTimeout(connection.getSignatureStatuses([signature]), 10_000, 'timeout')
      status = res.value[0] ?? null
    } catch {
      /* transient RPC error: keep polling until the deadline */
    }

    if (status) {
      if (status.err) {
        throw new Error('트랜잭션이 실패했습니다. Solscan에서 상태를 확인하세요.')
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return
      }
    } else if (expired) {
      throw new Error('트랜잭션이 만료되어 처리되지 않았습니다. 잠시 후 다시 시도하세요.')
    }

    await sleep(CONFIRM_POLL_MS)
  }
  throw new Error(
    `전송은 되었을 수 있지만 확인이 지연되고 있습니다. 같은 송금을 다시 누르지 말고 활동 탭이나 Solscan에서 먼저 확인하세요. (${signature.slice(0, 8)}…)`,
  )
}

async function submit(connection: Connection, tx: Transaction, signer: Keypair): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await withTimeout(
    connection.getLatestBlockhash('confirmed'),
    STEP_TIMEOUT_MS,
    'RPC에서 응답이 없습니다. 네트워크나 RPC 설정을 확인하세요.',
  )
  tx.recentBlockhash = blockhash
  tx.feePayer = signer.publicKey
  tx.sign(signer)
  const signature = await withTimeout(
    connection.sendRawTransaction(tx.serialize(), maxRetriesOptions()),
    STEP_TIMEOUT_MS,
    'RPC가 전송에 응답하지 않습니다. 활동 탭이나 Solscan에서 송금 여부를 확인한 뒤 다시 시도하세요.',
  )
  await confirm(connection, signature, lastValidBlockHeight)
  return signature
}

function maxRetriesOptions() {
  return { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' as const }
}

export async function sendSol(
  connection: Connection,
  signer: Keypair,
  recipient: string,
  lamports: bigint,
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
  return submit(connection, tx, signer)
}

export async function sendSplToken(
  connection: Connection,
  signer: Keypair,
  mintAddress: string,
  recipient: string,
  amount: bigint,
  decimals: number,
): Promise<string> {
  if (amount <= 0n) throw new Error('보낼 수량을 입력하세요.')
  const mint = new PublicKey(mintAddress)
  const to = new PublicKey(recipient)
  if (to.equals(signer.publicKey)) throw new Error('본인 주소로는 보낼 수 없습니다.')
  const programId = await resolveTokenProgram(connection, mint)
  const sourceAta = getAssociatedTokenAddressSync(mint, signer.publicKey, false, programId)
  const destinationAta = getAssociatedTokenAddressSync(mint, to, false, programId)

  const tx = new Transaction()
  const destinationInfo = await connection.getAccountInfo(destinationAta)
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
  return submit(connection, tx, signer)
}

export async function maxTransferableSol(
  connection: Connection,
  owner: PublicKey,
): Promise<bigint> {
  const balance = BigInt(await connection.getBalance(owner))
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
