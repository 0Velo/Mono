/**
 * Area 5 — the Jupiter swap guard and the sign/broadcast order.
 *
 * A swap transaction comes from a remote API. These tests feed the guard the
 * transactions a compromised API could return (drain to a stranger, extra
 * signer, authority grant, inflated outflow) and prove nothing gets signed,
 * plus the happy path and the simulation-based balance check.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  AccountLayout,
  MintLayout,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createApproveInstruction,
  createCloseAccountInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  PROGRAM_IDS,
  SOL_FEE_TOLERANCE,
  SwapGuardError,
  WSOL_MINT,
  assertSwapSimulation,
  assertSwapTransaction,
} from '../../../src/lib/swapGuard'
import { executeSwap, prepareSwap, signPreparedSwap, SwapExecutionError } from '../../../src/lib/swapExecute'
import { PREVIEW_TTL_MS, assertMessageMatches } from '../../../src/lib/transactionPreview'
import { TxOutcomeError } from '../../../src/lib/tx'

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const user = Keypair.generate()
const attacker = Keypair.generate()
const payer = user
const blockhash = Keypair.generate().publicKey.toBase58()

function build(instructions: TransactionInstruction[], signers: Keypair[] = [payer]): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message()
  const tx = new VersionedTransaction(message)
  tx.sign(signers)
  return tx
}

function jupiterInstruction(extraKeys: PublicKey[] = []): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(PROGRAM_IDS.jupiter),
    keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }, ...extraKeys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))],
    data: Buffer.from([0x0a, 0x01, 0x02, 0x03]),
  })
}

function expectGuardError(fn: () => unknown, reason: string) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof SwapGuardError, `expected SwapGuardError, got ${String(error)}`)
    assert.equal((error as SwapGuardError).reason, reason)
    return true
  })
}

/* --------------------------------------------------------------- structure */

test('a normal Jupiter swap passes the structural guard', () => {
  const tx = build([ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), jupiterInstruction()])
  const report = assertSwapTransaction(tx, user.publicKey.toBase58())
  assert.equal(report.feePayer, user.publicKey.toBase58())
  assert.deepEqual(report.requiredSigners, [user.publicKey.toBase58()])
  assert.ok(report.programs.includes(PROGRAM_IDS.jupiter))
  assert.ok(report.programs.includes(PROGRAM_IDS.computeBudget))
})

test('a transaction paid for by another key is refused', () => {
  const message = new TransactionMessage({
    payerKey: attacker.publicKey,
    recentBlockhash: blockhash,
    instructions: [jupiterInstruction()],
  }).compileToV0Message()
  const tx = new VersionedTransaction(message)
  tx.sign([attacker, user])
  expectGuardError(
    () => assertSwapTransaction(tx, user.publicKey.toBase58()),
    'fee-payer',
  )
})

test('a transaction that requires a second signature is refused', () => {
  const extraSigner = Keypair.generate()
  const instruction = new TransactionInstruction({
    programId: new PublicKey(PROGRAM_IDS.jupiter),
    keys: [
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
      { pubkey: extraSigner.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([1]),
  })
  const tx = build([instruction], [user, extraSigner])
  expectGuardError(() => assertSwapTransaction(tx, user.publicKey.toBase58()), 'unexpected-signer')
})

test('a transaction that does not need this wallet signature is refused', () => {
  const other = Keypair.generate()
  const message = new TransactionMessage({
    payerKey: other.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      new TransactionInstruction({
        programId: new PublicKey(PROGRAM_IDS.jupiter),
        keys: [{ pubkey: other.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.from([1]),
      }),
    ],
  }).compileToV0Message()
  const tx = new VersionedTransaction(message)
  tx.sign([other])
  expectGuardError(() => assertSwapTransaction(tx, user.publicKey.toBase58()), 'fee-payer')
})

test('an unknown program is refused', () => {
  const tx = build([
    new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from([1]),
    }),
  ])
  expectGuardError(() => assertSwapTransaction(tx, user.publicKey.toBase58()), 'program')
})

test('a SOL transfer to a stranger hidden in the swap is refused', () => {
  const tx = build([
    SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: attacker.publicKey, lamports: 1_000_000_000 }),
    jupiterInstruction(),
  ])
  expectGuardError(() => assertSwapTransaction(tx, user.publicKey.toBase58()), 'system-instruction')
})

