/**
 * Face ID / Touch ID unlock through the platform authenticator (WebAuthn).
 *
 * The wallet key is never stored in the clear. Two sealing modes exist, and the
 * enrolment picks whichever the device can actually do:
 *
 *  1. **PRF** (preferred) — the authenticator returns a stable secret for an
 *     evaluation salt we choose. HKDF derives an AES-256-GCM key from it, so
 *     Face ID alone unwraps the payload and nothing recoverable is persisted.
 *  2. **Device key** (fallback, and what iOS Safari / standalone actually
 *     does) — the browser hands back no PRF output, so we generate a random
 *     AES-256-GCM key that is **non-extractable** and keep it in IndexedDB.
 *     It is only ever used after `navigator.credentials.get()` has succeeded
 *     with a platform assertion (`userVerification: 'required'`), i.e. after
 *     Face ID has actually been presented.
 *
 * Availability is deliberately a single check — the platform authenticator —
 * so a device is never told "not supported" just because PRF is missing.
 * Cancelling or failing always falls back to the PIN.
 */

import type { SecretPayload } from './vault'
import { STORE_KEYS, idbDelete, idbGet, idbSet } from './idb'

const RECORD_KEY = 'mono.faceid.v2'
const LEGACY_RECORD_KEY = 'solwallet.faceid.v1'
const WRAP_KEY_ID = 'faceid-wrap.v2'
const RP_NAME = 'Mono'
const HKDF_SALT = new TextEncoder().encode('mono/faceid/v2')
const HKDF_INFO = new TextEncoder().encode('aes-256-gcm/payload')

export type BiometricMode = 'prf' | 'device'

export interface BiometricRecord {
  v: 2
  mode: BiometricMode
  /** base64url of the credential rawId */
  credentialId: string
  /** base64url of the 32-byte PRF evaluation salt */
  prfSalt: string
  /** base64url AES-GCM iv */
  iv: string
  /** base64url AES-GCM ciphertext of the secret payload */
  ct: string
  createdAt: number
}

export type BiometricFailureReason =
  | 'unsupported'
  | 'cancelled'
  | 'prf'
  | 'corrupt'
  | 'blocked'
  | 'error'

export class BiometricError extends Error {
  reason: BiometricFailureReason
  constructor(reason: BiometricFailureReason, message: string) {
    super(message)
    this.name = 'BiometricError'
    this.reason = reason
  }
}

