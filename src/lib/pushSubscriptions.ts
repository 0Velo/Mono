import type { Keypair } from '@solana/web3.js'
import type { NetworkId } from './rpc'

const CREDENTIALS_KEY = 'mono.pushSubscriptions.credentials.v1'
const ED25519_PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
const encoder = new TextEncoder()

export type PushUiState = 'unavailable' | 'enabled-unavailable' | 'unsupported' | 'ios-install-required' | 'disabled' | 'enabled' | 'revoke-failed'

export interface SerializedPushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export type PushBackendNetwork = 'mainnet-beta' | 'devnet'

export interface PushRegistrationRequest {
  subscription: SerializedPushSubscription
  address: string
  network: PushBackendNetwork
  managementToken: string
  issuedAt: string
  signature: string
}

interface StoredCredentials {
  endpoint: string
  managementToken: string
  active: boolean
  pending?: boolean
  lastAssociation?: { address: string; network: NetworkId; issuedAt: number }
}

interface PushBackendConfig {
  vapidPublicKey: string
}

interface PreparedPushContext {
  apiUrl: string
  config: PushBackendConfig
  registration: ServiceWorkerRegistration
  subscription: PushSubscription | null
}

interface AssociationInput {
  subscription: SerializedPushSubscription
  address: string
  network: NetworkId
  managementToken: string
  issuedAt: number
}

interface AssociationSyncDependencies {
  sign: (message: string) => Promise<string>
  post: (body: PushRegistrationRequest) => Promise<void>
  saveAssociation: (association: { address: string; network: NetworkId; issuedAt: number }) => void
  isCurrent?: () => boolean
}

function envPushApiUrl(): string {
  return (import.meta as ImportMeta & { env?: { VITE_PUSH_API_URL?: string } }).env?.VITE_PUSH_API_URL ?? ''
}

let preparedPushContext: PreparedPushContext | null = null
let preparedPushPromise: { apiUrl: string; promise: Promise<void> } | null = null
let ed25519Supported: boolean | null = null

/** A single configured HTTPS backend is accepted; credentials/query/hash are never allowed. */
export function validatePushApiUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('푸시 서버 주소 설정이 올바르지 않습니다.')
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('푸시 서버 주소는 자격정보 없이 HTTPS로만 설정할 수 있습니다.')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

export function configuredPushApiUrl(): string | null {
  const configured = envPushApiUrl().trim()
  if (!configured) return null
  try {
    return validatePushApiUrl(configured)
  } catch {
    return null
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('푸시 공개키 형식이 올바르지 않습니다.')
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(base64)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function serializePushSubscription(subscription: Pick<PushSubscription, 'toJSON'>): SerializedPushSubscription {
  const value = subscription.toJSON()
  const endpoint = value.endpoint
  const p256dh = value.keys?.p256dh
  const auth = value.keys?.auth
  if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
    throw new Error('브라우저 푸시 구독 정보를 읽을 수 없습니다.')
  }
  const endpointUrl = new URL(endpoint)
  if (endpointUrl.protocol !== 'https:') throw new Error('푸시 구독 주소가 HTTPS가 아닙니다.')
  return { endpoint, keys: { p256dh, auth } }
}

function backendNetwork(network: NetworkId): PushBackendNetwork {
  return network === 'mainnet' ? 'mainnet-beta' : 'devnet'
}

function backendIssuedAt(issuedAt: number): string {
  return String(Math.floor(issuedAt / 1000))
}

export async function sha256Hex(value: string, cryptoApi: Crypto = crypto): Promise<string> {
  const digest = await cryptoApi.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function pushSubscriptionId(endpoint: string, cryptoApi: Crypto = crypto): Promise<string> {
  return sha256Hex(endpoint, cryptoApi)
}

export async function canonicalPushAssociation(
  address: string,
  network: NetworkId,
  issuedAt: number,
  endpoint: string,
  managementToken: string,
  cryptoApi: Crypto = crypto,
): Promise<string> {
  const seconds = backendIssuedAt(issuedAt)
  if (!address || (network !== 'mainnet' && network !== 'devnet') || !Number.isSafeInteger(issuedAt) ||
      issuedAt <= 0 || !/^\d{10}$/.test(seconds)) {
    throw new Error('푸시 계정 연결 정보가 올바르지 않습니다.')
  }
  return [
    'MONO-PUSH-V1',
    address,
    backendNetwork(network),
    seconds,
    await sha256Hex(endpoint, cryptoApi),
    await sha256Hex(managementToken, cryptoApi),
  ].join('\n')
}

export async function signPushAssociation(message: string, keypair: Keypair, cryptoApi: Crypto = crypto): Promise<string> {
  const secret = keypair.secretKey
  const publicKey = keypair.publicKey.toBytes()
  if (secret.length !== 64 || publicKey.length !== 32 || publicKey.some((byte, index) => secret[index + 32] !== byte)) {
    throw new Error('현재 잠금 해제된 지갑 키를 확인할 수 없습니다.')
  }
  const seed = secret.slice(0, 32)
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length)
  pkcs8.set(ED25519_PKCS8_PREFIX)
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length)
  seed.fill(0)
  try {
    const privateKey = await cryptoApi.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])
    const signature = await cryptoApi.subtle.sign({ name: 'Ed25519' }, privateKey, encoder.encode(message))
    return toBase64Url(new Uint8Array(signature))
  } catch {
    throw new Error('이 브라우저에서 지갑의 안전한 Ed25519 서명을 사용할 수 없습니다.')
  } finally {
    pkcs8.fill(0)
  }
}

