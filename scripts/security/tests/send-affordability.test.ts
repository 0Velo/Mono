/**
 * Area 5 — sending a token must be affordable before the button is enabled.
 *
 * A token balance says nothing about the SOL that pays the network fee and, for
 * a recipient without a token account, the ~0.00204 SOL rent. The old check
 * compared only token amounts and let a "send" through that could only fail at
 * the RPC.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ATA_RENT_LAMPORTS, BASE_FEE_LAMPORTS, assessSend } from '../../../src/lib/tx'

const FEE = BASE_FEE_LAMPORTS

test('SOL: a send is affordable only if the amount plus the fee fits', () => {
  assert.equal(
    assessSend({ kind: 'sol', amount: 995_000n, balance: 1_000_000n, solBalance: 1_000_000n, feeLamports: FEE, rentLamports: 0n }).ok,
    true,
  )
  const tooMuch = assessSend({
    kind: 'sol',
    amount: 1_000_000n,
    balance: 1_000_000n,
    solBalance: 1_000_000n,
    feeLamports: FEE,
    rentLamports: 0n,
  })
  assert.equal(tooMuch.ok, false)
  assert.equal(tooMuch.reason, 'insufficient-fee')
  assert.equal(tooMuch.shortfallLamports, FEE)
})

test('SOL: more than the balance is the asset shortfall, not the fee', () => {
  const result = assessSend({ kind: 'sol', amount: 2n, balance: 1n, solBalance: 1_000n, feeLamports: FEE, rentLamports: 0n })
  assert.equal(result.reason, 'insufficient-asset')
})

test('a zero or negative amount is refused', () => {
  assert.equal(assessSend({ kind: 'sol', amount: 0n, balance: 10n, solBalance: 10n, feeLamports: FEE, rentLamports: 0n }).reason, 'amount')
  assert.equal(assessSend({ kind: 'spl', amount: -1n, balance: 10n, solBalance: 10n, feeLamports: FEE, rentLamports: 0n }).reason, 'amount')
})

test('SPL: sending the whole token balance needs SOL for the fee and the new token account', () => {
  // The exact case that used to pass: full token balance, no SOL at all.
  const noSol = assessSend({
    kind: 'spl',
    amount: 1_000_000n,
    balance: 1_000_000n,
    solBalance: 0n,
    feeLamports: FEE,
    rentLamports: ATA_RENT_LAMPORTS,
  })
  assert.equal(noSol.ok, false)
  assert.equal(noSol.reason, 'insufficient-fee')
  assert.equal(noSol.shortfallLamports, FEE + ATA_RENT_LAMPORTS)

  // Fee only, recipient already has an account.
  assert.equal(
    assessSend({ kind: 'spl', amount: 1n, balance: 1n, solBalance: FEE, feeLamports: FEE, rentLamports: 0n }).ok,
    true,
  )

  // Enough for the fee but not for the rent.
  const noRent = assessSend({
    kind: 'spl',
    amount: 1n,
    balance: 1n,
    solBalance: FEE,
    feeLamports: FEE,
    rentLamports: ATA_RENT_LAMPORTS,
  })
  assert.equal(noRent.ok, false)
  assert.equal(noRent.reason, 'insufficient-fee')

  // Enough for both.
  assert.equal(
    assessSend({
      kind: 'spl',
      amount: 1n,
      balance: 1n,
      solBalance: FEE + ATA_RENT_LAMPORTS,
      feeLamports: FEE,
      rentLamports: ATA_RENT_LAMPORTS,
    }).ok,
    true,
  )
})

test('SPL: a token amount above the balance is rejected before the fee is considered', () => {
  const result = assessSend({
    kind: 'spl',
    amount: 2n,
    balance: 1n,
    solBalance: 0n,
    feeLamports: FEE,
    rentLamports: ATA_RENT_LAMPORTS,
  })
  assert.equal(result.reason, 'insufficient-asset')
})

test('the source uses the shared affordability check, not an inline balance compare', async () => {
  const fs = await import('node:fs')
  const source = fs.readFileSync('src/sheets/SendSheet.tsx', 'utf8')
  assert.match(source, /assessSend/)
  assert.ok(!/baseUnits \+ BASE_FEE_LAMPORTS > asset\.amount/.test(source))
})
