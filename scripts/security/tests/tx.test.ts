/**
 * Area 5 — transaction building and fee arithmetic.
 *
 * No network: a fake Connection answers the few reads the builders make, so the
 * tests prove the wallet's own logic (validation order, fee/rent maths) rather
 * than an RPC's behaviour.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  ATA_RENT_LAMPORTS,
  BASE_FEE_LAMPORTS,
  estimateFee,
  inspectTransaction,
  maxTransferableSol,
  sendSol,
  sendSplToken,
  TxOutcomeError,
} from '../../../src/lib/tx'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function fakeConnection(balance: number, accounts: Record<string, unknown> = {}) {
  return {
    getBalance: async () => balance,
    getAccountInfo: async (key: PublicKey) => accounts[key.toBase58()] ?? null,
    getLatestBlockhash: async () => {
      throw new Error('network must not be reached in this test')
    },
  } as any
}

test('BASE_FEE_LAMPORTS and ATA rent match Solana mainnet constants', () => {
  assert.equal(BASE_FEE_LAMPORTS, 5_000n)
  assert.equal(ATA_RENT_LAMPORTS, 2_039_280n)
})

test('maxTransferableSol always leaves the network fee behind', async () => {
  assert.equal(await maxTransferableSol(fakeConnection(10_000), Keypair.generate().publicKey), 5_000n)
  assert.equal(await maxTransferableSol(fakeConnection(5_000), Keypair.generate().publicKey), 0n)
  assert.equal(await maxTransferableSol(fakeConnection(4_999), Keypair.generate().publicKey), 0n)
  assert.equal(await maxTransferableSol(fakeConnection(0), Keypair.generate().publicKey), 0n)
})

test('estimateFee charges rent only when the recipient token account must be created', async () => {
  const owner = Keypair.generate().publicKey
  const recipient = Keypair.generate().publicKey
  const plain = fakeConnection(1_000_000_000, {
    [USDC]: { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82) },
  })

  const sol = await estimateFee(plain, 'sol', owner, null, null)
  assert.deepEqual(sol, {
    feeLamports: BASE_FEE_LAMPORTS,
    rentLamports: 0n,
    totalLamports: BASE_FEE_LAMPORTS,
    createsAta: false,
  })

  const splNewAccount = await estimateFee(plain, 'spl', owner, USDC, recipient.toBase58())
  assert.equal(splNewAccount.createsAta, true)
  assert.equal(splNewAccount.rentLamports, ATA_RENT_LAMPORTS)
  assert.equal(splNewAccount.totalLamports, BASE_FEE_LAMPORTS + ATA_RENT_LAMPORTS)

  // Same call with the ATA present.
  const { getAssociatedTokenAddressSync } = await import('@solana/spl-token')
  const ata = getAssociatedTokenAddressSync(new PublicKey(USDC), recipient, false, TOKEN_PROGRAM_ID)
  const withAta = await estimateFee(
    fakeConnection(1_000_000_000, {
      [ata.toBase58()]: { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) },
      [USDC]: { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82) },
    }),
    'spl',
    owner,
    USDC,
    recipient.toBase58(),
  )
  assert.equal(withAta.createsAta, false)
  assert.equal(withAta.rentLamports, 0n)
})

test('a SOL send to your own address and a zero amount are refused before any RPC call', async () => {
  const signer = Keypair.generate()
  const connection = fakeConnection(0)
  await assert.rejects(
    () => sendSol(connection, signer, signer.publicKey.toBase58(), 1_000n),
    /본인 주소/,
  )
  await assert.rejects(() => sendSol(connection, signer, Keypair.generate().publicKey.toBase58(), 0n), /수량/)
  await assert.rejects(() => sendSplToken(connection, signer, USDC, signer.publicKey.toBase58(), 1n, 6), /본인 주소/)
  await assert.rejects(
    () => sendSplToken(connection, signer, USDC, Keypair.generate().publicKey.toBase58(), 0n, 6),
    /수량/,
  )
})

test('an invalid recipient address never reaches signing', async () => {
  const signer = Keypair.generate()
  await assert.rejects(() => sendSol(fakeConnection(1_000_000), signer, 'not-an-address', 1_000n))
  await assert.rejects(() => sendSol(fakeConnection(1_000_000), signer, '1'.repeat(44), 1_000n))
})

function broadcastConnection(options: {
  status?: any
  height?: number
  failSend?: boolean
  failStatus?: boolean
} = {}) {
  const calls: string[] = []
  let sentSignature = ''
  const blockhash = Keypair.generate().publicKey.toBase58()
  const connection = {
    getLatestBlockhash: async () => {
      calls.push('blockhash')
      return { blockhash, lastValidBlockHeight: 20 }
    },
    sendRawTransaction: async (raw: Uint8Array) => {
      calls.push('send')
      const signed = Transaction.from(raw).signature
      assert.ok(signed, 'transaction must already be signed')
      sentSignature = bs58.encode(signed)
      if (options.failSend) throw new Error('RPC connection lost after request')
      return sentSignature
    },
    getSignatureStatuses: async (signatures: string[]) => {
      calls.push('status')
      assert.equal(signatures[0], sentSignature || signatures[0])
      if (options.failStatus) throw new Error('RPC unavailable')
      return { value: [options.status ?? null] }
    },
    getBlockHeight: async () => {
      calls.push('height')
      return options.height ?? 10
    },
  }
  return { connection: connection as any, calls, getSentSignature: () => sentSignature }
}

test('a signed SOL send is persisted before RPC broadcast and confirmed with the same signature', async () => {
  const signer = Keypair.generate()
  const fake = broadcastConnection({ status: { err: null, confirmationStatus: 'confirmed' } })
  let persisted = false
  let terminal = false
  let savedSignature = ''
  const signature = await sendSol(
    fake.connection,
    signer,
    Keypair.generate().publicKey.toBase58(),
    25_000n,
    {
      onSigned: (attempt) => {
        persisted = true
        savedSignature = attempt.signature
        assert.equal(attempt.lastValidBlockHeight, 20)
      },
      onTerminal: () => {
        terminal = true
      },
    },
  )
  assert.equal(persisted, true)
  assert.equal(savedSignature, fake.getSentSignature())
  assert.equal(signature, savedSignature)
  assert.equal(terminal, true)
  assert.deepEqual(fake.calls, ['blockhash', 'send', 'status'])
})

test('a pending-record write failure prevents any RPC broadcast', async () => {
  const signer = Keypair.generate()
  const fake = broadcastConnection({ status: { err: null, confirmationStatus: 'confirmed' } })
  await assert.rejects(
    () =>
      sendSol(
        fake.connection,
        signer,
        Keypair.generate().publicKey.toBase58(),
        25_000n,
        { onSigned: () => { throw new Error('local persistence failed') } },
      ),
    /local persistence failed/,
  )
  assert.deepEqual(fake.calls, ['blockhash'])
})

test('a lost RPC response with an unconfirmed signature stays pending and is not reported failed', async () => {
  const signer = Keypair.generate()
  const fake = broadcastConnection({ failSend: true, status: null, height: 10 })
  let terminal = false
  await assert.rejects(
    () =>
      sendSol(fake.connection, signer, Keypair.generate().publicKey.toBase58(), 25_000n, {
        onTerminal: () => { terminal = true },
      }),
    (error: unknown) => error instanceof TxOutcomeError && error.outcome === 'pending',
  )
  assert.ok(fake.getSentSignature())
  assert.equal(terminal, false)
  assert.deepEqual(fake.calls, ['blockhash', 'send', 'status', 'height'])
})

test('processed failures are not treated as final; confirmed failures are terminal', async () => {
  const processed = {
    getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed' }] }),
  } as any
  const confirmedFailure = {
    getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] }),
  } as any
  assert.equal(await inspectTransaction(processed, 'sig', 10), 'pending')
  assert.equal(await inspectTransaction(confirmedFailure, 'sig', 10), 'failed')
})

test('expired blockhash with no history is reported as unresolved expiry, not proof of non-inclusion', async () => {
  const fake = broadcastConnection({ status: null, height: 21 })
  assert.equal(await inspectTransaction(fake.connection, 'unknown-signature', 20), 'expired')
})

test('RPC status lookup failure stays unknown', async () => {
  const fake = broadcastConnection({ failStatus: true })
  assert.equal(await inspectTransaction(fake.connection, 'unknown-signature', 20), 'unknown')
})
