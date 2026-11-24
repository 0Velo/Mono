/**
 * Area 4 — importing secrets: 12/24-word phrases, Base58 keys, address checks.
 * Malformed input must fail loudly; it must never derive a different wallet.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { Keypair } from '@solana/web3.js'
import {
  isValidAddress,
  keypairFromMnemonic,
  keypairFromPayload,
  keypairFromSecretKeyBase58,
  normalizeMnemonic,
  secretPayloadFromKeypair,
  secretPayloadFromMnemonic,
  validateMnemonic,
} from '../../../src/lib/wallet'
import { loadDerivationVectors } from './helpers'

const TWELVE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const TWENTY_FOUR = loadDerivationVectors().find((vector) => vector.name === 'bip39-test-24')!.mnemonic

test('validateMnemonic accepts 12 and 24 valid words and rejects everything else', () => {
  assert.equal(validateMnemonic(TWELVE), true)
  assert.equal(validateMnemonic(TWENTY_FOUR), true)
  // Bad checksum (last word swapped for another valid word).
  assert.equal(validateMnemonic(TWELVE.replace(/about$/, 'abandon')), false)
  // Wrong word count, unknown words, empty input, junk.
  assert.equal(validateMnemonic(TWELVE.split(' ').slice(0, 11).join(' ')), false)
  assert.equal(validateMnemonic('foo bar baz'), false)
  assert.equal(validateMnemonic(''), false)
  assert.equal(validateMnemonic('😀 😀 😀'), false)
})

test('normalizeMnemonic folds case, newlines and full-width spaces', () => {
  const messy = '  LEGAL   winner\nthank\tyear\u3000wave sausage worth useful legal winner thank yellow '
  assert.equal(
    normalizeMnemonic(messy),
    'legal winner thank year wave sausage worth useful legal winner thank yellow',
  )
  // Normalised input derives the same address as the clean phrase.
  assert.equal(
    keypairFromMnemonic(messy).publicKey.toBase58(),
    keypairFromMnemonic(normalizeMnemonic(messy)).publicKey.toBase58(),
  )
})

test('a 64-byte Base58 secret key imports and round-trips its address', () => {
  const origin = Keypair.generate()
  const encoded = bs58.encode(origin.secretKey)
  const imported = keypairFromSecretKeyBase58(encoded)
  assert.equal(imported.publicKey.toBase58(), origin.publicKey.toBase58())
  assert.equal(bs58.encode(imported.secretKey), encoded)

  const payload = secretPayloadFromKeypair(origin)
  assert.equal(payload.kind, 'secretKey')
  assert.equal(keypairFromPayload(payload).publicKey.toBase58(), origin.publicKey.toBase58())
})

test('a 32-byte Base58 seed imports as a valid keypair', () => {
  const seed = new Uint8Array(32)
  for (let index = 0; index < seed.length; index += 1) seed[index] = index + 1
  const keypair = keypairFromSecretKeyBase58(bs58.encode(seed))
  assert.equal(keypair.secretKey.length, 64)
  assert.equal(keypair.publicKey.toBase58(), Keypair.fromSeed(seed).publicKey.toBase58())
})

test('wrong-length and non-Base58 keys are rejected with a readable error', () => {
  for (const length of [16, 31, 33, 48, 63, 65]) {
    const encoded = bs58.encode(new Uint8Array(length).fill(3))
    assert.throws(() => keypairFromSecretKeyBase58(encoded), /32바이트|64바이트|Base58/, `${length} bytes`)
  }
  assert.throws(() => keypairFromSecretKeyBase58('not a key!'), /Base58/)
  assert.throws(() => keypairFromSecretKeyBase58('   '), /Base58|32바이트|64바이트/)
})

test('isValidAddress accepts real addresses and rejects malformed input', () => {
  const address = Keypair.generate().publicKey.toBase58()
  assert.equal(isValidAddress(address), true)
  assert.equal(isValidAddress(`  ${address}\n`), true)
  assert.equal(isValidAddress(''), false)
  assert.equal(isValidAddress('0OIl'), false)
  assert.equal(isValidAddress(address.slice(0, 31)), false)
  assert.equal(isValidAddress(`${address}x`), false)
  assert.equal(isValidAddress('1'.repeat(44)), false)
  // A Base58 string of the right character length that decodes to 31 bytes is
  // not a Solana address; the UI must not offer to send to it.
  const thirtyOneBytes = bs58.encode(new Uint8Array(31).fill(5))
  assert.equal(thirtyOneBytes.length >= 32 && thirtyOneBytes.length <= 44, true)
  assert.equal(isValidAddress(thirtyOneBytes), false, 'decoded length must be exactly 32 bytes')
  // 33-byte payload is also rejected.
  assert.equal(isValidAddress(bs58.encode(new Uint8Array(33).fill(5))), false)
})

test('a mnemonic-derived payload always reports the same address', () => {
  const payload = secretPayloadFromMnemonic(TWELVE)
  const first = keypairFromPayload(payload).publicKey.toBase58()
  const second = keypairFromPayload(payload).publicKey.toBase58()
  assert.equal(first, second)
  assert.equal(first, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk')
})