/* ------------------------------------------------------------------ bytes */

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '==='.slice((padded.length + 3) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

/** Copy into a plain ArrayBuffer so WebCrypto accepts it under every TS lib. */
function buf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

/* ----------------------------------------------------------------- device */

/**
 * True when this device has a platform authenticator (Face ID / Touch ID).
 * Nothing about PRF, `getClientCapabilities`, or extension support is required
 * here — those decide *how* we seal, not *whether* Face ID exists.
 */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  try {
    if (typeof window === 'undefined') return false
    if (!window.isSecureContext) return false
    const api = window.PublicKeyCredential as typeof PublicKeyCredential | undefined
    if (!api || typeof api.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false
    return await api.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

export function biometricSupportedByBrowser(): boolean {
  return typeof window !== 'undefined' && Boolean(window.PublicKeyCredential)
}

/* ----------------------------------------------------------------- record */

export function readRecord(): BiometricRecord | null {
  try {
    const raw = localStorage.getItem(RECORD_KEY) ?? localStorage.getItem(LEGACY_RECORD_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      v?: number
      mode?: string
      credentialId?: unknown
      prfSalt?: unknown
      iv?: unknown
      ct?: unknown
      createdAt?: unknown
    }
    if (
      (parsed?.v !== 1 && parsed?.v !== 2) ||
      typeof parsed.credentialId !== 'string' ||
      typeof parsed.prfSalt !== 'string' ||
      typeof parsed.iv !== 'string' ||
      typeof parsed.ct !== 'string'
    ) {
      return null
    }
    // A v1 record was always PRF-sealed.
    return {
      v: 2,
      mode: parsed.mode === 'device' ? 'device' : 'prf',
      credentialId: parsed.credentialId,
      prfSalt: parsed.prfSalt,
      iv: parsed.iv,
      ct: parsed.ct,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    }
  } catch {
    return null
  }
}

export function hasEnrolment(): boolean {
  return readRecord() !== null
}

export function clearEnrolment(): void {
  try {
    localStorage.removeItem(RECORD_KEY)
    localStorage.removeItem(LEGACY_RECORD_KEY)
  } catch {
    /* private mode */
  }
  void idbDelete(STORE_KEYS, WRAP_KEY_ID).catch(() => undefined)
}

/* --------------------------------------------------------------- webauthn */

function mapError(error: unknown): BiometricError {
  const name = (error as { name?: string } | null)?.name ?? ''
  const message = String((error as { message?: string } | null)?.message ?? '')
  if (name === 'NotAllowedError' || name === 'AbortError') {
    // iOS reports "cancelled", a timeout, and "blocked" all the same way.
    if (/timeout|timed out/i.test(message)) {
      return new BiometricError(
        'cancelled',
        'Face ID 응답이 없어 취소되었습니다. 다시 시도하거나 PIN을 사용하세요.',
      )
    }
    return new BiometricError(
      'cancelled',
      'Face ID 인증이 취소되었습니다. 다시 시도하거나 PIN을 사용하세요.',
    )
  }
  if (name === 'SecurityError') {
    return new BiometricError(
      'blocked',
      '이 사이트에서 생체 인증이 차단되어 있습니다. Safari 설정에서 허용한 뒤 다시 시도하세요.',
    )
  }
  if (name === 'NotSupportedError' || name === 'InvalidStateError') {
    return new BiometricError(
      'cancelled',
      'Face ID를 다시 등록해 주세요. 기기에 저장된 인증 정보가 만료되었습니다.',
    )
  }
  return new BiometricError('error', 'Face ID 인증에 실패했습니다. PIN을 사용해 주세요.')
}

function prfInput(salt: Uint8Array) {
  return { prf: { eval: { first: buf(salt) } } } as unknown as AuthenticationExtensionsClientInputs
}

interface PrfResults {
  enabled?: boolean
  results?: { first?: ArrayBuffer }
}

function prfExtension(credential: PublicKeyCredential): PrfResults {
  try {
    const results = credential.getClientExtensionResults() as unknown as { prf?: PrfResults }
    return results?.prf ?? {}
  } catch {
    return {}
  }
}

function prfOutput(credential: PublicKeyCredential): Uint8Array | null {
  const first = prfExtension(credential).results?.first
  return first ? new Uint8Array(first) : null
}

async function createCredential(salt: Uint8Array): Promise<PublicKeyCredential> {
  const options = {
    publicKey: {
      challenge: buf(randomBytes(32)),
      rp: { id: location.hostname, name: RP_NAME },
      user: {
        id: buf(randomBytes(16)),
        name: 'mono-wallet',
        displayName: RP_NAME,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        requireResidentKey: false,
        userVerification: 'required',
      },
      timeout: 60_000,
      attestation: 'none',
      extensions: prfInput(salt),
    } as unknown as PublicKeyCredentialCreationOptions,
  }
  const credential = (await navigator.credentials.create(options)) as PublicKeyCredential | null
  if (!credential) throw new BiometricError('cancelled', 'Face ID 등록이 취소되었습니다.')
  return credential
}

async function getAssertion(credentialId: string, salt: Uint8Array): Promise<PublicKeyCredential> {
  const options = {
    publicKey: {
      challenge: buf(randomBytes(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: buf(fromBase64Url(credentialId)) }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: prfInput(salt),
    } as unknown as PublicKeyCredentialRequestOptions,
  }
  const assertion = (await navigator.credentials.get(options)) as PublicKeyCredential | null
  if (!assertion) throw new BiometricError('cancelled', 'Face ID 인증이 취소되었습니다.')
  return assertion
}

/* ------------------------------------------------------------------ crypt */

async function keyFromPrf(secret: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', buf(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(HKDF_SALT), info: buf(HKDF_INFO) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** A random AES key that cannot be exported and lives only in IndexedDB. */
async function createDeviceKey(): Promise<CryptoKey> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  await idbSet(STORE_KEYS, WRAP_KEY_ID, key)
  return key
}

async function readDeviceKey(): Promise<CryptoKey | null> {
  try {
    const key = await idbGet<CryptoKey>(STORE_KEYS, WRAP_KEY_ID)
    return key && (key as CryptoKey).type === 'secret' ? (key as CryptoKey) : null
  } catch {
    return null
  }
}

function writeRecord(record: BiometricRecord): void {
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(record))
    localStorage.removeItem(LEGACY_RECORD_KEY)
  } catch {
    throw new BiometricError('error', 'Face ID 정보를 저장하지 못했습니다.')
  }
}

/* -------------------------------------------------------------------- api */

/**
 * Registers this device's Face ID and seals `payload` behind it.
 * Throws `BiometricError` with a reason the UI can explain.
 */
export async function enrol(payload: SecretPayload): Promise<BiometricRecord> {
  if (!biometricSupportedByBrowser()) {
    throw new BiometricError('unsupported', '이 브라우저는 생체 인증을 지원하지 않습니다.')
  }
  if (!(await isPlatformAuthenticatorAvailable())) {
    throw new BiometricError(
      'unsupported',
      '이 기기에서는 Face ID를 쓸 수 없습니다. PIN을 계속 사용할 수 있습니다.',
    )
  }

  const prfSalt = randomBytes(32)
  let credential: PublicKeyCredential
  try {
    credential = await createCredential(prfSalt)
  } catch (error) {
    throw mapError(error)
  }

  const credentialId = toBase64Url(new Uint8Array(credential.rawId))
  const created = prfExtension(credential)

  // Safari may return the PRF output only on an assertion, not on creation.
  let secret: Uint8Array | null = created.results?.first
    ? new Uint8Array(created.results.first)
    : null
  if (!secret && created.enabled !== false) {
    try {
      const assertion = await getAssertion(credentialId, prfSalt)
      secret = prfOutput(assertion)
    } catch (error) {
      const mapped = mapError(error)
      // A cancelled second prompt is not fatal: the credential exists, and the
      // device-key path needs no PRF at all.
      if (mapped.reason !== 'cancelled') throw mapped
    }
  }

  let mode: BiometricMode = 'prf'
  let key: CryptoKey
  if (secret) {
    key = await keyFromPrf(secret)
    // Do not keep the raw PRF material around longer than the derivation.
    secret.fill(0)
  } else {
    mode = 'device'
    try {
      key = await createDeviceKey()
    } catch {
      throw new BiometricError('error', 'Face ID 키를 저장하지 못했습니다. PIN을 사용해 주세요.')
    }
  }

  const iv = randomBytes(12)
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(plaintext))
  plaintext.fill(0)

  const record: BiometricRecord = {
    v: 2,
    mode,
    credentialId,
    prfSalt: toBase64Url(prfSalt),
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(ciphertext)),
    createdAt: Date.now(),
  }
  writeRecord(record)
  return record
}

