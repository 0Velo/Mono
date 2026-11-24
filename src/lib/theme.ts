/**
 * Light / dark / system theme.
 *
 * The choice is a single string in localStorage; everything else follows from
 * one `data-theme` attribute on <html>, which the CSS variables in index.css
 * key off. That means a theme switch is one attribute write — no re-render of
 * the tree, no flash, and the sheets keep their open state.
 */
import { useSyncExternalStore } from 'react'

export type ThemePref = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const KEY = 'mono.theme.v1'
const LIGHT_BG = '#FFFFFF'
const DARK_BG = '#090A0C'

const listeners = new Set<() => void>()
let cached: ThemePref | null = null

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

export function readThemePref(): ThemePref {
  if (cached) return cached
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') {
      cached = raw
      return raw
    }
  } catch {
    /* private mode */
  }
  cached = 'system'
  return 'system'
}

export function resolveTheme(pref: ThemePref = readThemePref()): ResolvedTheme {
  if (pref === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return pref
}

function paint(pref: ThemePref): void {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(pref)
  const root = document.documentElement
  root.dataset.theme = resolved
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', resolved === 'dark' ? DARK_BG : LIGHT_BG)
  // Keep the browser chrome in step inside standalone mode as well.
  const scheme = document.querySelector('meta[name="color-scheme"]')
  if (scheme) scheme.setAttribute('content', resolved === 'dark' ? 'dark' : 'light')
}

export function applyTheme(pref: ThemePref = readThemePref()): void {
  paint(pref)
}

export function setThemePref(next: ThemePref): void {
  cached = next
  try {
    localStorage.setItem(KEY, next)
  } catch {
    /* storage full / private mode: the theme still applies for this session */
  }
  paint(next)
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Re-paint when the OS flips while the user is on "시스템". */
export function watchSystemTheme(): () => void {
  let media: MediaQueryList | null = null
  try {
    media = window.matchMedia('(prefers-color-scheme: dark)')
  } catch {
    return () => undefined
  }
  const onChange = () => {
    if (readThemePref() === 'system') paint('system')
  }
  media.addEventListener?.('change', onChange)
  return () => media?.removeEventListener?.('change', onChange)
}

export function useTheme(): {
  pref: ThemePref
  resolved: ResolvedTheme
  setTheme: (next: ThemePref) => void
} {
  const pref = useSyncExternalStore(subscribe, readThemePref, () => 'system' as ThemePref)
  return { pref, resolved: resolveTheme(pref), setTheme: setThemePref }
}
