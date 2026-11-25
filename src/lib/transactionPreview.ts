import type { AccountInfo, Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { PublicKey as SolanaPublicKey } from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token'

export const PREVIEW_TTL_MS = 30_000
const RPC_TIMEOUT_MS = 20_000
const MAX_SIMULATION_ACCOUNTS = 100

export interface NativeBalanceChange {
  address: string
  beforeLamports: string
  afterLamports: string
  deltaLamports: string
}

export interface TokenBalanceChange {
  owner: string
  mint: string
  decimals: number
  beforeAmount: string
  afterAmount: string
  deltaAmount: string
}

export interface TransactionPreview {
  owner: string
  recipient: string
  feeLamports: number
  nativeChanges: NativeBalanceChange[]
  tokenChanges: TokenBalanceChange[]
  invokedPrograms: string[]
  unitsConsumed: number | null
  slot: number
}

interface SimulationAccountLike {
  executable: boolean
  owner: string
  lamports: number
  data: string[]
  rentEpoch?: number
}

export interface SnapshotAccount {
  address: string
  before: AccountInfo<Buffer> | null
  after: AccountInfo<Buffer> | null
}

export interface SimulationSnapshot {
  addresses: string[]
  accounts: SnapshotAccount[]
  feeLamports: number
  invokedPrograms: string[]
  unitsConsumed: number | null
  slot: number
  logs: string[]
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

export function captureMessageBytes(tx: VersionedTransaction): Uint8Array {
  return Uint8Array.from(tx.message.serialize())
}

export function assertMessageMatches(tx: VersionedTransaction, previewedBytes: Uint8Array): void {
  const actual = tx.message.serialize()
  if (actual.length !== previewedBytes.length) {
    throw new Error('미리보기와 서명할 트랜잭션이 다릅니다. 다시 시뮬레이션해 주세요.')
  }
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== previewedBytes[index]) {
      throw new Error('미리보기와 서명할 트랜잭션이 다릅니다. 다시 시뮬레이션해 주세요.')
    }
  }
}

function decodeAccount(account: SimulationAccountLike | null | undefined): AccountInfo<Buffer> | null {
  if (!account) return null
  const encoded = account.data?.[0]
  const encoding = account.data?.[1]
  if (typeof encoded !== 'string' || encoding !== 'base64') {
    throw new Error('시뮬레이션 계정 데이터를 읽지 못했습니다. 서명하지 않았습니다.')
  }
  if (!Number.isSafeInteger(account.lamports) || account.lamports < 0) {
    throw new Error('시뮬레이션 잔액 데이터가 올바르지 않습니다. 서명하지 않았습니다.')
  }
  return {
    executable: Boolean(account.executable),
    owner: new SolanaPublicKey(account.owner),
    lamports: account.lamports,
    data: Buffer.from(encoded, 'base64'),
    rentEpoch: account.rentEpoch ?? 0,
  }
}

function programsFromLogs(logs: string[], expectedPrograms: string[]): string[] {
  const invoked: string[] = []
  for (const line of logs) {
    const match = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[\d+\]$/.exec(line)
    if (match && !invoked.includes(match[1])) invoked.push(match[1])
  }
  if (invoked.length === 0 || expectedPrograms.some((program) => !invoked.includes(program))) {
    throw new Error('시뮬레이션에서 호출 프로그램을 완전히 확인하지 못했습니다. 서명하지 않았습니다.')
  }
  return invoked
}

/**
 * Simulates the exact versioned message without replacing its blockhash and
 * returns post-state for the requested accounts. Pre-state and simulation must
 * come from the same confirmed slot; otherwise the preview is discarded rather
 * than presenting a possibly unrelated balance delta.
 */
