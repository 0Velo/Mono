/**
 * Small device-local preferences that are not secrets: which tokens are hidden
 * from the home list and which are on the watchlist.
 *
 * Kept as an external store so a star toggled in Token Detail updates the Home
 * list behind the sheet without threading props through the whole tree.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'mono.prefs.v1'

export interface Prefs {
  /** Mints hidden from the wallet list. */
  hidden: string[]
  /** Mints starred into the Watchlist section. */
  watch: string[]
}

const EMPTY: Prefs = { hidden: [], watch: [] }

let state: Prefs | null = null
const listeners = new Set<() => void>()

function normalize(value: unknown): Prefs {
  const raw = (value ?? {}) as Partial<Prefs>
  const clean = (list: unknown): string[] =>
    Array.isArray(list) ? Array.from(new Set(list.filter((item) => typeof item === 'string'))) : []
  return { hidden: clean(raw.hidden), watch: clean(raw.watch) }
}

function read(): Prefs {
  if (state) return state
  try {
    const raw = localStorage.getItem(KEY)
    state = raw ? normalize(JSON.parse(raw)) : EMPTY
  } catch {
    state = EMPTY
  }
  return state
}

function write(next: Prefs): void {
  state = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private mode: the session still reflects the change */
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function isHidden(mint: string): boolean {
  return read().hidden.includes(mint)
}

export function isWatched(mint: string): boolean {
  return read().watch.includes(mint)
}

export function setHidden(mint: string, hidden: boolean): void {
  const current = read()
  const next = hidden
    ? Array.from(new Set([...current.hidden, mint]))
    : current.hidden.filter((item) => item !== mint)
  write({ ...current, hidden: next })
}

export function toggleWatch(mint: string): boolean {
  const current = read()
  const watched = current.watch.includes(mint)
  const next = watched
    ? current.watch.filter((item) => item !== mint)
    : [...current.watch, mint]
  write({ ...current, watch: next })
  return !watched
}

export function clearHidden(): void {
  write({ ...read(), hidden: [] })
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, read, () => EMPTY)
}