test('a SOL transfer to the wallet own wSOL account is allowed (wrap)', () => {
  const wsolAta = getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), user.publicKey, false)
  const tx = build([
    SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: wsolAta, lamports: 10_000_000 }),
    jupiterInstruction(),
  ])
  const report = assertSwapTransaction(tx, user.publicKey.toBase58())
  assert.equal(report.feePayer, user.publicKey.toBase58())
})

test('an unexpected System instruction (assign/allocate) is refused', () => {
  const tx = build([
    SystemProgram.assign({ accountPubkey: user.publicKey, programId: attacker.publicKey }),
    jupiterInstruction(),
  ])
  expectGuardError(() => assertSwapTransaction(tx, user.publicKey.toBase58()), 'system-instruction')
})

test('a token approve (delegate to a third party) is refused', () => {
  const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), user.publicKey, false)
  const tx = build([
    createApproveInstruction(ata, attacker.publicKey, user.publicKey, 1_000_000n),
    jupiterInstruction(),
  ])
  expectGuardError(() => assertSwapTransaction(tx, user.publicKey.toBase58()), 'token-instruction')
})

test('a token setAuthority (hand over account ownership) is refused', () => {
  const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), user.publicKey, false)
  const tx = build([
    createSetAuthorityInstruction(ata, user.publicKey, AuthorityType.AccountOwner, attacker.publicKey),
    jupiterInstruction(),
  ])
  expectGuardError(() => assertSwapTransaction(tx, user.publicKey.toBase58()), 'token-instruction')
})

test('closing a token account into another wallet is refused', () => {
  const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), user.publicKey, false)
  const tx = build([
    createCloseAccountInstruction(ata, attacker.publicKey, user.publicKey),
    jupiterInstruction(),
  ])
  expectGuardError(() => assertSwapTransaction(tx, user.publicKey.toBase58()), 'token-instruction')
})

test('a token transfer authorized by someone else is refused', () => {
  const source = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), user.publicKey, false)
  const destination = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), attacker.publicKey, false)
  const instruction = createTransferCheckedInstruction(
    source,
    new PublicKey(USDC_MINT),
    destination,
    attacker.publicKey,
    1_000_000n,
    6,
  )
  // Keep the authority as a plain account (not a signer) so the token rule —
  // not the extra-signer rule — is what has to catch it.
  instruction.keys = instruction.keys.map((key) => ({ ...key, isSigner: false }))
  const tx = build([instruction, jupiterInstruction()])
  expectGuardError(() => assertSwapTransaction(tx, user.publicKey.toBase58()), 'token-instruction')
})

/* -------------------------------------------------------------- simulation */

function simulation(overrides: Record<string, unknown> = {}) {
  return {
    value: {
      err: null,
      logs: [],
      preBalances: [1_000_000_000],
      postBalances: [1_000_000_000 - 10_000_000 - 5_000],
      preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 2, mint: USDC_MINT, owner: user.publicKey.toBase58(), uiTokenAmount: { amount: '1000000', decimals: 6 } },
      ],
      ...overrides,
    },
  } as any
}

const expectation = {
  owner: user.publicKey.toBase58(),
  inputMint: WSOL_MINT,
  inAmount: '10000000',
  outputMint: USDC_MINT,
  minOut: '900000',
}

test('a simulation that matches the quote passes', () => {
  assert.doesNotThrow(() => assertSwapSimulation(simulation(), expectation))
})

test('a simulation error blocks the swap', () => {
  expectGuardError(
    () => assertSwapSimulation(simulation({ err: { InstructionError: [0, 'Custom'] }, logs: ['Program failed'] }), expectation),
    'simulation-failed',
  )
})

