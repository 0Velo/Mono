/**
 * Area 5 — transaction building and fee arithmetic.
 *
 * No network: a fake Connection answers the few reads the builders make, so the
 * tests prove the wallet's own logic (validation order, fee/rent maths) rather
 * than an RPC's behaviour.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  ATA_RENT_LAMPORTS,
  BASE_FEE_LAMPORTS,
  estimateFee,
  maxTransferableSol,
  sendSol,
  sendSplToken,
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
  const plain = fakeConnection(1_000_000_000)

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
