import * as bip39 from 'bip39'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { deriveEd25519Seed } from './derive'
import { mnemonicWords, normalizeMnemonic } from './words'
import type { SecretPayload } from './vault'

/** Phantom-compatible first account path. */
export const DEFAULT_DERIVATION_PATH = "m/44'/501'/0'/0'"

export { mnemonicWords, normalizeMnemonic }

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
  const privateSeed = deriveEd25519Seed(new Uint8Array(seed), path)
  return Keypair.fromSeed(privateSeed)
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
  if (payload.kind === 'mnemonic') return keypairFromMnemonic(payload.mnemonic, payload.path)
  return keypairFromSecretKeyBase58(payload.secretKey)
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
    if (value.length < 32 || value.length > 44) return false
    bs58.decode(value)
    return true
  } catch {
    return false
  }
}

export function addressPayload(payload: SecretPayload): string {
  return keypairFromPayload(payload).publicKey.toBase58()
}