test('a simulation that takes more SOL than the quoted input is refused', () => {
  expectGuardError(
    () => assertSwapSimulation(simulation({ postBalances: [1_000_000_000 - 500_000_000] }), expectation),
    'simulation-delta',
  )
})

test('a simulation that pays less than the minimum received is refused', () => {
  expectGuardError(
    () =>
      assertSwapSimulation(
        simulation({
          postTokenBalances: [
            { accountIndex: 2, mint: USDC_MINT, owner: user.publicKey.toBase58(), uiTokenAmount: { amount: '100', decimals: 6 } },
          ],
        }),
        expectation,
      ),
    'simulation-delta',
  )
})

test('a simulation without balance data fails closed', () => {
  expectGuardError(
    () => assertSwapSimulation({ value: { err: null, preBalances: undefined, postBalances: undefined } } as any, expectation),
    'simulation-incomplete',
  )
})

test('an SPL input that is over-drawn is refused', () => {
  expectGuardError(
    () =>
      assertSwapSimulation(
        simulation({
          preTokenBalances: [
            { accountIndex: 2, mint: USDC_MINT, owner: user.publicKey.toBase58(), uiTokenAmount: { amount: '5000000', decimals: 6 } },
          ],
          postTokenBalances: [],
        }),
        { ...expectation, inputMint: USDC_MINT, inAmount: '1000000', outputMint: WSOL_MINT, minOut: '900000' },
      ),
    'simulation-delta',
  )
})

test('a swap that spends an unrelated user token is refused even when its quoted input and output are valid', () => {
  expectGuardError(
    () =>
      assertSwapSimulation(
        simulation({
          preBalances: [1_000_000_000],
          postBalances: [1_000_000_000 + 1_000_000],
          preTokenBalances: [
            { accountIndex: 2, mint: USDC_MINT, owner: user.publicKey.toBase58(), uiTokenAmount: { amount: '5000000', decimals: 6 } },
            { accountIndex: 3, mint: 'BONK_MINT', owner: user.publicKey.toBase58(), uiTokenAmount: { amount: '900', decimals: 5 } },
          ],
          postTokenBalances: [
            { accountIndex: 2, mint: USDC_MINT, owner: user.publicKey.toBase58(), uiTokenAmount: { amount: '4000000', decimals: 6 } },
            { accountIndex: 4, mint: WSOL_MINT, owner: user.publicKey.toBase58(), uiTokenAmount: { amount: '1000000', decimals: 9 } },
          ],
        }),
        { ...expectation, inputMint: USDC_MINT, inAmount: '1000000', outputMint: WSOL_MINT, minOut: '900000' },
      ),
    'simulation-delta',
  )
})

test('SPL-to-SOL output enforces the SOL minimum without subtracting SPL base units', () => {
  expectGuardError(
    () =>
      assertSwapSimulation(
        simulation({
          preBalances: [1_000_000_000],
          postBalances: [1_050_000_000],
          preTokenBalances: [
            { accountIndex: 2, mint: USDC_MINT, owner: user.publicKey.toBase58(), uiTokenAmount: { amount: '100000000', decimals: 6 } },
          ],
          postTokenBalances: [
            { accountIndex: 2, mint: USDC_MINT, owner: user.publicKey.toBase58(), uiTokenAmount: { amount: '50000000', decimals: 6 } },
          ],
        }),
        { ...expectation, inputMint: USDC_MINT, inAmount: '50000000', outputMint: WSOL_MINT, minOut: '100000000' },
      ),
    'simulation-delta',
  )
})

test('the SOL fee tolerance is small enough to be a real bound', () => {
  assert.ok(SOL_FEE_TOLERANCE <= 20_000_000n, 'tolerance must stay under 0.02 SOL')
})

/* ----------------------------------------------------------- full execution */