export async function synchronizePushAssociation(
  input: AssociationInput,
  dependencies: AssociationSyncDependencies,
): Promise<boolean> {
  const isCurrent = dependencies.isCurrent ?? (() => true)
  if (!isCurrent()) return false
  const message = await canonicalPushAssociation(
    input.address,
    input.network,
    input.issuedAt,
    input.subscription.endpoint,
    input.managementToken,
  )
  const signature = await dependencies.sign(message)
  if (!isCurrent()) return false
  await dependencies.post({
    subscription: input.subscription,
    address: input.address,
    network: backendNetwork(input.network),
    managementToken: input.managementToken,
    issuedAt: backendIssuedAt(input.issuedAt),
    signature,
  })
  if (!isCurrent()) return false
  dependencies.saveAssociation({ address: input.address, network: input.network, issuedAt: input.issuedAt })
  return true
}

function readStoredCredentials(): StoredCredentials | null {
  try {
    const raw = localStorage.getItem(CREDENTIALS_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const value = parsed as Partial<StoredCredentials>
    if (typeof value.endpoint !== 'string' || typeof value.managementToken !== 'string' || typeof value.active !== 'boolean') return null
    return value as StoredCredentials
  } catch {
    return null
  }
}

function writeStoredCredentials(credentials: StoredCredentials): void {
  try {
    localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials))
  } catch {
    throw new Error('이 기기에 푸시 관리 정보를 안전하게 저장할 수 없습니다.')
  }
}

export function createManagementToken(cryptoApi: Crypto = crypto): string {
  const bytes = new Uint8Array(32)
  cryptoApi.getRandomValues(bytes)
  const token = toBase64Url(bytes)
  bytes.fill(0)
  return token
}

async function fetchBackendConfig(apiUrl: string): Promise<PushBackendConfig> {
  const response = await fetch(`${apiUrl}/v1/config`, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error('푸시 서버 설정을 확인하지 못했습니다.')
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || typeof (value as { vapidPublicKey?: unknown }).vapidPublicKey !== 'string') {
    throw new Error('푸시 서버 공개키 응답이 올바르지 않습니다.')
  }
  const vapidPublicKey = (value as PushBackendConfig).vapidPublicKey
  if (fromBase64Url(vapidPublicKey).length !== 65) throw new Error('푸시 서버 공개키 길이가 올바르지 않습니다.')
  return { vapidPublicKey }
}

async function supportsEd25519Signing(): Promise<boolean> {
  if (!crypto?.subtle) return false
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32)
  pkcs8.set(ED25519_PKCS8_PREFIX)
  try {
    const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])
    await crypto.subtle.sign({ name: 'Ed25519' }, key, new Uint8Array())
    return true
  } catch {
    return false
  } finally {
    pkcs8.fill(0)
  }
}

