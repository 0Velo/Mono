/**
 * Pre-signing guard for Jupiter swap transactions.
 *
 * A swap transaction is built by a remote service and then signed with the
 * wallet key. "It came from Jupiter over https" is not a security argument: a
 * compromised or spoofed API response could ask the wallet to sign anything,
 * and a signature cannot be undone. Before any swap is signed this module
 * proves three things:
 *
 *  1. the transaction is paid for and signed by this wallet alone (no second
 *     required signer, so no extra signature is smuggled in);
 *  2. every instruction targets a program a swap legitimately needs, and no
 *     System or token instruction hands funds or authority to a third party
 *     (`transfer` of SOL to a stranger, `approve`, `setAuthority`, `burn`,
 *     `freeze`, `closeAccount` into another wallet, `assign`);
 *  3. once simulated, the wallet's own balance changes match the quote the
 *     person reviewed — the generic backstop for a drain hidden inside a CPI.
 *
 * Anything the guard cannot resolve or read fails closed: a refused swap can be
 * retried, a signed drain cannot be undone.
 */
import {
  AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'

export const PROGRAM_IDS = {
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  token: TOKEN_PROGRAM_ID.toBase58(),
  token2022: TOKEN_2022_PROGRAM_ID.toBase58(),
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  system: SystemProgram.programId.toBase58(),
  memoV1: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  memoV2: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
} as const

export const WSOL_MINT = 'So11111111111111111111111111111111111111112'

/** Programs a Jupiter v6 swap may call at the top level. */
export const ALLOWED_SWAP_PROGRAMS: Record<string, string> = {
  [PROGRAM_IDS.jupiter]: 'Jupiter aggregator v6',
  [PROGRAM_IDS.token]: 'SPL Token',
  [PROGRAM_IDS.token2022]: 'SPL Token-2022',
  [PROGRAM_IDS.associatedToken]: 'Associated Token Account',
  [PROGRAM_IDS.computeBudget]: 'Compute Budget',
  [PROGRAM_IDS.system]: 'System',
  [PROGRAM_IDS.memoV1]: 'Memo v1',
  [PROGRAM_IDS.memoV2]: 'Memo v2',
}

/** SOL the wallet may lose beyond the quoted amount: fees and ATA rent. */
export const SOL_FEE_TOLERANCE = 10_000_000n // 0.01 SOL

export type SwapGuardReason =
  | 'empty'
  | 'fee-payer'
  | 'missing-signer'
  | 'unexpected-signer'
  | 'lookup-unresolved'
  | 'program'
  | 'system-instruction'
  | 'token-instruction'
  | 'simulation-failed'
  | 'simulation-incomplete'
  | 'simulation-delta'

export class SwapGuardError extends Error {
  reason: SwapGuardReason
  detail: string
  constructor(reason: SwapGuardReason, detail: string, message: string) {
    super(message)
    this.name = 'SwapGuardError'
    this.reason = reason
    this.detail = detail
  }
}

export interface SwapGuardReport {
  feePayer: string
  requiredSigners: string[]
  programs: string[]
  instructionCount: number
}

const SYSTEM_CREATE_ACCOUNT = 0
const SYSTEM_TRANSFER = 2

const TOKEN_TRANSFER = 3
const TOKEN_APPROVE = 4
const TOKEN_SET_AUTHORITY = 6
const TOKEN_BURN = 8
const TOKEN_CLOSE_ACCOUNT = 9
const TOKEN_FREEZE_ACCOUNT = 10
const TOKEN_THAW_ACCOUNT = 11
const TOKEN_TRANSFER_CHECKED = 12
const TOKEN_APPROVE_CHECKED = 13
const TOKEN_BURN_CHECKED = 15

const DENIED_TOKEN_INSTRUCTIONS: Record<number, string> = {
  [TOKEN_APPROVE]: 'approve (제3자에게 토큰 사용 권한 위임)',
  [TOKEN_APPROVE_CHECKED]: 'approveChecked (제3자에게 토큰 사용 권한 위임)',
  [TOKEN_SET_AUTHORITY]: 'setAuthority (계정 소유권 이전)',
  [TOKEN_BURN]: 'burn (토큰 소각)',
  [TOKEN_BURN_CHECKED]: 'burnChecked (토큰 소각)',
  [TOKEN_FREEZE_ACCOUNT]: 'freezeAccount (계정 동결)',
  [TOKEN_THAW_ACCOUNT]: 'thawAccount (계정 해제)',
}

function fail(reason: SwapGuardReason, detail: string, message: string): never {
  throw new SwapGuardError(reason, detail, message)
}

/**
 * Resolves the address list of a v0 message that uses no lookup tables.
 * Returns null when lookup tables are present; the caller must then fetch them
 * and use `accountKeysWithLookups`.
 */
export function resolveStaticAccountKeys(tx: VersionedTransaction): PublicKey[] | null {
  if (!tx.message.addressTableLookups || tx.message.addressTableLookups.length === 0) {
    return tx.message.staticAccountKeys
  }
  return null
}

/** Full key list following the on-chain order: static, writable lookups, readonly lookups. */
export function accountKeysWithLookups(
  tx: VersionedTransaction,
  tables: AddressLookupTableAccount[],
): PublicKey[] {
  const keys = [...tx.message.staticAccountKeys]
  const byAddress = new Map(tables.map((table) => [table.key.toBase58(), table]))
  for (const lookup of tx.message.addressTableLookups ?? []) {
    const table = byAddress.get(lookup.accountKey.toBase58())
    if (!table) {
      fail('lookup-unresolved', lookup.accountKey.toBase58(), '스왑 주소 테이블을 확인하지 못했습니다.')
    }
    for (const index of lookup.writableIndexes) keys.push(table.state.addresses[index])
    for (const index of lookup.readonlyIndexes) keys.push(table.state.addresses[index])
  }
  return keys
}

function keyAt(keys: PublicKey[], index: number | undefined): PublicKey {
  const key = index === undefined ? undefined : keys[index]
  if (!key) fail('lookup-unresolved', `account index ${index}`, '스왑 트랜잭션의 계정을 확인하지 못했습니다.')
  return key
}

function wsolAssociatedAddress(user: string): string {
  return getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), new PublicKey(user), false).toBase58()
}

