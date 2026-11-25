import type { HistoryItem } from './tx'
import { formatTxAmount } from './format'
import { KNOWN_TOKENS } from './tokens'
import { explorerTx, type NetworkId } from './rpc'

const ENABLED_KEY = 'mono.depositNotifications.enabled.v1'
const SEEN_PREFIX = 'mono.depositNotifications.seen.v1:'
export const DEPOSIT_NOTIFICATION_SETTING_EVENT = 'mono:deposit-notification-setting-changed'
const MAX_SEEN_SIGNATURES = 500

export function isDepositNotificationsEnabled(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      'Notification' in window &&
      Notification.permission === 'granted' &&
      localStorage.getItem(ENABLED_KEY) === '1'
    )
  } catch {
    return false
  }
}

function publishSettingChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(DEPOSIT_NOTIFICATION_SETTING_EVENT))
  }
}

export async function enableDepositNotifications(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false
  let permission = Notification.permission
  if (permission === 'default') permission = await Notification.requestPermission()
  if (permission !== 'granted') return false
  try {
    localStorage.setItem(ENABLED_KEY, '1')
  } catch {
    return false
  }
  publishSettingChange()
  return true
}

export function disableDepositNotifications(): void {
  try {
    localStorage.setItem(ENABLED_KEY, '0')
  } catch {
    // The UI still turns off for this session even if browser storage is unavailable.
  }
  publishSettingChange()
}

export function readSeenDepositSignatures(scope: string): string[] | null {
  try {
    const raw = localStorage.getItem(`${SEEN_PREFIX}${scope}`)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return null
  }
}

export function writeSeenDepositSignatures(scope: string, signatures: string[]): void {
  try {
    localStorage.setItem(
      `${SEEN_PREFIX}${scope}`,
      JSON.stringify(Array.from(new Set(signatures)).slice(-MAX_SEEN_SIGNATURES)),
    )
  } catch {
    // A future refresh can retry; wallet and chain data are never changed here.
  }
}

export function isIncomingDeposit(item: HistoryItem): boolean {
  if (item.failed || !item.detailed) return false
  if (item.solDelta > 0) return true
  return item.tokenDeltas.some((delta) => {
    try {
      return BigInt(delta.amount) > 0n
    } catch {
      return false
    }
  })
}

function depositBody(item: HistoryItem): string {
  if (item.solDelta > 0) {
    return `${formatTxAmount(BigInt(item.solDelta), 9)} SOL 입금이 확인됐습니다.`
  }
  const token = item.tokenDeltas.find((delta) => {
    try {
      return BigInt(delta.amount) > 0n
    } catch {
      return false
    }
  })
  if (token) {
    const symbol = KNOWN_TOKENS[token.mint]?.symbol ?? token.mint.slice(0, 4).toUpperCase()
    return `${formatTxAmount(BigInt(token.amount), token.decimals)} ${symbol} 입금이 확인됐습니다.`
  }
  return '새 입금이 확인됐습니다.'
}

export async function showDepositNotification(item: HistoryItem, network: NetworkId): Promise<void> {
  if (!isDepositNotificationsEnabled() || !isIncomingDeposit(item)) return

  const title = '입금 확인'
  const options: NotificationOptions & { renotify: boolean } = {
    body: `앱 실행 중 감지 · ${depositBody(item)}`,
    icon: new URL('icons/icon-192.png', document.baseURI).toString(),
    tag: `deposit-${item.signature}`,
    renotify: false,
    data: { url: explorerTx(item.signature, network) },
  }

  try {
    const registration = 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistration()
      : undefined
    if (registration?.showNotification) {
      await registration.showNotification(title, options)
      return
    }
  } catch {
    // Fall back to the page Notification API where available.
  }

  try {
    new Notification(title, options)
  } catch {
    // Some browsers expose permission but refuse page-level notifications.
  }
}
