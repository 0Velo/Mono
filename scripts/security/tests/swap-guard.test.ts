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
import { executeSwap } from '../../../src/lib/swapExecute'

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

test('the SOL fee tolerance is small enough to be a real bound', () => {
  assert.ok(SOL_FEE_TOLERANCE <= 20_000_000n, 'tolerance must stay under 0.02 SOL')
})

/* ----------------------------------------------------------- full execution */

function fakeSwapConnection(overrides: { simulation?: any } = {}) {
  const calls: string[] = []
  const connection = {
    simulateTransaction: async () => {
      calls.push('simulate')
      return overrides.simulation ?? simulation()
    },
    sendRawTransaction: async () => {
      calls.push('send')
      return 'SIGNATURE'
    },
    confirmTransaction: async () => {
      calls.push('confirm')
      return { value: { err: null } }
    },
    getBlockHeight: async () => 1_000,
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
  const tx = build([ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), jupiterInstruction()])
  const steps: string[] = []
  const signature = await executeSwap({
    connection,
    keypair: user,
    built: builtFor(tx),
    quote,
    onStep: (step) => steps.push(step),
  })
  assert.equal(signature, 'SIGNATURE')
  assert.deepEqual(steps, ['guard', 'simulate', 'sign', 'send', 'confirm'])
  assert.deepEqual(calls, ['simulate', 'send', 'confirm'])
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
  const { connection, calls } = fakeSwapConnection({ simulation: simulation({ err: { InstructionError: [1, 'Custom'] } }) })
  const tx = build([ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), jupiterInstruction()])
  await assert.rejects(
    () => executeSwap({ connection, keypair: user, built: builtFor(tx), quote }),
    (error: unknown) => error instanceof SwapGuardError && error.reason === 'simulation-failed',
  )
  assert.deepEqual(calls, ['simulate'])
})

test('executeSwap never broadcasts when the simulation moves more than quoted', async () => {
  const { connection, calls } = fakeSwapConnection({ simulation: simulation({ postBalances: [0] }) })
  const tx = build([ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), jupiterInstruction()])
  await assert.rejects(
    () => executeSwap({ connection, keypair: user, built: builtFor(tx), quote }),
    (error: unknown) => error instanceof SwapGuardError && error.reason === 'simulation-delta',
  )
  assert.deepEqual(calls, ['simulate'])
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