export async function simulateAndCapture(
  connection: Connection,
  tx: VersionedTransaction,
  accountKeys: PublicKey[],
  expectedPrograms: string[],
): Promise<SimulationSnapshot> {
  const addresses = Array.from(new Set(accountKeys.map((key) => key.toBase58())))
  if (addresses.length === 0 || addresses.length > MAX_SIMULATION_ACCOUNTS) {
    throw new Error('시뮬레이션 계정 수를 안전하게 확인할 수 없습니다. 서명하지 않았습니다.')
  }

  const feeResponse = await withTimeout(
    connection.getFeeForMessage(tx.message, 'confirmed'),
    RPC_TIMEOUT_MS,
    '트랜잭션 수수료 조회가 시간 초과되었습니다. 서명하지 않았습니다.',
  )
  const feeLamports = feeResponse.value
  if (feeLamports === null || !Number.isSafeInteger(feeLamports) || feeLamports < 0) {
    throw new Error('이 트랜잭션의 네트워크 수수료를 확인하지 못했습니다. 서명하지 않았습니다.')
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const beforeResponse = await withTimeout(
      connection.getMultipleAccountsInfoAndContext(addresses.map((address) => new SolanaPublicKey(address)), 'confirmed'),
      RPC_TIMEOUT_MS,
      '시뮬레이션 전 계정 상태 조회가 시간 초과되었습니다. 서명하지 않았습니다.',
    )
    const simulated = await withTimeout(
      connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: 'confirmed',
        minContextSlot: beforeResponse.context.slot,
        accounts: { encoding: 'base64', addresses },
      }),
      RPC_TIMEOUT_MS,
      '트랜잭션 시뮬레이션이 시간 초과되었습니다. 서명하지 않았습니다.',
    )
    if (simulated.context.slot !== beforeResponse.context.slot) continue
    const result = simulated.value
    if (result.err) {
      const logs = (result.logs ?? []).slice(-4).join(' | ')
      throw new Error(`트랜잭션 시뮬레이션에 실패했습니다. 서명하지 않았습니다.${logs ? ` (${logs})` : ''}`)
    }
    if (!Array.isArray(result.accounts) || result.accounts.length !== addresses.length) {
      throw new Error('시뮬레이션 계정 잔액을 충분히 확인하지 못했습니다. 서명하지 않았습니다.')
    }
    if (!Array.isArray(result.logs)) {
      throw new Error('시뮬레이션 프로그램 로그를 확인하지 못했습니다. 서명하지 않았습니다.')
    }
    const after = result.accounts.map((account) => decodeAccount(account as SimulationAccountLike | null))
    return {
      addresses,
      accounts: addresses.map((address, index) => ({
        address,
        before: beforeResponse.value[index],
        after: after[index],
      })),
      feeLamports,
      invokedPrograms: programsFromLogs(result.logs, expectedPrograms),
      unitsConsumed: Number.isSafeInteger(result.unitsConsumed) ? result.unitsConsumed! : null,
      slot: simulated.context.slot,
      logs: result.logs,
    }
  }
  throw new Error('계정 상태가 시뮬레이션 중 변경되어 정확한 미리보기를 만들지 못했습니다. 다시 시도하세요.')
}

interface DecodedTokenAccount {
  address: string
  owner: string
  mint: string
  amount: bigint
  programId: PublicKey
}

function decodeTokenAccount(address: string, info: AccountInfo<Buffer> | null): DecodedTokenAccount | null {
  if (!info || info.data.length < 165) return null
  const programId = info.owner
  if (!programId.equals(TOKEN_PROGRAM_ID) && !programId.equals(TOKEN_2022_PROGRAM_ID)) return null
  try {
    const account = unpackAccount(new SolanaPublicKey(address), info, programId)
    return {
      address,
      owner: account.owner.toBase58(),
      mint: account.mint.toBase58(),
      amount: account.amount,
      programId,
    }
  } catch {
    // Token-program-owned mint and multisig accounts are not token accounts.
    return null
  }
}

function mintDecimals(snapshot: SimulationSnapshot, mint: string, programId: PublicKey): number | null {
  const entry = snapshot.accounts.find((candidate) => candidate.address === mint)
  const info = entry?.before ?? entry?.after
  if (!info) return null
  try {
    return unpackMint(new SolanaPublicKey(mint), info, programId).decimals
  } catch {
    return null
  }
}

function lamportsFor(snapshot: SimulationSnapshot, address: string, side: 'before' | 'after'): bigint | null {
  const account = snapshot.accounts.find((candidate) => candidate.address === address)
  const info = account?.[side]
  return info ? BigInt(info.lamports) : null
}

