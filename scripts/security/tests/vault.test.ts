/**
 * Area 1 + 2 — vault format, PBKDF2 parameters, AES-256-GCM integrity.
 *
 * These run the real `src/lib/vault.ts` through WebCrypto (Node's global
 * `crypto.subtle`), not a re-implementation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  InvalidPinError,
  VaultFormatError,
  decryptSecret,
  encryptSecret,
  isVaultShape,
  type SecretPayload,
  type Vault,
} from '../../../src/lib/vault'
import { corruptBase64 } from './helpers'

const PAYLOAD: SecretPayload = {
  kind: 'mnemonic',
  mnemonic:
    'legal winner thank year wave sausage worth useful legal winner thank yellow',
  path: "m/44'/501'/0'/0'",
}

const PIN = '284917'

test('vault declares PBKDF2-SHA256 with 210,000 iterations, 16-byte salt, 12-byte IV', async () => {
  const vault = await encryptSecret(PAYLOAD, PIN)
  assert.equal(vault.v, 1)
  assert.equal(vault.alg, 'AES-GCM')
  assert.equal(vault.kdf, 'PBKDF2-SHA256')
  assert.equal(vault.iter, 210_000)
  assert.equal(Buffer.from(vault.salt, 'base64').length, 16)
  assert.equal(Buffer.from(vault.iv, 'base64').length, 12)
  // AES-GCM ciphertext = plaintext + 16-byte authentication tag.
  const plaintextLength = Buffer.byteLength(JSON.stringify(PAYLOAD))
  assert.equal(Buffer.from(vault.ct, 'base64').length, plaintextLength + 16)
})

test('encrypt → decrypt round-trips the exact payload', async () => {
  const vault = await encryptSecret(PAYLOAD, PIN)
  const restored = await decryptSecret(vault, PIN)
  assert.deepEqual(restored, PAYLOAD)
})

test('a wrong PIN is rejected with InvalidPinError and yields no payload', async () => {
  const vault = await encryptSecret(PAYLOAD, PIN)
  for (const wrong of ['000000', '284918', '28491', '']) {
    await assert.rejects(
      () => decryptSecret(vault, wrong),
      (error: unknown) => {
        assert.ok(error instanceof InvalidPinError, 'expected InvalidPinError')
        assert.equal((error as Error).name, 'InvalidPinError')
        return true
      },
      `PIN ${JSON.stringify(wrong)} must not open the vault`,
    )
  }
})

test('a tampered authentication tag (last ciphertext byte) throws instead of returning data', async () => {
  const vault = await encryptSecret(PAYLOAD, PIN)
  const tampered: Vault = { ...vault, ct: corruptBase64(vault.ct, 1) }
  await assert.rejects(() => decryptSecret(tampered, PIN), InvalidPinError)
})

test('a tampered ciphertext body throws', async () => {
  const vault = await encryptSecret(PAYLOAD, PIN)
  const tampered: Vault = { ...vault, ct: corruptBase64(vault.ct, 20) }
  await assert.rejects(() => decryptSecret(tampered, PIN), InvalidPinError)
})

test('a tampered IV throws (GCM must not open with the wrong nonce)', async () => {
  const vault = await encryptSecret(PAYLOAD, PIN)
  const tampered: Vault = { ...vault, iv: corruptBase64(vault.iv, 1) }
  await assert.rejects(() => decryptSecret(tampered, PIN), InvalidPinError)
})

test('a tampered salt throws (key derivation must not silently succeed)', async () => {
  const vault = await encryptSecret(PAYLOAD, PIN)
  const tampered: Vault = { ...vault, salt: corruptBase64(vault.salt, 1) }
  await assert.rejects(() => decryptSecret(tampered, PIN), InvalidPinError)
})

test('a downgraded or excessive iteration count is rejected before expensive derivation', async () => {
  const vault = await encryptSecret(PAYLOAD, PIN)
  const tampered: Vault = { ...vault, iter: 1_000 }
  await assert.rejects(() => decryptSecret(tampered, PIN), VaultFormatError)
  await assert.rejects(
    () => decryptSecret({ ...vault, iter: Number.MAX_SAFE_INTEGER }, PIN),
    VaultFormatError,
  )
})

test('a truncated ciphertext throws instead of returning a partial payload', async () => {
  const vault = await encryptSecret(PAYLOAD, PIN)
  const bytes = Buffer.from(vault.ct, 'base64').subarray(0, 8)
  await assert.rejects(
    () => decryptSecret({ ...vault, ct: bytes.toString('base64') }, PIN),
    VaultFormatError,
  )
})

test('IV and salt are fresh for every vault (no key/nonce reuse)', async () => {
  const ivs = new Set<string>()
  const salts = new Set<string>()
  const count = 40
  for (let index = 0; index < count; index += 1) {
    const vault = await encryptSecret(PAYLOAD, PIN)
    ivs.add(vault.iv)
    salts.add(vault.salt)
  }
  assert.equal(ivs.size, count, 'every encryption must use a new 96-bit IV')
  assert.equal(salts.size, count, 'every vault must use a new salt')
})

test('the vault never contains the mnemonic in clear text', async () => {
  const vault = await encryptSecret(PAYLOAD, PIN)
  const serialized = JSON.stringify(vault)
  for (const word of PAYLOAD.mnemonic.split(' ')) {
    // A single BIP39 word could appear by chance in base64; a 4+ word run cannot.
    assert.ok(!serialized.includes(word), `vault leaked the word ${word}`)
  }
  assert.ok(!serialized.includes(PAYLOAD.mnemonic))
  assert.ok(!Buffer.from(vault.ct, 'base64').toString('utf8').includes('legal winner'))
})

test('isVaultShape accepts a real vault and rejects malformed records', async () => {
  const vault = await encryptSecret(PAYLOAD, PIN)
  assert.ok(isVaultShape(vault))
  const cases: unknown[] = [
    null,
    {},
    { ...vault, v: 2 },
    { ...vault, salt: 1 },
    { ...vault, iv: undefined },
    { ...vault, ct: null },
    { ...vault, iter: '210000' },
    { ...vault, alg: 'AES-CBC' },
    { ...vault, kdf: 'scrypt' },
    { ...vault, salt: 'not-base64' },
    'string',
    [],
  ]
  for (const candidate of cases) {
    assert.equal(isVaultShape(candidate), false, `must reject ${JSON.stringify(candidate)}`)
  }
})
