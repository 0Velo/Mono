/**
 * Local secret storage.
 *
 * The mnemonic / secret key never leaves the device: it is encrypted with a
 * key derived from the user's 6-digit PIN via PBKDF2-SHA256 (210k rounds) and
 * sealed with AES-256-GCM before it is written to localStorage.
 */
import { normalizePayloadPath } from './paths'

export type SecretPayload =
  | { kind: 'mnemonic'; mnemonic: string; path: string }
  | { kind: 'secretKey'; secretKey: string; path: string }

export interface Vault {
  v: 1
  alg: 'AES-GCM'
  kdf: 'PBKDF2-SHA256'
  iter: number
  salt: string
  iv: string
  ct: string
  createdAt: number
}

const ITERATIONS = 210_000
const SALT_BYTES = 16
const IV_BYTES = 12

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** Copy into a plain ArrayBuffer so WebCrypto accepts it under every TS lib. */
function buf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function deriveAesKey(pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', buf(new TextEncoder().encode(pin)), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: buf(salt), iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptSecret(payload: SecretPayload, pin: string): Promise<Vault> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveAesKey(pin, salt, ITERATIONS)
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(plaintext))
  return {
    v: 1,
    alg: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iter: ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ciphertext)),
    createdAt: Date.now(),
  }
}

export class InvalidPinError extends Error {
  constructor() {
    super('invalid pin')
    this.name = 'InvalidPinError'
  }
}

/** The vault opened but does not hold a secret payload (corrupt or foreign file). */
export class VaultFormatError extends Error {
  constructor(message = '지갑 데이터를 읽을 수 없습니다.') {
    super(message)
    this.name = 'VaultFormatError'
  }
}

function assertPayload(value: unknown): SecretPayload {
  const candidate = value as Partial<SecretPayload> | null
  if (!candidate || typeof candidate !== 'object') throw new VaultFormatError()
  if (candidate.kind === 'mnemonic' && typeof candidate.mnemonic === 'string' && candidate.mnemonic.trim()) {
    return normalizePayloadPath({ ...candidate, kind: 'mnemonic', mnemonic: candidate.mnemonic }) as SecretPayload
  }
  if (candidate.kind === 'secretKey' && typeof candidate.secretKey === 'string' && candidate.secretKey.trim()) {
    return normalizePayloadPath({ ...candidate, kind: 'secretKey', secretKey: candidate.secretKey }) as SecretPayload
  }
  throw new VaultFormatError()
}

export async function decryptSecret(vault: Vault, pin: string): Promise<SecretPayload> {
  const key = await deriveAesKey(pin, fromBase64(vault.salt), vault.iter)
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf(fromBase64(vault.iv)) },
      key,
      buf(fromBase64(vault.ct)),
    )
    return assertPayload(JSON.parse(new TextDecoder().decode(plaintext)))
  } catch {
    throw new InvalidPinError()
  }
}

export function isVaultShape(value: unknown): value is Vault {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.v === 1 &&
    typeof v.salt === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.ct === 'string' &&
    typeof v.iter === 'number'
  )
}