/** Build a wallet-facing preview. Token changes are aggregated by token owner + mint. */
export function buildTransactionPreview(
  snapshot: SimulationSnapshot,
  owner: string,
  recipient: string,
  tokenOwners: string[] = [owner],
  decimalsHints: Record<string, number> = {},
): TransactionPreview {
  const nativeAddresses = Array.from(new Set([owner, recipient]))
  const nativeChanges: NativeBalanceChange[] = []
  for (const address of nativeAddresses) {
    const before = lamportsFor(snapshot, address, 'before')
    const after = lamportsFor(snapshot, address, 'after')
    if (address === owner && (before === null || after === null)) {
      throw new Error('지갑의 SOL 잔액 시뮬레이션을 확인하지 못했습니다. 서명하지 않았습니다.')
    }
    const beforeValue = before ?? 0n
    const afterValue = after ?? 0n
    nativeChanges.push({
      address,
      beforeLamports: beforeValue.toString(),
      afterLamports: afterValue.toString(),
      deltaLamports: (afterValue - beforeValue).toString(),
    })
  }

  const tokenOwnersSet = new Set(tokenOwners)
  const deltas = new Map<string, { owner: string; mint: string; before: bigint; after: bigint; programId: PublicKey }>()
  for (const item of snapshot.accounts) {
    const before = decodeTokenAccount(item.address, item.before)
    const after = decodeTokenAccount(item.address, item.after)
    const ownerAddress = before?.owner ?? after?.owner
    if (!ownerAddress || !tokenOwnersSet.has(ownerAddress)) continue
    if (before && after && (before.owner !== after.owner || before.mint !== after.mint)) {
      throw new Error('시뮬레이션에서 토큰 계정 소유 정보가 바뀌었습니다. 서명하지 않았습니다.')
    }
    const mint = before?.mint ?? after?.mint
    if (!mint) continue
    const programId = before?.programId ?? after!.programId
    const key = `${ownerAddress}:${mint}`
    const current = deltas.get(key) ?? { owner: ownerAddress, mint, before: 0n, after: 0n, programId }
    current.before += before?.amount ?? 0n
    current.after += after?.amount ?? 0n
    deltas.set(key, current)
  }

  const tokenChanges: TokenBalanceChange[] = []
  for (const entry of deltas.values()) {
    const delta = entry.after - entry.before
    if (delta === 0n) continue
    const decimals = decimalsHints[entry.mint] ?? mintDecimals(snapshot, entry.mint, entry.programId)
    if (decimals === null || decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new Error(`토큰 ${entry.mint.slice(0, 8)}의 소수점 정보를 확인하지 못했습니다. 서명하지 않았습니다.`)
    }
    tokenChanges.push({
      owner: entry.owner,
      mint: entry.mint,
      decimals,
      beforeAmount: entry.before.toString(),
      afterAmount: entry.after.toString(),
      deltaAmount: delta.toString(),
    })
  }

  return {
    owner,
    recipient,
    feeLamports: snapshot.feeLamports,
    nativeChanges,
    tokenChanges,
    invokedPrograms: snapshot.invokedPrograms,
    unitsConsumed: snapshot.unitsConsumed,
    slot: snapshot.slot,
  }
}

export function toSwapSimulation(
  snapshot: SimulationSnapshot,
  accountKeys: PublicKey[],
  owner: string,
) {
  const index = new Map(snapshot.addresses.map((address, position) => [address, position]))
  const preBalances = accountKeys.map((key) => {
    const entry = snapshot.accounts[index.get(key.toBase58()) ?? -1]
    return entry?.before?.lamports ?? 0
  })
  const postBalances = accountKeys.map((key) => {
    const entry = snapshot.accounts[index.get(key.toBase58()) ?? -1]
    return entry?.after?.lamports ?? 0
  })
  const tokenBalances = (side: 'before' | 'after') => {
    const out: Array<{ accountIndex: number; mint: string; owner: string; uiTokenAmount: { amount: string; decimals: number } }> = []
    for (let accountIndex = 0; accountIndex < accountKeys.length; accountIndex += 1) {
      const address = accountKeys[accountIndex].toBase58()
      const snapshotIndex = index.get(address)
      if (snapshotIndex === undefined) continue
      const state = snapshot.accounts[snapshotIndex][side]
      const token = decodeTokenAccount(address, state)
      if (!token || token.owner !== owner) continue
      const decimals = mintDecimals(snapshot, token.mint, token.programId)
      if (decimals === null) continue
      out.push({
        accountIndex,
        mint: token.mint,
        owner: token.owner,
        uiTokenAmount: { amount: token.amount.toString(), decimals },
      })
    }
    return out
  }
  const ownerIndex = accountKeys.findIndex((key) => key.toBase58() === owner)
  if (ownerIndex < 0 || preBalances[ownerIndex] <= 0) {
    throw new Error('스왑 지갑 SOL 잔액을 확인하지 못했습니다. 서명하지 않았습니다.')
  }
  return {
    value: {
      err: null,
      logs: snapshot.logs,
      preBalances,
      postBalances,
      preTokenBalances: tokenBalances('before'),
      postTokenBalances: tokenBalances('after'),
    },
  }
}
