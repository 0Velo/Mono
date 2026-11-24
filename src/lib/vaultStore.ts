/**
 * Encrypted vault persistence.
 *
 * The vault is a sealed blob (PBKDF2 + AES-256-GCM), but it still belongs in
 * IndexedDB rather than localStorage: it survives less trivially, and it keeps
 * the key material out of the string store every script on the origin can read.
 *
 * A wallet created before Mono kept its vault in localStorage under
 * `solwallet.vault.v1`. The first read migrates it in one shot and removes the
 * old copy, so there is exactly one source of truth afterwards.
 */
import { isVaultShape, type Vault } from './vault'
import { STORE_VAULT, idbDelete, idbGet, idbSet, idbSupported } from './idb'

const VAULT_ID = 'primary'
const LEGACY_KEY = 'solwallet.vault.v1'
const FALLBACK_KEY = 'mono.vault.fallback.v1'

function readLegacy(): Vault | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isVaultShape(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readFallback(): Vault | null {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isVaultShape(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeFallback(vault: Vault | null): void {
  try {
    if (vault) localStorage.setItem(FALLBACK_KEY, JSON.stringify(vault))
    else localStorage.removeItem(FALLBACK_KEY)
  } catch {
    /* private mode */
  }
}

async function readIdb(): Promise<Vault | null> {
  if (!idbSupported()) return null
  try {
    const stored = await idbGet<unknown>(STORE_VAULT, VAULT_ID)
    return isVaultShape(stored) ? stored : null
  } catch {
    return null
  }
}

/**
 * Reads the vault, migrating a legacy localStorage copy the first time it is
 * found. Safe to call on every launch: without a legacy copy it is one
 * IndexedDB read.
 */
export async function loadVault(): Promise<Vault | null> {
  const stored = await readIdb()
  if (stored) {
    // A stale legacy copy can linger if a migration was interrupted; the IDB
    // record is authoritative, so clean it up.
    try {
      if (localStorage.getItem(LEGACY_KEY)) localStorage.removeItem(LEGACY_KEY)
    } catch {
      /* ignore */
    }
    return stored
  }

  const legacy = readLegacy()
  if (legacy) {
    const saved = await saveVault(legacy)
    if (saved) {
      try {
        localStorage.removeItem(LEGACY_KEY)
      } catch {
        /* ignore */
      }
    }
    return legacy
  }

  return readFallback()
}

/** Writes the vault. Returns false when IndexedDB refused and the fallback took it. */
export async function saveVault(vault: Vault): Promise<boolean> {
  if (idbSupported()) {
    try {
      await idbSet(STORE_VAULT, VAULT_ID, vault)
      writeFallback(null)
      return true
    } catch {
      /* fall through to localStorage */
    }
  }
  writeFallback(vault)
  return false
}

export async function clearVault(): Promise<void> {
  if (idbSupported()) {
    try {
      await idbDelete(STORE_VAULT, VAULT_ID)
    } catch {
      /* ignore */
    }
  }
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    /* ignore */
  }
  writeFallback(null)
}

export async function hasStoredVault(): Promise<boolean> {
  if (await readIdb()) return true
  return Boolean(readLegacy() ?? readFallback())
}