function checkSystemInstruction(
  kind: number,
  accountIndexes: number[],
  data: Uint8Array,
  keys: PublicKey[],
  user: PublicKey,
): void {
  if (kind === SYSTEM_TRANSFER) {
    const from = keyAt(keys, accountIndexes[0])
    const to = keyAt(keys, accountIndexes[1])
    const wsolAta = wsolAssociatedAddress(user.toBase58())
    if (!from.equals(user)) {
      fail(
        'system-instruction',
        `transfer from ${from.toBase58()}`,
        '이 지갑이 아닌 계정에서 SOL을 보내는 명령이 포함되어 있습니다.',
      )
    }
    // SOL may only move to the wallet itself (wrap/unwrap) or to its own wSOL
    // account; paying a swap pool in SOL happens inside Jupiter's CPI, not as a
    // top-level System transfer.
    if (!to.equals(user) && to.toBase58() !== wsolAta) {
      fail(
        'system-instruction',
        `transfer to ${to.toBase58()}`,
        '스왑 트랜잭션이 이 지갑의 SOL을 제3자 주소로 보내려 합니다. 서명하지 않았습니다.',
      )
    }
    return
  }

  if (kind === SYSTEM_CREATE_ACCOUNT) {
    const payer = keyAt(keys, accountIndexes[0])
    const newAccount = keyAt(keys, accountIndexes[1])
    const owner = new PublicKey(data.slice(4, 36))
    const wsolAta = wsolAssociatedAddress(user.toBase58())
    if (!payer.equals(user) || newAccount.toBase58() !== wsolAta || !owner.equals(TOKEN_PROGRAM_ID)) {
      fail(
        'system-instruction',
        `createAccount for ${newAccount.toBase58()}`,
        '스왑 트랜잭션이 예상하지 못한 계정을 만들려 합니다.',
      )
    }
    return
  }

  fail(
    'system-instruction',
    `system instruction ${kind}`,
    '스왑 트랜잭션에 예상하지 못한 System 명령이 포함되어 있습니다.',
  )
}

