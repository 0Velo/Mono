/**
 * Address book — the recipients people actually send to, with their own labels
 * ("투빗 입금", "내 팬텀"). Saved on this device only; nothing is uploaded.
 *
 * Every entry carries the full address and a label. Duplicates by address are
 * collapsed on save, so re-saving the same wallet under a new name just renames
 * it instead of stacking two chips.
 */
import { useSyncExternalStore } from 'react'

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/

/** Shape check only — no key library, so this stays out of the heavy chunk. */
function looksLikeAddress(value: string): boolean {
  return value.length >= 32 && value.length <= 44 && BASE58.test(value)
}

const KEY = 'mono.addressBook.v1'

export interface AddressEntry {
  id: string
  label: string
  address: string
  createdAt: number
}

let state: AddressEntry[] | null = null
const listeners = new Set<() => void>()

function read(): AddressEntry[] {
  if (state) return state
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : []
    state = Array.isArray(parsed)
      ? parsed.filter(
          (item): item is AddressEntry =>
            Boolean(item) &&
            typeof item.id === 'string' &&
            typeof item.label === 'string' &&
            typeof item.address === 'string',
        )
      : []
  } catch {
    state = []
  }
  return state
}

function write(next: AddressEntry[]): void {
  state = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private mode */
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
    return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  }
}

export function saveEntry(label: string, address: string): AddressEntry | null {
  const cleanLabel = label.trim().slice(0, 24)
  const cleanAddress = address.trim()
  if (!cleanLabel || !looksLikeAddress(cleanAddress)) return null
  const entries = read()
  const existing = entries.find((entry) => entry.address === cleanAddress)
  if (existing) {
    const next = entries.map((entry) =>
      entry.id === existing.id ? { ...entry, label: cleanLabel } : entry,
    )
    write(next)
    return { ...existing, label: cleanLabel }
  }
  const entry: AddressEntry = {
    id: newId(),
    label: cleanLabel,
    address: cleanAddress,
    createdAt: Date.now(),
  }
  write([entry, ...entries].slice(0, 40))
  return entry
}

export function removeEntry(id: string): void {
  write(read().filter((entry) => entry.id !== id))
}

export function findEntryByAddress(address: string): AddressEntry | undefined {
  return read().find((entry) => entry.address === address.trim())
}

export function useAddressBook(): AddressEntry[] {
  return useSyncExternalStore(subscribe, read, () => [] as AddressEntry[])
}
