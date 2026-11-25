import type { HistoryItem, TokenDelta } from './tx'
import { formatTxAmount } from './format'
import { KNOWN_TOKENS } from './tokens'
import { explorerTx, type NetworkId } from './rpc'

/**
 * 앱이 열려 있는 동안의 입출금 알림.
 *
 * 백엔드가 없는 정적 웹앱이라 서버 푸시는 보낼 수 없다. 대신 이 기기의 RPC로
 * 거래내역을 주기적으로 조회해, 처음 보는 서명의 잔액 변화를 입금·출금·스왑으로
 * 분류해 OS 알림과 인앱 토스트로 알린다. 지갑 키·시드는 어디에도 쓰이지 않는다.
 */

const ENABLED_KEY = 'mono.activityNotifications.enabled.v1'
/** 1.0 이전에는 입금만 알렸다. 토글을 다시 켜지 않아도 되도록 그 값을 읽는다. */
const LEGACY_ENABLED_KEY = 'mono.depositNotifications.enabled.v1'
const SEEN_PREFIX = 'mono.activityNotifications.seen.v1:'
export const ACTIVITY_NOTIFICATION_SETTING_EVENT = 'mono:activity-notification-setting-changed'
const MAX_SEEN_SIGNATURES = 500

export type ActivityKind = 'received' | 'sent' | 'swap'

export interface ActivityEvent {
  signature: string
  kind: ActivityKind
  title: string
  body: string
}

export interface ActivitySelection {
  /** 새로 감지한 알림. 첫 실행(기준선 설정)에서는 항상 비어 있다. */
  events: ActivityEvent[]
  seen: string[]
  baseline: boolean
}

export type NotificationPermissionState = 'unsupported' | 'granted' | 'denied' | 'default'

/* ------------------------------------------------------------ classification */

function toAmount(value: string): bigint | null {
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function symbolOf(mint: string): string {
  return KNOWN_TOKENS[mint]?.symbol ?? mint.slice(0, 4).toUpperCase()
}

function label(delta: TokenDelta): string {
  const amount = toAmount(delta.amount)
  const absolute = amount === null ? 0n : amount < 0n ? -amount : amount
  return `${formatTxAmount(absolute, delta.decimals)} ${symbolOf(delta.mint)}`
}

function solLabel(lamports: bigint): string {
  return `${formatTxAmount(lamports, 9)} SOL`
}

function largest(deltas: TokenDelta[]): TokenDelta {
  return deltas.reduce((best, next) => (next.uiAmount > best.uiAmount ? next : best))
}

/**
 * 한 거래를 하나의 알림으로 요약한다. 같은 서명에 입금·출금이 섞여 있어도
 * 알림은 한 번만 뜬다(토큰끼리 오가면 스왑, SOL이 오가면 그 방향).
 *
 * 수수료만 빠진 거래(fee-only)는 알리지 않는다. 상세를 아직 못 받은 항목도
 * 알리지 않고, 다음 조회에서 상세가 채워지면 그때 판단한다.
 */
export function describeActivity(item: HistoryItem): ActivityEvent | null {
  if (item.failed || !item.detailed) return null

  const received = item.tokenDeltas.filter((delta) => {
    const amount = toAmount(delta.amount)
    return amount !== null && amount > 0n
  })
  const sent = item.tokenDeltas.filter((delta) => {
    const amount = toAmount(delta.amount)
    return amount !== null && amount < 0n
  })

  const fee = BigInt(Number.isSafeInteger(item.feeLamports) ? item.feeLamports! : 0)
  const solChange = BigInt(Number.isSafeInteger(item.solDelta) ? item.solDelta : 0)
  const solIn = solChange > 0n ? solChange : 0n
  // SOL 차감에는 네트워크 수수료가 섞여 있으므로 빼고 보여 준다.
  const solOut = solChange < 0n && -solChange > fee ? -solChange - fee : 0n

  const hasIn = received.length > 0 || solIn > 0n
  const hasOut = sent.length > 0 || solOut > 0n
  if (!hasIn && !hasOut) return null

  const inLabel = received.length ? label(largest(received)) : solLabel(solIn)
  const outLabel = sent.length ? label(largest(sent)) : solLabel(solOut)

  if (hasIn && hasOut) {
    return {
      signature: item.signature,
      kind: 'swap',
      title: '스왑 완료',
      body: `${outLabel} → ${inLabel}`,
    }
  }
  if (hasIn) {
    return {
      signature: item.signature,
      kind: 'received',
      title: '입금 확인',
      body: `${inLabel} 입금이 확인됐습니다.`,
    }
  }
  return {
    signature: item.signature,
    kind: 'sent',
    title: '출금 확인',
    body: `${outLabel} 출금이 확인됐습니다.`,
  }
}

/**
 * 이미 본 서명 목록과 이번 조회 결과를 비교한다.
 *
 * `previous`가 null이면 이 지갑에서 처음 조회한 것이므로 지금 보이는 거래는
 * 모두 "이미 있던 것"으로 기록만 하고 알리지 않는다 — 앱을 처음 열었을 때
 * 과거 잔액이 입금으로 둔갑해 알림이 쏟아지지 않게 하는 지점이다.
 */
export function selectNewActivity(
  previous: string[] | null,
  items: HistoryItem[],
): ActivitySelection {
  if (previous === null) {
    return { events: [], seen: items.map((item) => item.signature), baseline: true }
  }

  const seen = new Set(previous)
  const events: ActivityEvent[] = []
  // 오래된 것부터 알려야 여러 건이 한 번에 들어왔을 때 순서가 뒤집히지 않는다.
  for (const item of [...items].sort((a, b) => a.slot - b.slot)) {
    if (seen.has(item.signature) || !item.detailed) continue
    const event = describeActivity(item)
    if (event) events.push(event)
  }

  const detailed = items.filter((item) => item.detailed).map((item) => item.signature)
  const nextSeen = Array.from(new Set([...previous, ...detailed])).slice(-MAX_SEEN_SIGNATURES)
  return { events, seen: nextSeen, baseline: false }
}

/* ---------------------------------------------------------------- preference */

function storedPreference(): string | null {
  try {
    const current = localStorage.getItem(ENABLED_KEY)
    if (current !== null) return current
    return localStorage.getItem(LEGACY_ENABLED_KEY)
  } catch {
    return null
  }
}

export function notificationPermission(): NotificationPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  const state = Notification.permission
  if (state === 'granted' || state === 'denied' || state === 'default') return state
  return 'default'
}

