/**
 * Encrypted vault persistence.
 *
 * The encrypted vault is stored in IndexedDB where available. localStorage is a
 * compatibility fallback only; failures are surfaced rather than reported as
 * an empty wallet, so an existing vault cannot be mistaken for a new install.
 */
import { isVaultShape, type Vault } from './vault'
import { STORE_VAULT, idbDelete, idbGet, idbSet, idbSupported } from './idb'

const VAULT_ID = 'primary'
const LEGACY_KEY = 'solwallet.vault.v1'
const FALLBACK_KEY = 'mono.vault.fallback.v1'

function parseStored(raw: string | null, key: string): Vault | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`저장된 지갑 데이터(${key})가 손상되었습니다. 원본 데이터를 유지했습니다.`)
  }
  if (!isVaultShape(parsed)) {
    throw new Error(`저장된 지갑 데이터(${key}) 형식이 올바르지 않습니다. 원본 데이터를 유지했습니다.`)
  }
  return parsed
}

function readLegacy(): Vault | null {
  return parseStored(localStorage.getItem(LEGACY_KEY), LEGACY_KEY)
}

function readFallback(): Vault | null {
  return parseStored(localStorage.getItem(FALLBACK_KEY), FALLBACK_KEY)
}

function writeFallback(vault: Vault): void {
  try {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(vault))
  } catch {
    throw new Error('IndexedDB를 사용할 수 없고 암호화 지갑을 대체 저장소에도 저장하지 못했습니다.')
  }
}

async function readIdb(): Promise<Vault | null> {
  if (!idbSupported()) return null
  const stored = await idbGet<unknown>(STORE_VAULT, VAULT_ID)
  if (stored === null) return null
  if (!isVaultShape(stored)) {
    throw new Error('IndexedDB의 지갑 데이터 형식이 올바르지 않습니다. 원본 데이터를 유지했습니다.')
  }
  return stored
}

/**
 * Reads the vault, migrating a legacy localStorage copy when possible. If
 * IndexedDB is unavailable, an intact legacy/fallback copy is still usable.
 */
export async function loadVault(): Promise<Vault | null> {
  let idbError: unknown = null
  try {
    const stored = await readIdb()
    if (stored) return stored
  } catch (error) {
    idbError = error
  }

  const legacy = readLegacy()
  if (legacy) {
    try {
      await saveVault(legacy)
    } catch {
      // The legacy copy remains intact, so it can still unlock this wallet.
      if (!idbError) throw new Error('기존 지갑을 불러오지 못했습니다. 원본 데이터를 유지했습니다.')
    }
    return legacy
  }

  const fallback = readFallback()
  if (fallback) return fallback
  if (idbError) {
    throw new Error('IndexedDB에서 지갑을 읽지 못했습니다. 다른 저장소의 원본 데이터는 변경하지 않았습니다.')
  }
  return null
}

/** Stores the sealed vault in IndexedDB, falling back only if that write fails. */
export async function saveVault(vault: Vault): Promise<void> {
  if (!isVaultShape(vault)) throw new Error('저장하려는 지갑 데이터 형식이 올바르지 않습니다.')
  if (idbSupported()) {
    try {
      await idbSet(STORE_VAULT, VAULT_ID, vault)
      return
    } catch {
      // Keep any old copy and try the encrypted localStorage fallback below.
    }
  }
  writeFallback(vault)
}

/** Remove redundant local copies first; do not delete IndexedDB if that fails. */
export async function clearVault(): Promise<void> {
  try {
    localStorage.removeItem(LEGACY_KEY)
    localStorage.removeItem(FALLBACK_KEY)
  } catch {
    throw new Error('대체 저장소를 삭제하지 못해 지갑 초기화를 중단했습니다.')
  }
  if (idbSupported()) {
    try {
      await idbDelete(STORE_VAULT, VAULT_ID)
    } catch {
      throw new Error('IndexedDB 지갑 데이터를 삭제하지 못했습니다. 데이터가 남아 있을 수 있습니다.')
    }
  }
}

export async function hasStoredVault(): Promise<boolean> {
  return Boolean(await loadVault())
}