function mintAccountInfo() {
  const data = Buffer.alloc(MintLayout.span)
  MintLayout.encode({
    mintAuthorityOption: 0,
    mintAuthority: PublicKey.default,
    supply: 1_000_000_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default,
  }, data)
  return { executable: false, owner: TOKEN_PROGRAM_ID, lamports: 1, data, rentEpoch: 0 }
}

function tokenAccountInfo(amount: bigint) {
  const data = Buffer.alloc(AccountLayout.span)
  AccountLayout.encode({
    mint: new PublicKey(USDC_MINT),
    owner: user.publicKey,
    amount,
    delegateOption: 0,
    delegate: PublicKey.default,
    state: 1,
    isNativeOption: 0,
    isNative: 0n,
    delegatedAmount: 0n,
    closeAuthorityOption: 0,
    closeAuthority: PublicKey.default,
  }, data)
  return { executable: false, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, data, rentEpoch: 0 }
}

function encodedAccount(info: any) {
  if (!info) return null
  return {
    executable: info.executable,
    owner: info.owner.toBase58(),
    lamports: info.lamports,
    data: [info.data.toString('base64'), 'base64'],
    rentEpoch: info.rentEpoch,
  }
}

const outputMintKey = new PublicKey(USDC_MINT)
const outputAta = getAssociatedTokenAddressSync(outputMintKey, user.publicKey)
function executableSwapTransaction() {
  return build([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    jupiterInstruction([outputAta, outputMintKey]),
  ])
}

function fakeSwapConnection(overrides: { simulation?: any; status?: any; failSend?: boolean; failSimulation?: boolean; outputAmount?: bigint; omitAccounts?: boolean; omitLogs?: boolean } = {}) {
  const calls: string[] = []
  const connection = {
    getFeeForMessage: async () => {
      calls.push('fee')
      return { context: { slot: 88 }, value: 5_000 }
    },
    getMultipleAccountsInfoAndContext: async (addresses: PublicKey[]) => {
      calls.push('before')
      return {
        context: { slot: 88 },
        value: addresses.map((address) => {
          if (address.equals(user.publicKey)) return { executable: false, owner: SystemProgram.programId, lamports: 1_000_000_000, data: Buffer.alloc(0), rentEpoch: 0 }
          if (address.equals(outputAta)) return tokenAccountInfo(0n)
          if (address.equals(outputMintKey)) return mintAccountInfo()
          return null
        }),
      }
    },
    simulateTransaction: async (_tx: unknown, config: any) => {
      calls.push('simulate')
      const addresses = config.accounts.addresses.map((address: string) => new PublicKey(address))
      const accounts = addresses.map((address: PublicKey) => {
        if (address.equals(user.publicKey)) {
          return encodedAccount({ executable: false, owner: SystemProgram.programId, lamports: overrides.simulation?.value?.postBalances?.[0] ?? 989_995_000, data: Buffer.alloc(0), rentEpoch: 0 })
        }
        if (address.equals(outputAta)) return encodedAccount(tokenAccountInfo(overrides.outputAmount ?? 1_000_000n))
        if (address.equals(outputMintKey)) return encodedAccount(mintAccountInfo())
        return null
      })
      const programLogs = [
        `Program ${PROGRAM_IDS.computeBudget} invoke [1]`,
        `Program ${PROGRAM_IDS.computeBudget} success`,
        `Program ${PROGRAM_IDS.jupiter} invoke [1]`,
        `Program ${PROGRAM_IDS.jupiter} success`,
      ]
      return {
        context: { slot: 88 },
        value: {
          err: overrides.failSimulation ? { InstructionError: [1, 'Custom'] } : null,
          ...(overrides.omitAccounts ? {} : { accounts }),
          ...(overrides.omitLogs ? {} : { logs: programLogs }),
          unitsConsumed: 50_000,
        },
      }
    },
    sendRawTransaction: async (raw: Uint8Array) => {
      calls.push('send')
      const signed = VersionedTransaction.deserialize(raw).signatures[0]
      if (overrides.failSend) throw new Error('RPC connection lost')
      return bs58.encode(signed)
    },
    getSignatureStatuses: async () => {
      calls.push('confirm')
      return {
        value: ['status' in overrides ? overrides.status : { err: null, confirmationStatus: 'confirmed' }],
      }
    },
    getBlockHeight: async () => {
      calls.push('height')
      return 1_000
    },
    getAccountInfo: async () => null,
  }
  return { connection: connection as any, calls }
}

