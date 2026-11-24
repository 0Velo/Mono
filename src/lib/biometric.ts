/**
 * Face ID / Touch ID unlock through the platform authenticator (WebAuthn).
 *
 * The wallet key is never stored in the clear. Two paths exist:
 *
 *  1. **PRF** (preferred) — the authenticator returns a stable secret for an
 *     evaluation salt we choose. HKDF derives an AES-256-GCM key from it and
 *     the vault payload is sealed with that key, so Face ID alone can unwrap
 *     it. Nothing recoverable is persisted on the device.
 *  2. **No PRF** — the platform authenticator still verifies the person, but
 *     it hands back no secret we could key on. We refuse to downgrade to a
 *     plaintext key just to show a Face ID screen, and tell the user to unlock
 *     with the PIN instead (with the reason), so nobody is ever locked out.
 *
 * Cancelling the Face ID sheet, or any failure, always falls back to the PIN.
 */

import type { SecretPayload } from './vault'

const RECORD_KEY = 'solwallet.faceid.v1'
const RP_NAME = 'Sol Wallet'
const HKDF_SALT = new TextEncoder().encode('sol-wallet/faceid/v1')
const HKDF_INFO = new TextEncoder().encode('aes-256-gcm/payload')

export interface BiometricRecord {
  v: 1
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

export type BiometricFailureReason = 'unsupported' | 'cancelled' | 'prf' | 'corrupt' | 'error'

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

/** True only when a platform authenticator (Face ID / Touch ID) is usable here. */
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

/* ----------------------------------------------------------------- record */

export function readRecord(): BiometricRecord | null {
  try {
    const raw = localStorage.getItem(RECORD_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as BiometricRecord
    if (
      parsed?.v !== 1 ||
      typeof parsed.credentialId !== 'string' ||
      typeof parsed.prfSalt !== 'string' ||
      typeof parsed.iv !== 'string' ||
      typeof parsed.ct !== 'string'
    ) {
      return null
    }
    return parsed
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
  } catch {
    /* private mode */
  }
}

/* --------------------------------------------------------------- webauthn */

function mapError(error: unknown): BiometricError {
  const name = (error as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return new BiometricError('cancelled', 'Face ID 인증이 취소되었습니다.')
  }
  if (name === 'NotSupportedError' || name === 'SecurityError') {
    return new BiometricError('unsupported', '이 환경에서는 Face ID를 사용할 수 없습니다.')
  }
  return new BiometricError('error', 'Face ID 인증에 실패했습니다.')
}

function prfSaltExtension(salt: Uint8Array) {
  return { prf: { eval: { first: buf(salt) } } } as unknown as AuthenticationExtensionsClientInputs
}

function prfOutput(credential: PublicKeyCredential): Uint8Array | null {
  const results = credential.getClientExtensionResults() as unknown as {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }
  }
  const first = results?.prf?.results?.first
  return first ? new Uint8Array(first) : null
}

async function createCredential(salt: Uint8Array): Promise<PublicKeyCredential> {
  const options = {
    publicKey: {
      challenge: buf(randomBytes(32)),
      rp: { id: location.hostname, name: RP_NAME },
      user: {
        id: buf(randomBytes(16)),
        name: 'sol-wallet',
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
      extensions: prfSaltExtension(salt),
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
      extensions: prfSaltExtension(salt),
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

/* -------------------------------------------------------------------- api */

/**
 * Registers this device's Face ID and seals `payload` behind it.
 * Throws `BiometricError` with a reason the UI can explain.
 */
export async function enrol(payload: SecretPayload): Promise<BiometricRecord> {
  if (!(await isPlatformAuthenticatorAvailable())) {
    throw new BiometricError('unsupported', '이 기기에서는 생체인증을 사용할 수 없습니다.')
  }

  const prfSalt = randomBytes(32)
  let credential: PublicKeyCredential
  try {
    credential = await createCredential(prfSalt)
  } catch (error) {
    throw mapError(error)
  }

  const credentialId = toBase64Url(new Uint8Array(credential.rawId))

  // Safari may return the PRF output only on an assertion, not on creation.
  let secret = prfOutput(credential)
  if (!secret) {
    try {
      const assertion = await getAssertion(credentialId, prfSalt)
      secret = prfOutput(assertion)
    } catch (error) {
      throw mapError(error)
    }
  }
  if (!secret) {
    throw new BiometricError(
      'prf',
      '이 브라우저(iOS)는 Face ID 잠금 해제(PRF)를 지원하지 않습니다. PIN을 사용해 주세요.',
    )
  }

  const key = await keyFromPrf(secret)
  const iv = randomBytes(12)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv) },
    key,
    buf(new TextEncoder().encode(JSON.stringify(payload))),
  )

  const record: BiometricRecord = {
    v: 1,
    credentialId,
    prfSalt: toBase64Url(prfSalt),
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(ciphertext)),
    createdAt: Date.now(),
  }
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(record))
  } catch {
    throw new BiometricError('error', 'Face ID 정보를 저장하지 못했습니다.')
  }
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

  const secret = prfOutput(assertion)
  if (!secret) {
    throw new BiometricError(
      'prf',
      '이 브라우저(iOS)는 Face ID 잠금 해제(PRF)를 지원하지 않습니다. PIN을 사용해 주세요.',
    )
  }

  try {
    const key = await keyFromPrf(secret)
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