/** Prompts Face ID and returns the sealed secret payload. */
export async function unlockWithBiometric(): Promise<SecretPayload> {
  const record = readRecord()
  if (!record) throw new BiometricError('unsupported', '등록된 Face ID가 없습니다.')

  let assertion: PublicKeyCredential
  try {
    assertion = await getAssertion(record.credentialId, fromBase64Url(record.prfSalt))
  } catch (error) {
    throw mapError(error)
  }

  let key: CryptoKey | null = null
  if (record.mode === 'prf') {
    const secret = prfOutput(assertion)
    if (!secret) {
      throw new BiometricError(
        'prf',
        '이번 인증에서는 Face ID 키를 받지 못했습니다. 다시 시도하거나 PIN을 사용하세요.',
      )
    }
    key = await keyFromPrf(secret)
    secret.fill(0)
  } else {
    key = await readDeviceKey()
    if (!key) {
      throw new BiometricError(
        'corrupt',
        'Face ID 키를 찾지 못했습니다. PIN으로 잠금 해제한 뒤 다시 등록해 주세요.',
      )
    }
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf(fromBase64Url(record.iv)) },
      key,
      buf(fromBase64Url(record.ct)),
    )
    return JSON.parse(new TextDecoder().decode(plaintext)) as SecretPayload
  } catch {
    throw new BiometricError(
      'corrupt',
      'Face ID 데이터를 열지 못했습니다. PIN으로 잠금 해제한 뒤 다시 등록해 주세요.',
    )
  }
}