/** Load network-dependent prerequisites before the user taps the opt-in button. */
export function prepareRemotePush(): Promise<void> {
  const apiUrl = configuredPushApiUrl()
  if (!apiUrl || !subscriptionManagerAvailable()) return Promise.resolve()
  if (preparedPushContext?.apiUrl === apiUrl && ed25519Supported === true) return Promise.resolve()
  if (preparedPushPromise?.apiUrl === apiUrl) return preparedPushPromise.promise

  const promise = Promise.all([
    fetchBackendConfig(apiUrl),
    navigator.serviceWorker.ready,
    supportsEd25519Signing(),
  ]).then(async ([config, registration, signingSupported]) => {
    const subscription = signingSupported ? await registration.pushManager.getSubscription().catch(() => null) : null
    if (configuredPushApiUrl() === apiUrl) {
      ed25519Supported = signingSupported
      preparedPushContext = signingSupported ? { apiUrl, config, registration, subscription } : null
    }
  }).finally(() => {
    if (preparedPushPromise?.promise === promise) preparedPushPromise = null
  })
  preparedPushPromise = { apiUrl, promise }
  return promise
}

async function postAssociation(apiUrl: string, body: PushRegistrationRequest): Promise<void> {
  const response = await fetch(`${apiUrl}/v1/subscriptions`, {
    method: 'POST',
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error('푸시 서버에 이 기기를 등록하지 못했습니다.')
}

async function revokeAssociation(apiUrl: string, endpoint: string, managementToken: string): Promise<void> {
  const id = await pushSubscriptionId(endpoint)
  const response = await fetch(`${apiUrl}/v1/subscriptions/${id}`, {
    method: 'DELETE',
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ managementToken }),
  })
  if (!response.ok) throw new Error('푸시 서버의 원격 구독 해제에 실패했습니다.')
}

function subscriptionManagerAvailable(): boolean {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window &&
    typeof crypto !== 'undefined' && Boolean(crypto.subtle)
}

function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function isStandalonePwa(): boolean {
  return Boolean((navigator as Navigator & { standalone?: boolean }).standalone) ||
    window.matchMedia?.('(display-mode: standalone)').matches === true
}

export function getPushUiState(): PushUiState {
  const stored = readStoredCredentials()
  if (stored?.pending && !stored.active) return 'disabled'
  if (stored && !stored.active) return 'revoke-failed'
  if (!configuredPushApiUrl()) return stored?.active ? 'enabled-unavailable' : 'unavailable'
  if (stored?.active) return 'enabled'
  if (ed25519Supported === false) return 'unsupported'
  if (isIosDevice() && !isStandalonePwa()) return 'ios-install-required'
  if (!subscriptionManagerAvailable()) return 'unsupported'
  return 'disabled'
}

function subscriptionApplicationKey(value: string): Uint8Array {
  const key = fromBase64Url(value)
  if (key.length !== 65 || key[0] !== 4) throw new Error('푸시 공개키 형식이 올바르지 않습니다.')
  return key
}

function currentWalletMatches(address: string, keypair: Keypair): boolean {
  return keypair.publicKey.toBase58() === address && keypair.secretKey.length === 64 &&
    keypair.publicKey.toBytes().every((byte, index) => keypair.secretKey[index + 32] === byte)
}

async function performAssociation(
  apiUrl: string,
  subscription: SerializedPushSubscription,
  address: string,
  network: NetworkId,
  keypair: Keypair,
  credentials: StoredCredentials,
  isCurrent: () => boolean,
): Promise<boolean> {
  const associationIsCurrent = () => {
    const latest = readStoredCredentials()
    return Boolean(latest?.endpoint === subscription.endpoint && (latest.active || latest.pending) && isCurrent())
  }
  if (!currentWalletMatches(address, keypair) || !associationIsCurrent()) return false
  const issuedAt = Date.now()
  const syncKey = await pushSubscriptionId(subscription.endpoint)
  const queued = syncQueues.get(syncKey) ?? Promise.resolve()
  const operation = queued.catch(() => {}).then(async () => {
    if (!associationIsCurrent() || !currentWalletMatches(address, keypair)) return false
    const input: AssociationInput = {
      subscription,
      address,
      network,
      managementToken: credentials.managementToken,
      issuedAt,
    }
    return synchronizePushAssociation(input, {
      sign: (message) => signPushAssociation(message, keypair),
      post: (body) => postAssociation(apiUrl, body),
      saveAssociation: (association) => {
        const latest = readStoredCredentials()
        if (latest?.endpoint === subscription.endpoint && (latest.active || latest.pending) && isCurrent()) {
          writeStoredCredentials({ ...latest, active: true, pending: false, lastAssociation: association })
        }
      },
      isCurrent: associationIsCurrent,
    })
  })
  syncQueues.set(syncKey, operation)
  try {
    return await operation
  } finally {
    if (syncQueues.get(syncKey) === operation) syncQueues.delete(syncKey)
  }
}