function builtFor(tx: VersionedTransaction) {
  return { transaction: Buffer.from(tx.serialize()).toString('base64'), lastValidBlockHeight: 1_500 }
}

const quote = {
  inputMint: WSOL_MINT,
  outputMint: USDC_MINT,
  inAmount: '10000000',
  otherAmountThreshold: '900000',
} as any

test('executeSwap runs guard → simulate → sign → send → confirm and returns the signature', async () => {
  const { connection, calls } = fakeSwapConnection()
  const tx = executableSwapTransaction()
  const steps: string[] = []
  let persistedSignature = ''
  let terminal = false
  const signature = await executeSwap({
    connection,
    keypair: user,
    built: builtFor(tx),
    quote,
    onStep: (step) => steps.push(step),
    hooks: {
      onSigned: (attempt) => {
        calls.push('persist')
        persistedSignature = attempt.signature
        assert.equal(attempt.lastValidBlockHeight, 1_500)
      },
      onTerminal: () => { terminal = true },
    },
  })
  assert.equal(signature, persistedSignature)
  assert.equal(terminal, true)
  assert.deepEqual(steps, ['guard', 'simulate', 'sign', 'send', 'confirm'])
  assert.deepEqual(calls, ['fee', 'before', 'simulate', 'height', 'height', 'persist', 'send', 'confirm'])
})

test('executeSwap never broadcasts a draining transaction', async () => {
  const { connection, calls } = fakeSwapConnection()
  const tx = build([
    SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: attacker.publicKey, lamports: 1_000_000_000 }),
    jupiterInstruction(),
  ])
  await assert.rejects(
    () => executeSwap({ connection, keypair: user, built: builtFor(tx), quote }),
    (error: unknown) => error instanceof SwapGuardError && error.reason === 'system-instruction',
  )
  assert.deepEqual(calls, [], 'nothing may be simulated or sent after a guard failure')
})

test('executeSwap never broadcasts when the simulation fails', async () => {
  const { connection, calls } = fakeSwapConnection({ failSimulation: true })
  const tx = executableSwapTransaction()
  await assert.rejects(
    () => executeSwap({ connection, keypair: user, built: builtFor(tx), quote }),
    /트랜잭션 시뮬레이션에 실패했습니다/,
  )
  assert.deepEqual(calls, ['fee', 'before', 'simulate'])
})

test('executeSwap never broadcasts when the simulation moves more than quoted', async () => {
  const { connection, calls } = fakeSwapConnection({ outputAmount: 1n })
  const tx = executableSwapTransaction()
  await assert.rejects(
    () => executeSwap({ connection, keypair: user, built: builtFor(tx), quote }),
    (error: unknown) => error instanceof SwapGuardError && error.reason === 'simulation-delta',
  )
  assert.deepEqual(calls, ['fee', 'before', 'simulate'])
})

test('executeSwap rejects a payload that is not a transaction', async () => {
  const { connection, calls } = fakeSwapConnection()
  await assert.rejects(
    () =>
      executeSwap({
        connection,
        keypair: user,
        built: { transaction: Buffer.from('garbage').toString('base64'), lastValidBlockHeight: null },
        quote,
      }),
    /스왑 트랜잭션을 읽지 못했습니다/,
  )
  assert.deepEqual(calls, [])
})

test('executeSwap will not broadcast if persisting the local signature fails', async () => {
  const { connection, calls } = fakeSwapConnection()
  const tx = executableSwapTransaction()
  await assert.rejects(
    () =>
      executeSwap({
        connection,
        keypair: user,
        built: builtFor(tx),
        quote,
        hooks: { onSigned: () => { throw new Error('storage unavailable') } },
      }),
    /storage unavailable/,
  )
  assert.deepEqual(calls, ['fee', 'before', 'simulate', 'height', 'height'])
})

