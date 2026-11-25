import * as bip39 from 'bip39'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { deriveEd25519Seed } from './derive'
import { DEFAULT_DERIVATION_PATH, accountPath, normalizePayloadPath } from './paths'
import { mnemonicWords, normalizeMnemonic } from './words'
import type { SecretPayload } from './vault'

export { DEFAULT_DERIVATION_PATH, accountPath, mnemonicWords, normalizeMnemonic }
export type { Keypair }

export function generateMnemonic(words: 12 | 24 = 12): string {
  return bip39.generateMnemonic(words === 24 ? 256 : 128)
}

export function validateMnemonic(input: string): boolean {
  try {
    const normalized = normalizeMnemonic(input)
    const count = normalized.split(' ').length
    if (count !== 12 && count !== 24) return false
    return bip39.validateMnemonic(normalized)
  } catch {
    return false
  }
}

export function keypairFromMnemonic(mnemonic: string, path = DEFAULT_DERIVATION_PATH): Keypair {
  const seed = bip39.mnemonicToSeedSync(normalizeMnemonic(mnemonic))
  // Both buffers are wiped as soon as the keypair has copied what it needs; a
  // garbage collected string is not a wiped secret, an overwritten array is.
  const seedBytes = new Uint8Array(seed)
  const privateSeed = deriveEd25519Seed(seedBytes, path)
  try {
    return Keypair.fromSeed(privateSeed)
  } finally {
    privateSeed.fill(0)
    seedBytes.fill(0)
  }
}

/** Phantom-style additional accounts: m/44'/501'/index'/0'. */
export function keypairForAccount(mnemonic: string, index: number): Keypair {
  return keypairFromMnemonic(mnemonic, accountPath(index))
}

/**
 * Derives several accounts from one seed in a single pass — mnemonicToSeed is
 * the expensive part, so it runs once per unlock rather than once per account.
 */
export function deriveAccounts(
  mnemonic: string,
  indices: number[],
  accountZeroPath = DEFAULT_DERIVATION_PATH,
): Keypair[] {
  const seed = bip39.mnemonicToSeedSync(normalizeMnemonic(mnemonic))
  const seedBytes = new Uint8Array(seed)
  try {
    return indices.map((index) => {
      const path = index === 0 ? normalizePayloadPath({ path: accountZeroPath }).path! : accountPath(index)
      const privateSeed = deriveEd25519Seed(seedBytes, path)
      try {
        return Keypair.fromSeed(privateSeed)
      } finally {
        privateSeed.fill(0)
      }
    })
  } finally {
    seedBytes.fill(0)
  }
}

export function keypairFromSecretKeyBase58(secret: string): Keypair {
  const trimmed = secret.trim()
  let raw: Uint8Array
  try {
    raw = bs58.decode(trimmed)
  } catch {
    throw new Error('Base58 형식이 아닙니다.')
  }
  if (raw.length === 64) return Keypair.fromSecretKey(raw)
  if (raw.length === 32) return Keypair.fromSeed(raw)
  throw new Error('개인키는 32바이트 시드 또는 64바이트 키여야 합니다.')
}

export function keypairFromPayload(payload: SecretPayload): Keypair {
  const safe = normalizePayloadPath(payload)
  if (safe.kind === 'mnemonic') return keypairFromMnemonic(safe.mnemonic, safe.path)
  return keypairFromSecretKeyBase58(safe.secretKey)
}

export function secretPayloadFromMnemonic(mnemonic: string): SecretPayload {
  return { kind: 'mnemonic', mnemonic: normalizeMnemonic(mnemonic), path: DEFAULT_DERIVATION_PATH }
}

export function secretPayloadFromKeypair(keypair: Keypair): SecretPayload {
  return {
    kind: 'secretKey',
    secretKey: bs58.encode(keypair.secretKey),
    path: DEFAULT_DERIVATION_PATH,
  }
}

export function isValidAddress(address: string): boolean {
  try {
    const value = address.trim()
    // Solana addresses are a Base58-encoded 32-byte public key: 32-44
    // characters, but the decoded length is what actually matters. A 43-char
    // string that decodes to 31 bytes is not an address and must not be
    // offered as a recipient.
    if (value.length < 32 || value.length > 44) return false
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false
    return bs58.decode(value).length === 32
  } catch {
    return false
  }
}

export function addressPayload(payload: SecretPayload): string {
  return keypairFromPayload(payload).publicKey.toBase58()
}