const syncQueues = new Map<string, Promise<boolean>>()

/** Re-associate an existing, explicitly enabled subscription after an active wallet/network change. */
export async function syncExistingPushAssociation(
  address: string,
  network: NetworkId,
  keypair: Keypair | null,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const apiUrl = configuredPushApiUrl()
  if (!apiUrl || !keypair || !currentWalletMatches(address, keypair) || !isCurrent()) return false
  const credentials = readStoredCredentials()
  if (!credentials?.active) return false
  if (credentials.lastAssociation?.address === address && credentials.lastAssociation.network === network) return true
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = registration?.pushManager ? await registration.pushManager.getSubscription() : null
    if (!subscription || subscription.endpoint !== credentials.endpoint || !isCurrent()) return false
    const config = await fetchBackendConfig(apiUrl)
    void config // Config check ensures the single configured backend is reachable before association.
    return await performAssociation(apiUrl, serializePushSubscription(subscription), address, network, keypair, credentials, isCurrent)
  } catch {
    // Best-effort only: RPC/background sync failures must not affect wallet use.
    return false
  }
}

export interface RemoteWatchEntry {
  address: string
  label: string
  enabled: boolean
}

/**
 * Replace the whale wallet list this device's push subscription watches.
 *
 * Only public addresses and labels leave the device. The management token
 * authenticates the write, so the list can be kept current in a read-only
 * auto-login session; when the person has not enabled background push (or the
 * server is unreachable) this returns false and nothing is stored remotely.
 */
export async function syncWatchList(entries: RemoteWatchEntry[], network: NetworkId): Promise<boolean> {
  const apiUrl = configuredPushApiUrl()
  const credentials = readStoredCredentials()
  if (!apiUrl || !credentials?.active) return false
  try {
    const id = await pushSubscriptionId(credentials.endpoint)
    const response = await fetch(`${apiUrl}/v1/watch`, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        id,
        managementToken: credentials.managementToken,
        network: backendNetwork(network),
        entries,
      }),
    })
    return response.ok
  } catch {
    return false
  }
}

