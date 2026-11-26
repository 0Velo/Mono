/**
 * 고래(외부) 지갑 워치리스트.
 *
 * 추적하고 싶은 솔라나 주소와 별명만 기기에 저장한다. 키·시드는 물론 서명도
 * 필요 없는 공개 주소뿐이고, 목록은 백그라운드 Web Push를 켠 기기의 구독에
 * 붙어 푸시 서버(`/v1/watch`)로 전달된다. 서버는 그 주소들을 Helius 메인넷
 * 웹훅에 넣어 스왑·송금을 감지하면 `[별명] 스왑 감지` 푸시를 보낸다.
 *
 * 목록은 기기에 있으므로 오프라인·푸시 미설정 상태에서도 편집할 수 있고,
 * 푸시를 켜면 그때 한 번에 동기화된다.
 */
import { useSyncExternalStore } from 'react'
import type { NetworkId } from './rpc'
import { syncWatchList, type RemoteWatchEntry } from './pushSubscriptions'

const KEY = 'mono.watchWallets.v1'
export const MAX_WATCH_WALLETS = 8
export const MAX_WATCH_LABEL = 24
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/

export interface WatchEntry {
  id: string
  label: string
  address: string
  enabled: boolean
  createdAt: number
}

let state: WatchEntry[] | null = null
const listeners = new Set<() => void>()

/** Shape check only — no key library here, so this stays in the light chunk. */
export function looksLikeSolanaAddress(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length >= 32 && trimmed.length <= 44 && BASE58.test(trimmed)
}

/** One line, bounded: the label becomes the notification title. */
export function normalizeWatchLabel(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_WATCH_LABEL)
}

function read(): WatchEntry[] {
  if (state) return state
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : []
    state = Array.isArray(parsed)
      ? parsed
          .filter(
            (item): item is WatchEntry =>
              Boolean(item) &&
              typeof item.id === 'string' &&
              typeof item.label === 'string' &&
              typeof item.address === 'string' &&
              typeof item.enabled === 'boolean',
          )
          .map((item) => ({ ...item, label: normalizeWatchLabel(item.label) || item.label.slice(0, MAX_WATCH_LABEL) }))
          .slice(0, MAX_WATCH_WALLETS)
      : []
  } catch {
    state = []
  }
  return state
}

function write(next: WatchEntry[]): void {
  state = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private mode: the list lives for this session only */
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  }
}

export type WatchAddFailure = 'label' | 'address' | 'duplicate' | 'full' | 'own'

export type WatchAddResult =
  | { ok: true; entry: WatchEntry }
  | { ok: false; reason: WatchAddFailure }

export function addWatch(label: string, address: string, ownAddress = ''): WatchAddResult {
  const cleanLabel = normalizeWatchLabel(label)
  const cleanAddress = address.trim()
  if (!cleanLabel) return { ok: false, reason: 'label' }
  if (!looksLikeSolanaAddress(cleanAddress)) return { ok: false, reason: 'address' }
  if (ownAddress && cleanAddress === ownAddress) return { ok: false, reason: 'own' }
  const entries = read()
  if (entries.some((entry) => entry.address === cleanAddress)) return { ok: false, reason: 'duplicate' }
  if (entries.length >= MAX_WATCH_WALLETS) return { ok: false, reason: 'full' }
  const entry: WatchEntry = {
    id: newId(),
    label: cleanLabel,
    address: cleanAddress,
    enabled: true,
    createdAt: Date.now(),
  }
  write([entry, ...entries])
  return { ok: true, entry }
}

export function updateWatch(id: string, patch: { label?: string; enabled?: boolean }): boolean {
  let changed = false
  const next = read().map((entry) => {
    if (entry.id !== id) return entry
    const label = patch.label === undefined ? entry.label : normalizeWatchLabel(patch.label)
    if (!label) return entry
    changed = true
    return {
      ...entry,
      label,
      enabled: patch.enabled === undefined ? entry.enabled : patch.enabled,
    }
  })
  if (changed) write(next)
  return changed
}

export function removeWatch(id: string): void {
  write(read().filter((entry) => entry.id !== id))
}

export function useWatchWallets(): WatchEntry[] {
  return useSyncExternalStore(subscribe, read, () => [] as WatchEntry[])
}

/** Remote shape: public address, label, and whether alerts are on. */
export function watchEntriesPayload(entries: WatchEntry[]): RemoteWatchEntry[] {
  return entries.map((entry) => ({ address: entry.address, label: entry.label, enabled: entry.enabled }))
}

/**
 * Push the current list to this device's subscription. Whale alerts are a
 * mainnet feature (Helius mainnet webhook), so another network clears the
 * remote list instead of leaving stale addresses behind.
 */
export async function syncWatchWallets(network: NetworkId): Promise<boolean> {
  const entries = network === 'mainnet' ? watchEntriesPayload(read()) : []
  const signature = JSON.stringify([network, entries])
  if (signature === lastSyncedSignature) return true
  const synced = await syncWatchList(entries, network)
  if (synced) lastSyncedSignature = signature
  return synced
}

let lastSyncedSignature: string | null = null
