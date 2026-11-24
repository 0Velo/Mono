/**
 * Shared helpers for the Mono security suite.
 *
 * Every test here asserts a security property the wallet claims to have. A
 * property that cannot be proven locally is reported as `UNVERIFIED` in the
 * audit report instead of being turned into a passing assertion.
 */
import fs from 'node:fs'
import path from 'node:path'

export const REPO_ROOT = process.cwd()

export function readRepoFile(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8')
}

export function repoFileExists(relative: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, relative))
}

export interface DerivationVector {
  name: string
  mnemonic: string
  path: string
  address: string
}

export function loadDerivationVectors(): DerivationVector[] {
  const raw = readRepoFile('scripts/security/fixtures/derivation-vectors.json')
  const parsed = JSON.parse(raw) as { vectors: DerivationVector[] }
  return parsed.vectors
}

/** base64 → bytes, browser-independent. */
export function b64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

export function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/** Flips one bit of a base64 payload and returns the new base64 string. */
export function corruptBase64(value: string, byteOffsetFromEnd = 1): string {
  const bytes = b64ToBytes(value)
  const index = bytes.length - byteOffsetFromEnd
  bytes[index] = bytes[index] ^ 0x01
  return bytesToB64(bytes)
}