function checkTokenInstruction(
  kind: number,
  accountIndexes: number[],
  data: Uint8Array,
  keys: PublicKey[],
  user: PublicKey,
): void {
  const denied = DENIED_TOKEN_INSTRUCTIONS[kind]
  if (denied) {
    fail('token-instruction', `token instruction ${kind}`, `스왑 트랜잭션에 ${denied} 명령이 포함되어 있습니다.`)
  }

  if (kind === TOKEN_TRANSFER || kind === TOKEN_TRANSFER_CHECKED) {
    // accounts: [source, (mint), destination, authority]
    const authorityIndex = kind === TOKEN_TRANSFER ? 2 : 3
    const authority = keyAt(keys, accountIndexes[authorityIndex])
    if (!authority.equals(user)) {
      fail(
        'token-instruction',
        `transfer authority ${authority.toBase58()}`,
        '다른 지갑의 토큰을 움직이는 명령이 포함되어 있습니다.',
      )
    }
    return
  }

  if (kind === TOKEN_CLOSE_ACCOUNT) {
    // accounts: [account, destination, owner]
    const destination = keyAt(keys, accountIndexes[1])
    const owner = keyAt(keys, accountIndexes[2])
    if (!owner.equals(user) || !destination.equals(user)) {
      fail(
        'token-instruction',
        `closeAccount to ${destination.toBase58()}`,
        '토큰 계정을 제3자 주소로 닫는 명령이 포함되어 있습니다.',
      )
    }
  }

  void data
}

/**
 * Structural guard. Pass `keys` when the transaction uses address lookup
 * tables (see `accountKeysWithLookups`); without them the static key list is
 * used and a lookup-using transaction fails closed.
 */
export function assertSwapTransaction(
  tx: VersionedTransaction,
  user: string,
  keys?: PublicKey[],
): SwapGuardReport {
  const message = tx.message
  const resolved = keys ?? resolveStaticAccountKeys(tx)
  if (!resolved) {
    fail('lookup-unresolved', 'address table lookups', '주소 테이블을 쓰는 스왑 트랜잭션을 검증하지 못했습니다.')
  }
  const accountKeys = resolved!
  const instructions = message.compiledInstructions
  if (instructions.length === 0) fail('empty', 'no instructions', '빈 스왑 트랜잭션입니다.')

  const requiredSigners = accountKeys
    .slice(0, message.header.numRequiredSignatures)
    .map((key) => key.toBase58())
  const feePayer = accountKeys[0]?.toBase58() ?? ''

  if (feePayer !== user) {
    fail('fee-payer', `feePayer=${feePayer}`, '스왑 수수료 지불자가 이 지갑이 아닙니다. 서명하지 않았습니다.')
  }
  if (!requiredSigners.includes(user)) {
    fail('missing-signer', requiredSigners.join(','), '스왑 트랜잭션에 이 지갑의 서명이 필요하지 않습니다.')
  }
  if (requiredSigners.length !== 1) {
    const others = requiredSigners.filter((key) => key !== user).join(', ')
    fail(
      'unexpected-signer',
      requiredSigners.join(','),
      `스왑 트랜잭션이 다른 서명자(${others})를 요구합니다. 서명하지 않았습니다.`,
    )
  }

  const programs: string[] = []
  for (const instruction of instructions) {
    const programId = keyAt(accountKeys, instruction.programIdIndex).toBase58()
    programs.push(programId)
    if (!ALLOWED_SWAP_PROGRAMS[programId]) {
      fail(
        'program',
        programId,
        `스왑에 허용되지 않은 프로그램(${programId.slice(0, 8)}…)이 포함되어 있습니다.`,
      )
    }
  }

  const userKey = new PublicKey(user)
  for (const instruction of instructions) {
    const programId = keyAt(accountKeys, instruction.programIdIndex).toBase58()
    const data = instruction.data
    const accounts = instruction.accountKeyIndexes
    if (programId === PROGRAM_IDS.system) {
      const kind = data.length >= 4 ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true) : -1
      checkSystemInstruction(kind, accounts, data, accountKeys, userKey)
    } else if (programId === PROGRAM_IDS.token || programId === PROGRAM_IDS.token2022) {
      const kind = data.length >= 1 ? data[0] : -1
      checkTokenInstruction(kind, accounts, data, accountKeys, userKey)
    }
  }

  return {
    feePayer,
    requiredSigners,
    programs: Array.from(new Set(programs)),
    instructionCount: instructions.length,
  }
}