test('executeSwap keeps an RPC-loss attempt pending and does not clear its record', async () => {
  const { connection, calls } = fakeSwapConnection({ failSend: true, status: null })
  const tx = executableSwapTransaction()
  let saved = ''
  let terminal = false
  await assert.rejects(
    () =>
      executeSwap({
        connection,
        keypair: user,
        built: builtFor(tx),
        quote,
        hooks: {
          onSigned: (attempt) => { saved = attempt.signature },
          onTerminal: () => { terminal = true },
        },
      }),
    (error: unknown) => error instanceof TxOutcomeError && error.outcome === 'pending',
  )
  assert.ok(saved)
  assert.equal(terminal, false)
  assert.deepEqual(calls, ['fee', 'before', 'simulate', 'height', 'height', 'send', 'confirm', 'height'])
})

test('executeSwap refuses to sign when Jupiter omits the real last valid block height', async () => {
  const { connection, calls } = fakeSwapConnection()
  const tx = executableSwapTransaction()
  await assert.rejects(
    () => executeSwap({ connection, keypair: user, built: { ...builtFor(tx), lastValidBlockHeight: null }, quote }),
    (error: unknown) => error instanceof SwapExecutionError && error.step === 'guard',
  )
  assert.deepEqual(calls, [])
})

test('prepared swap byte guard refuses a changed transaction before signing or broadcast', async () => {
  const { connection, calls } = fakeSwapConnection()
  const tx = executableSwapTransaction()
  const prepared = await prepareSwap({ connection, keypair: user, built: builtFor(tx), quote })
  assertMessageMatches(prepared.transaction, prepared.messageBytes)
  let signCalls = 0
  prepared.transaction.sign = () => { signCalls += 1 }
  prepared.transaction.message.compiledInstructions[1].data[0] ^= 1
  await assert.rejects(
    () => signPreparedSwap({ connection, keypair: user, prepared, quote }),
    /미리보기와 서명할 트랜잭션이 다릅니다/,
  )
  assert.equal(signCalls, 0)
  assert.equal(calls.includes('send'), false)
})

test('swap preview fails closed when simulation accounts or invocation logs are missing', async () => {
  for (const options of [{ omitAccounts: true }, { omitLogs: true }]) {
    const { connection, calls } = fakeSwapConnection(options)
    const tx = executableSwapTransaction()
    await assert.rejects(() => prepareSwap({ connection, keypair: user, built: builtFor(tx), quote }))
    assert.equal(calls.includes('send'), false)
  }
})

test('swap preview is bound to the same wallet and quote and expires by age or block height', async () => {
  const { connection, calls } = fakeSwapConnection()
  const tx = executableSwapTransaction()
  const prepared = await prepareSwap({ connection, keypair: user, built: builtFor(tx), quote })
  let signCalls = 0
  prepared.transaction.sign = () => { signCalls += 1 }
  await assert.rejects(
    () => signPreparedSwap({ connection, keypair: Keypair.generate(), prepared, quote }),
    /미리보기 당시 지갑 또는 견적이 변경됐습니다/,
  )
  await assert.rejects(
    () => signPreparedSwap({ connection, keypair: user, prepared, quote: { ...quote, otherAmountThreshold: '900001' } as any }),
    /미리보기 당시 지갑 또는 견적이 변경됐습니다/,
  )
  prepared.createdAt = Date.now() - PREVIEW_TTL_MS - 1
  await assert.rejects(() => signPreparedSwap({ connection, keypair: user, prepared, quote }), /미리보기가 만료됐습니다/)
  prepared.createdAt = Date.now()
  prepared.lastValidBlockHeight = 999
  await assert.rejects(() => signPreparedSwap({ connection, keypair: user, prepared, quote }), /블록해시가 만료됐습니다/)
  assert.equal(signCalls, 0)
  assert.equal(calls.includes('send'), false)
})
