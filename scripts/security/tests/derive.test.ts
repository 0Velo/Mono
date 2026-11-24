/**
 * Area 2 + 4 — SLIP-0010 derivation and multi-account paths.
 *
 * The expected addresses come from `scripts/security/oracle/slip10_oracle.py`,
 * an independent BIP39 + SLIP-0010 implementation in Python, so the wallet is
 * checked against the specification rather than against itself. The first
 * vector (abandon … about at m/44'/501'/0'/0') is the widely published Phantom
 * address for that phrase.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DERIVATION_PATH,
  accountPath,
  deriveAccounts,
  keypairForAccount,
  keypairFromMnemonic,
  secretPayloadFromMnemonic,
} from '../../../src/lib/wallet'
import { deriveEd25519Seed, parseDerivationPath } from '../../../src/lib/derive'
import { loadDerivationVectors } from './helpers'

test('DEFAULT_DERIVATION_PATH is the Phantom-compatible hardened path', () => {
  assert.equal(DEFAULT_DERIVATION_PATH, "m/44'/501'/0'/0'")
})

test('derived addresses match the independent Python oracle for 12 and 24 words', () => {
  const vectors = loadDerivationVectors()
  assert.ok(vectors.length >= 9, 'fixture file must carry the oracle vectors')
  for (const vector of vectors) {
    const keypair = keypairFromMnemonic(vector.mnemonic, vector.path)
    assert.equal(
      keypair.publicKey.toBase58(),
      vector.address,
      `${vector.name} ${vector.path} must derive ${vector.address}`,
    )
  }
})

test('the well-known BIP39 test phrase derives the published Phantom address', () => {
  const mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  const keypair = keypairFromMnemonic(mnemonic)
  assert.equal(keypair.publicKey.toBase58(), 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk')
})

test('accountPath hardens both the 501 and the account index', () => {
  assert.equal(accountPath(0), "m/44'/501'/0'/0'")
  assert.equal(accountPath(3), "m/44'/501'/3'/0'")
  assert.equal(accountPath(-5), "m/44'/501'/0'/0'")
  assert.equal(accountPath(2.9), "m/44'/501'/2'/0'")
})

test('deriveAccounts derives exactly what keypairForAccount derives, per index', () => {
  const mnemonic = loadDerivationVectors()[0].mnemonic
  const indices = [0, 1, 2, 7]
  const batch = deriveAccounts(mnemonic, indices).map((keypair) => keypair.publicKey.toBase58())
  const single = indices.map((index) => keypairForAccount(mnemonic, index).publicKey.toBase58())
  assert.deepEqual(batch, single)
  assert.equal(new Set(batch).size, indices.length, 'each account index must give a distinct address')
})

test('parseDerivationPath rejects non-numeric and out-of-range segments', () => {
  assert.deepEqual(parseDerivationPath("m/44'/501'/0'/0'"), [
    0x80000000 + 44,
    0x80000000 + 501,
    0x80000000 + 0,
    0x80000000 + 0,
  ])
  for (const bad of ["m/44'/abc'/0'", "m/44'/-1'/0'", "m/44'/2147483648'/0'", 'm/44/1.5']) {
    assert.throws(() => parseDerivationPath(bad), /Invalid derivation path segment/, bad)
  }
})

test('ed25519 derivation refuses non-hardened segments (SLIP-0010 has no public derivation)', () => {
  const seed = new Uint8Array(64).fill(7)
  // A non-hardened segment would silently produce a key no other wallet can
  // reproduce; it must be an error, not a different address.
  assert.throws(
    () => deriveEd25519Seed(seed, "m/44'/501'/0'/0"),
    /hardened|Invalid|ed25519/i,
    'non-hardened segment must not derive a key',
  )
  assert.throws(() => deriveEd25519Seed(seed, 'm/44/501'), /hardened|Invalid|ed25519/i)
  assert.doesNotThrow(() => deriveEd25519Seed(seed, "m/44'/501'/0'/0'"))
})

test('secretPayloadFromMnemonic stores the hardened Phantom path', () => {
  const payload = secretPayloadFromMnemonic('  Legal  WINNER thank year wave sausage worth useful legal winner thank yellow ')
  assert.equal(payload.kind, 'mnemonic')
  if (payload.kind !== 'mnemonic') return
  assert.equal(payload.path, "m/44'/501'/0'/0'")
  assert.equal(payload.path, DEFAULT_DERIVATION_PATH)
  // Normalised to lower case and single spaces.
  assert.ok(!payload.mnemonic.includes('  '))
  assert.ok(payload.mnemonic.startsWith('legal winner'))
})