/* ------------------------------------------------------------- simulation */

export interface TokenBalanceLike {
  accountIndex: number
  mint: string
  owner?: string
  uiTokenAmount?: { amount?: string; decimals?: number }
}

export interface SwapSimulationLike {
  value: {
    err: unknown
    logs?: string[] | null
    preBalances?: number[]
    postBalances?: number[]
    preTokenBalances?: TokenBalanceLike[] | null
    postTokenBalances?: TokenBalanceLike[] | null
  }
}

export interface SwapExpectation {
  owner: string
  inputMint: string
  /** Base units of the input token, as a decimal string. */
  inAmount: string
  outputMint: string
  /** Minimum acceptable output, base units. */
  minOut: string
}

function isWsol(mint: string): boolean {
  return mint === WSOL_MINT || mint === 'SOL'
}

function tokenDeltas(
  balances: TokenBalanceLike[] | null | undefined,
  owner: string,
): Map<string, bigint> {
  const out = new Map<string, bigint>()
  for (const balance of balances ?? []) {
    if (balance.owner !== owner) continue
    const amount = BigInt(balance.uiTokenAmount?.amount ?? '0')
    out.set(balance.mint, (out.get(balance.mint) ?? 0n) + amount)
  }
  return out
}

function tokenAccountDeltas(
  before: TokenBalanceLike[] | null | undefined,
  after: TokenBalanceLike[] | null | undefined,
  owner: string,
): Array<{ mint: string; delta: bigint }> {
  const accounts = new Map<string, { mint: string; before: bigint; after: bigint }>()
  const collect = (balances: TokenBalanceLike[] | null | undefined, side: 'before' | 'after') => {
    for (const balance of balances ?? []) {
      if (balance.owner !== owner) continue
      const key = `${balance.accountIndex}:${balance.mint}`
      const entry = accounts.get(key) ?? { mint: balance.mint, before: 0n, after: 0n }
      entry[side] = BigInt(balance.uiTokenAmount?.amount ?? '0')
      accounts.set(key, entry)
    }
  }
  collect(before, 'before')
  collect(after, 'after')
  return Array.from(accounts.values(), ({ mint, before: previous, after: next }) => ({
    mint,
    delta: next - previous,
  }))
}

/**
 * Verifies the simulated balance changes against the quote. This is what
 * catches a transaction that is structurally "a swap" but moves more than the
 * person agreed to.
 */