/** Explicit user gesture only: asks permission and, if accepted, creates the browser subscription. */
export async function enableRemotePush(
  address: string,
  network: NetworkId,
  keypair: Keypair | null,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const apiUrl = configuredPushApiUrl()
  if (!apiUrl) throw new Error('푸시 서버가 아직 설정되지 않아 앱을 닫은 뒤 받는 푸시는 사용할 수 없습니다.')
  if (isIosDevice() && !isStandalonePwa()) throw new Error('iPhone/iPad는 앱을 홈 화면에 추가한 뒤 실행해야 웹 푸시를 설정할 수 있습니다.')
  if (!subscriptionManagerAvailable()) throw new Error('이 브라우저는 PWA 웹 푸시를 지원하지 않습니다.')
  if (!keypair || !currentWalletMatches(address, keypair)) throw new Error('지갑 잠금을 해제한 뒤 다시 시도해 주세요.')
  if (!isCurrent()) throw new Error('계정이나 네트워크가 바뀌어 푸시 등록을 중단했습니다.')

  const prepared = preparedPushContext?.apiUrl === apiUrl ? preparedPushContext : null
  if (!prepared) {
    void prepareRemotePush().catch(() => {})
    throw new Error('푸시 서버 설정을 준비하고 있습니다. 잠시 후 다시 눌러 주세요.')
  }
  if (ed25519Supported === false) throw new Error('이 브라우저의 WebCrypto Ed25519 서명은 지원되지 않습니다. iOS/iPadOS에서는 Safari 17 이상이 필요합니다.')
  if (!isCurrent() || !currentWalletMatches(address, keypair)) throw new Error('계정이나 네트워크가 바뀌어 푸시 등록을 중단했습니다.')
  let permission = Notification.permission
  if (permission === 'default') permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('브라우저 알림 권한을 허용해야 웹 푸시를 설정할 수 있습니다.')
  if (!isCurrent() || !currentWalletMatches(address, keypair)) throw new Error('계정이나 네트워크가 바뀌어 푸시 등록을 중단했습니다.')

  const registration = prepared.registration
  if (!registration.pushManager) throw new Error('서비스 워커가 준비되지 않아 푸시를 설정할 수 없습니다.')
  let subscription = prepared.subscription
  let createdHere = false
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: subscriptionApplicationKey(prepared.config.vapidPublicKey) as BufferSource,
    })
    createdHere = true
    prepared.subscription = subscription
  }
  if (!isCurrent() || !currentWalletMatches(address, keypair)) {
    if (createdHere) await subscription.unsubscribe().catch(() => false)
    throw new Error('계정이나 네트워크가 바뀌어 푸시 등록을 중단했습니다.')
  }
  const serialized = serializePushSubscription(subscription)
  const previous = readStoredCredentials()
  const previousForEndpoint = previous?.endpoint === serialized.endpoint ? previous : null
  const credentials: StoredCredentials = previousForEndpoint
    ? { ...previousForEndpoint, pending: true }
    : { endpoint: serialized.endpoint, managementToken: createManagementToken(), active: false, pending: true }
  try {
    writeStoredCredentials(credentials)
  } catch (error) {
    if (createdHere) await subscription.unsubscribe().catch(() => false)
    throw error
  }
  try {
    const saved = await performAssociation(apiUrl, serialized, address, network, keypair, credentials, isCurrent)
    if (!saved) throw new Error('지갑 계정이 바뀌어 웹 푸시 등록을 중단했습니다. 다시 시도해 주세요.')
  } catch (error) {
    const latest = readStoredCredentials()
    if (latest?.endpoint === serialized.endpoint && latest.pending) {
      try {
        if (previous) writeStoredCredentials(previous)
        else localStorage.removeItem(CREDENTIALS_KEY)
      } catch { /* Keep the failure visible; the browser subscription cleanup below is best effort. */ }
    }
    if (!previousForEndpoint && createdHere) {
      await revokeAssociation(apiUrl, serialized.endpoint, credentials.managementToken).catch(() => {})
      await subscription.unsubscribe().catch(() => false)
      prepared.subscription = null
    }
    throw error
  }
}

/** Attempt authenticated server revocation first, then always stop this device's local subscription. */
export async function disableRemotePush(): Promise<{ remoteRevoked: boolean; localUnsubscribed: boolean }> {
  const stored = readStoredCredentials()
  const apiUrl = configuredPushApiUrl()
  if (stored) {
    try {
      writeStoredCredentials({ ...stored, active: false })
    } catch {
      // Continue with authenticated revoke and local unsubscribe even if storage is unavailable.
    }
  }
  let remoteRevoked = !stored
  let localUnsubscribed = true
  if (stored && apiUrl) {
    try {
      const syncKey = await pushSubscriptionId(stored.endpoint)
      const pendingAssociation = syncQueues.get(syncKey)
      if (pendingAssociation) await pendingAssociation.catch(() => false)
      await revokeAssociation(apiUrl, stored.endpoint, stored.managementToken)
      remoteRevoked = true
    } catch {
      remoteRevoked = false
    }
  } else if (stored) {
    remoteRevoked = false
  }

  try {
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
    const subscription = registration?.pushManager ? await registration.pushManager.getSubscription() : null
    if (subscription) localUnsubscribed = await subscription.unsubscribe()
  } catch {
    localUnsubscribed = false
  }
  if (localUnsubscribed && preparedPushContext) preparedPushContext.subscription = null

  if (remoteRevoked) {
    try { localStorage.removeItem(CREDENTIALS_KEY) } catch { /* Server revoke already succeeded. */ }
  }
  return { remoteRevoked, localUnsubscribed }
}
