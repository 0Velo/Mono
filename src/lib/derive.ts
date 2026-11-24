/**
 * SLIP-0010 ed25519 hierarchical deterministic derivation.
 *
 * Phantom / Solflare derive the first account at `m/44'/501'/0'/0'` for every
 * seed phrase, so implementing the standard directly (instead of a wrapper
 * library) keeps the browser bundle small and auditable, and guarantees the
 * same address for the same 12/24 words.
 */
import { hmac } from '@noble/hashes/hmac'
import { sha512 } from '@noble/hashes/sha512'
import { utf8ToBytes } from '@noble/hashes/utils'

const HARDENED_OFFSET = 0x80000000

export function parseDerivationPath(path: string): number[] {
  const body = path.trim().replace(/^m\/?/, '')
  if (!body) return []
  return body.split('/').map((segment) => {
    const hardened = segment.endsWith("'") || segment.endsWith('h') || segment.endsWith('H')
    const raw = hardened ? segment.slice(0, -1) : segment
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0 || n >= HARDENED_OFFSET) {
      throw new Error(`Invalid derivation path segment: ${segment}`)
    }
    return hardened ? n + HARDENED_OFFSET : n
  })
}

/** Returns the 32-byte ed25519 private seed for the path. */
export function deriveEd25519Seed(seed: Uint8Array, path: string): Uint8Array {
  let digest = hmac(sha512, utf8ToBytes('ed25519 seed'), seed)
  let key = digest.slice(0, 32)
  let chainCode = digest.slice(32)

  for (const index of parseDerivationPath(path)) {
    // ed25519 only supports hardened derivation: 0x00 || key || ser32(index)
    const data = new Uint8Array(37)
    data[0] = 0
    data.set(key, 1)
    new DataView(data.buffer).setUint32(33, index >>> 0, false)
    digest = hmac(sha512, chainCode, data)
    key = digest.slice(0, 32)
    chainCode = digest.slice(32)
  }

  return key
}