export function assertSwapSimulation(simulation: SwapSimulationLike, expect: SwapExpectation): void {
  const value = simulation?.value
  if (!value) fail('simulation-incomplete', 'no result', '스왑 시뮬레이션 결과를 받지 못했습니다.')
  if (value.err) {
    const logs = (value.logs ?? []).slice(-4).join(' | ')
    fail(
      'simulation-failed',
      logs || JSON.stringify(value.err).slice(0, 300),
      '시뮬레이션에서 스왑이 실패했습니다. 서명하지 않았습니다.',
    )
  }
  if (!Array.isArray(value.preBalances) || !Array.isArray(value.postBalances)) {
    fail('simulation-incomplete', 'balances missing', '스왑 시뮬레이션의 잔액 변화를 확인하지 못했습니다.')
  }

  // feePayer is account index 0 and the guard has already proven it is the user.
  const solDelta = BigInt(value.postBalances![0] ?? 0) - BigInt(value.preBalances![0] ?? 0)
  const pre = tokenDeltas(value.preTokenBalances, expect.owner)
  const post = tokenDeltas(value.postTokenBalances, expect.owner)
  const deltaOf = (mint: string) => (post.get(mint) ?? 0n) - (pre.get(mint) ?? 0n)

  const inAmount = BigInt(expect.inAmount)
  const minOut = BigInt(expect.minOut)
  const tol = SOL_FEE_TOLERANCE
  const inputIsSol = isWsol(expect.inputMint)
  const outputIsSol = isWsol(expect.outputMint)
  const perAccountDeltas = tokenAccountDeltas(value.preTokenBalances, value.postTokenBalances, expect.owner)

  if (!inputIsSol) {
    if (!pre.has(expect.inputMint) && !post.has(expect.inputMint)) {
      fail('simulation-incomplete', `no ${expect.inputMint} input balance`, '스왑 입력 토큰 잔액을 확인하지 못했습니다.')
    }
    const inputOutflow = perAccountDeltas
      .filter((entry) => entry.mint === expect.inputMint && entry.delta < 0n)
      .reduce((total, entry) => total - entry.delta, 0n)
    const unexpectedOutflow = perAccountDeltas.find(
      (entry) => entry.delta < 0n && entry.mint !== expect.inputMint,
    )
    if (unexpectedOutflow) {
      fail(
        'simulation-delta',
        `unexpected token outflow ${unexpectedOutflow.mint} delta ${unexpectedOutflow.delta}`,
        '시뮬레이션에서 스왑 입력과 무관한 토큰이 빠져나갑니다. 서명하지 않았습니다.',
      )
    }
    if (inputOutflow > inAmount) {
      fail(
        'simulation-delta',
        `input ${expect.inputMint} outflow ${inputOutflow}`,
        '시뮬레이션 결과가 견적보다 많은 토큰을 빼앗습니다. 서명하지 않았습니다.',
      )
    }
  } else if (perAccountDeltas.some((entry) => entry.delta < 0n && entry.mint !== expect.inputMint)) {
    const unexpectedOutflow = perAccountDeltas.find(
      (entry) => entry.delta < 0n && entry.mint !== expect.inputMint,
    )!
    fail(
      'simulation-delta',
      `unexpected token outflow ${unexpectedOutflow.mint} delta ${unexpectedOutflow.delta}`,
      '시뮬레이션에서 스왑 입력과 무관한 토큰이 빠져나갑니다. 서명하지 않았습니다.',
    )
  } else {
    const inputOutflow = perAccountDeltas
      .filter((entry) => entry.mint === expect.inputMint && entry.delta < 0n)
      .reduce((total, entry) => total - entry.delta, 0n)
    if (inputOutflow > inAmount) {
      fail('simulation-delta', `input ${expect.inputMint} outflow ${inputOutflow}`, '시뮬레이션 결과가 견적보다 많은 토큰을 빼앗습니다. 서명하지 않았습니다.')
    }
  }
  if (!outputIsSol) {
    if (!post.has(expect.outputMint) && !pre.has(expect.outputMint)) {
      fail('simulation-incomplete', `no ${expect.outputMint} balance`, '스왑 결과 토큰 잔액을 확인하지 못했습니다.')
    }
    const deltaOut = deltaOf(expect.outputMint)
    if (deltaOut < minOut) {
      fail(
        'simulation-delta',
        `output ${expect.outputMint} delta ${deltaOut} < ${minOut}`,
        '시뮬레이션 결과가 최소 수령량보다 적습니다. 서명하지 않았습니다.',
      )
    }
  }

  // SOL side: never lose more than the quoted input plus fees/rent, and for a
  // SOL output never end up below "received at least minOut minus what we paid".
  if (inputIsSol) {
    if (solDelta < -(inAmount + tol)) {
      fail(
        'simulation-delta',
        `sol delta ${solDelta}`,
        '시뮬레이션 결과가 견적보다 많은 SOL을 빼앗습니다. 서명하지 않았습니다.',
      )
    }
  } else if (solDelta < -tol) {
    fail('simulation-delta', `sol delta ${solDelta}`, '시뮬레이션에서 예상 밖의 SOL이 빠져나갑니다. 서명하지 않았습니다.')
  }
  if (outputIsSol) {
    const expectedSolCost = inputIsSol ? inAmount : 0n
    if (solDelta < minOut - (expectedSolCost + tol)) {
      fail(
        'simulation-delta',
        `sol delta ${solDelta} < ${minOut - expectedSolCost - tol}`,
        '시뮬레이션 결과가 최소 수령량보다 적습니다. 서명하지 않았습니다.',
      )
    }
  }
}