export function isActivityNotificationsEnabled(): boolean {
  try {
    return notificationPermission() === 'granted' && storedPreference() === '1'
  } catch {
    return false
  }
}

function publishSettingChange(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(ACTIVITY_NOTIFICATION_SETTING_EVENT))
}

export type EnableNotificationsResult = 'enabled' | 'denied' | 'unsupported'

/**
 * 토글을 켤 때 한 번만 권한을 묻는다. iOS는 홈 화면에 추가한 앱에서만
 * 권한을 줄 수 있으므로, 그 경우에는 호출 전에 UI가 먼저 안내한다.
 */
export async function enableActivityNotifications(): Promise<EnableNotificationsResult> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  let permission = Notification.permission
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission()
    } catch {
      return 'denied'
    }
  }
  if (permission !== 'granted') return 'denied'
  try {
    localStorage.setItem(ENABLED_KEY, '1')
  } catch {
    return 'denied'
  }
  publishSettingChange()
  return 'enabled'
}

export function disableActivityNotifications(): void {
  try {
    localStorage.setItem(ENABLED_KEY, '0')
    localStorage.removeItem(LEGACY_ENABLED_KEY)
  } catch {
    // 저장소를 못 쓰더라도 이번 세션에서는 UI가 꺼진 상태로 남는다.
  }
  publishSettingChange()
}

/* --------------------------------------------------------------- persistence */

export function readSeenSignatures(scope: string): string[] | null {
  try {
    const raw = localStorage.getItem(`${SEEN_PREFIX}${scope}`)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return null
  }
}

export function writeSeenSignatures(scope: string, signatures: string[]): void {
  try {
    localStorage.setItem(
      `${SEEN_PREFIX}${scope}`,
      JSON.stringify(Array.from(new Set(signatures)).slice(-MAX_SEEN_SIGNATURES)),
    )
  } catch {
    // 다음 조회에서 다시 시도한다. 지갑이나 체인 데이터를 건드리지 않는다.
  }
}

/* ---------------------------------------------------------------------- iOS */

export function isIosUserAgent(userAgent: string): boolean {
  return /iPad|iPhone|iPod/.test(userAgent)
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  } catch {
    // Older iOS Safari has no matchMedia display-mode; fall back to navigator.
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** iOS Safari 탭에서는 웹 알림을 켤 수 없다. 홈 화면 앱으로 열었을 때만 가능하다. */
export function needsHomeScreenInstall(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  return isIosUserAgent(navigator.userAgent) && !isStandaloneDisplay()
}

/* ---------------------------------------------------------------- delivery */

export async function showActivityNotification(
  event: ActivityEvent,
  network: NetworkId,
): Promise<void> {
  if (!isActivityNotificationsEnabled()) return

  const options: NotificationOptions & { renotify: boolean } = {
    body: event.body,
    icon: new URL('icons/icon-192.png', document.baseURI).toString(),
    badge: new URL('icons/favicon-32.png', document.baseURI).toString(),
    tag: `mono-${event.kind}-${event.signature}`,
    renotify: false,
    data: { url: explorerTx(event.signature, network), kind: event.kind },
  }

  try {
    const registration = 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistration()
      : undefined
    if (registration?.showNotification) {
      await registration.showNotification(event.title, options)
      return
    }
  } catch {
    // 서비스 워커가 없거나 거부되면 페이지 알림으로 대신한다.
  }

  try {
    new Notification(event.title, options)
  } catch {
    // 권한은 있지만 페이지 알림을 막는 브라우저도 있다. 토스트는 이미 떴다.
  }
}

export function activityToastMessage(kind: ActivityKind): string {
  if (kind === 'received') return '새 입금이 확인됐습니다'
  if (kind === 'sent') return '출금이 확인됐습니다'
  return '스왑이 완료됐습니다'
}
