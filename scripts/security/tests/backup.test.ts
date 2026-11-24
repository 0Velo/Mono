/**
 * Area 4 — encrypted backup files: no plaintext secrets, tamper evident,
 * restore round-trip.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  backupFileName,
  buildBackupFile,
  parseBackupFile,
} from '../../../src/lib/backup'
import { InvalidPinError, decryptSecret, encryptSecret, type SecretPayload } from '../../../src/lib/vault'
import { keypairFromPayload } from '../../../src/lib/wallet'
import { corruptBase64 } from './helpers'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PIN = '135790'
const payload: SecretPayload = { kind: 'mnemonic', mnemonic: MNEMONIC, path: "m/44'/501'/0'/0'" }

test('an exported backup file contains no seed words, key material or PIN', async () => {
  const vault = await encryptSecret(payload, PIN)
  const address = keypairFromPayload(payload).publicKey.toBase58()
  const file = buildBackupFile(vault, address)
  const json = JSON.stringify(file, null, 2)

  assert.ok(!json.includes(MNEMONIC))
  for (const word of MNEMONIC.split(' ').filter((word) => word !== 'abandon')) {
    assert.ok(!json.includes(word), `backup leaked the word ${word}`)
  }
  assert.ok(!json.includes('secretKey'))
  assert.ok(!/"mnemonic"\s*:/.test(json))
  assert.ok(!/"pin"|"passphrase"/i.test(json), 'PIN must not be stored')
  // The address is public on-chain, so it identifies the file without a secret.
  assert.equal(file.address, address)
  assert.equal(file.app, 'mono')
  assert.equal(file.kind, 'mono-backup')
})

test('export → parse → decrypt reproduces the original secret payload', async () => {
  const vault = await encryptSecret(payload, PIN)
  const text = JSON.stringify(buildBackupFile(vault, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'))
  const parsed = parseBackupFile(text)
  assert.equal(parsed.address, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk')
  assert.equal(parsed.vault.iter, 210_000)
  assert.equal(parsed.vault.salt, vault.salt)
  assert.equal(parsed.vault.iv, vault.iv)
  assert.equal(parsed.vault.ct, vault.ct)
  const restored = await decryptSecret(parsed.vault, PIN)
  assert.deepEqual(restored, payload)
  assert.equal(keypairFromPayload(restored).publicKey.toBase58(), parsed.address)
})

test('a wrong PIN cannot restore a backup file', async () => {
  const vault = await encryptSecret(payload, PIN)
  const parsed = parseBackupFile(JSON.stringify(buildBackupFile(vault)))
  await assert.rejects(() => decryptSecret(parsed.vault, '000000'), InvalidPinError)
})

test('a tampered backup ciphertext is rejected on restore', async () => {
  const vault = await encryptSecret(payload, PIN)
  const file = buildBackupFile(vault)
  const tampered = JSON.stringify({ ...file, ct: corruptBase64(file.ct, 1) })
  const parsed = parseBackupFile(tampered)
  await assert.rejects(() => decryptSecret(parsed.vault, PIN), InvalidPinError)
})

test('a backup whose iteration count was lowered to speed up brute force still fails', async () => {
  const vault = await encryptSecret(payload, PIN)
  const file = buildBackupFile(vault)
  const parsed = parseBackupFile(JSON.stringify({ ...file, iter: 1 }))
  await assert.rejects(() => decryptSecret(parsed.vault, PIN), InvalidPinError)
})

test('non-backup files are rejected with a readable message', () => {
  assert.throws(() => parseBackupFile('not json at all'), /JSON/)
  assert.throws(() => parseBackupFile('{}'), /Mono 백업/)
  assert.throws(() => parseBackupFile('"a string"'), /Mono 백업/)
  assert.throws(
    () => parseBackupFile(JSON.stringify({ v: 1, salt: 'x', iv: 'y', ct: 'z', iter: 1, app: 'other-wallet' })),
    /Mono 백업/,
  )
})

test('the backup file name is date-stamped and .json', () => {
  assert.match(backupFileName(new Date(2026, 10, 25)), /^mono-backup-20261125\.json$/)
})
