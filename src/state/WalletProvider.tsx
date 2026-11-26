import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Keypair } from '@solana/web3.js'
import {
  InvalidPinError,
  decryptSecret,
  encryptSecret,
  type SecretPayload,
  type Vault,
} from '../lib/vault'
import { loadKeys } from '../lib/keys'
import { loadVault, saveVault, clearVault } from '../lib/vaultStore'
import type { NetworkId } from '../lib/rpc'
import type { BackupAccountMetadata } from '../lib/backup'
import {
  AUTH_GRANT_TTL_MS,
  grantExpired,
  modeAfterKeyWipe,
  sanitizeAutoLogin,
  shouldAutoEnterViewOnly,
  type AuthPurpose,
} from '../lib/authGate'
import { AuthPrompt } from '../components/AuthPrompt'

const META_KEY = 'mono.meta.v1'
const LEGACY_META_KEY = 'solwallet.meta.v1'

export interface WalletMeta {
  address: string
  name: string
  network: NetworkId
  rpc: Record<NetworkId, string>
  autoLockMinutes: number
  createdAt: number
  /** Active account index on the m/44'/501'/index'/0' path. */
  activeIndex: number
  /** Custom nicknames by account index. */
  accountNames: Record<string, string>
  accountIndices?: number[]
  /**
   * Public addresses seen for each derived index. They are not secrets — the
   * chain shows them — and they are what lets the read-only session list an
   * account by name before any key has been decrypted.
   */
  accountAddresses?: Record<string, string>
  /**
   * "조회 자동 로그인": open straight into the read-only home. Turned on only
   * by the person, behind a PIN check, and it never keeps a key in memory.
   */
  autoLogin: boolean
}

export interface WalletAccount {
  index: number
  address: string
  name: string
}

/**
 * How many derived accounts a mnemonic wallet may hold. The path segment is
 * `m/44'/501'/index'/0'`, and 100 distinct indices is the standard space every
 * wallet app agrees on — far above the handful anyone uses, and far below the
 * point where unlock derivation becomes slow.
 */
export const MAX_ACCOUNTS = 100

/** Every registered index in the 0..99 derivation space, de-duplicated. */
export function sanitizeAccountIndices(values: readonly unknown[]): number[] {
  return Array.from(
    new Set(
      values
        .map(Number)
        .filter((index) => Number.isInteger(index) && index >= 0 && index < MAX_ACCOUNTS),
    ),
  ).sort((a, b) => a - b)
}

/**
 * Metadata written before the account registry existed carried no
 * `accountIndices`: those builds always derived and showed the base accounts
 * 0, 1 and 2. Rebuild exactly the contiguous list such a wallet was using
 * (through its active account and any renamed one) so an update never makes
 * accounts the person could see disappear.
 */
export function legacyAccountIndices(
  activeIndex: number,
  names?: Record<string, string>,
): number[] {
  const renamed = Object.keys(names ?? {})
    .map(Number)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < MAX_ACCOUNTS)
  const top = Math.max(0, activeIndex, ...renamed)
  return top > 0 ? Array.from({ length: Math.min(top, MAX_ACCOUNTS - 1) }, (_, position) => position + 1) : []
}

/** Lowest free index above the base account, or null when the space is full. */
export function nextAccountIndex(registered: readonly number[]): number | null {
  const used = new Set(registered)
  for (let index = 1; index < MAX_ACCOUNTS; index += 1) {
    if (!used.has(index)) return index
  }
  return null
}

const DEFAULT_META: Omit<WalletMeta, 'address'> = {
  name: 'Mono',
  network: 'mainnet',
  rpc: { mainnet: '', devnet: '' },
  autoLockMinutes: 5,
  createdAt: Date.now(),
  activeIndex: 0,
  accountNames: {},
  autoLogin: false,
}

export function accountLabel(meta: WalletMeta | null, index: number): string {
  const custom = meta?.accountNames?.[String(index)]
  if (custom && custom.trim()) return custom.trim()
  return index === 0 ? '메인' : `계정 ${index + 1}`
}

interface WalletContextValue {
  ready: boolean
  initializationError: string | null
  vaultExists: boolean
  vault: Vault | null
  meta: WalletMeta | null
  keypair: Keypair | null
  unlocked: boolean
  /** Showing public data with no key in memory ("자동 로그인" 조회 전용). */
  viewOnly: boolean
  /** Home or a detail screen can be shown: either unlocked or view-only. */
  canView: boolean
  createWallet: (payload: SecretPayload, pin: string) => Promise<void>
  unlock: (pin: string) => Promise<void>
  lock: () => void
  resetWallet: () => Promise<void>
  updateMeta: (patch: Partial<WalletMeta>) => void
  verifyPin: (pin: string) => Promise<SecretPayload>
  restoreBackup: (vault: Vault, pin: string, addressHint?: string, accountMetadata?: BackupAccountMetadata) => Promise<void>

  /**
   * Asks for the PIN check that stands in front of a sensitive action and
   * resolves with the decrypted keypair (or null when the person backs out).
   * Resolves immediately with the live keypair when the wallet is already open.
   */
  requestAuth: (purpose: AuthPurpose) => Promise<Keypair | null>
  /** Drops a key that `requestAuth` supplied, as soon as the action ends. */
  endAuthSession: () => void

  /** Accounts derived from the same seed phrase. A single key shows one. */
  accounts: WalletAccount[]
  activeIndex: number
  activeAccount: WalletAccount | null
  switchAccount: (index: number) => Promise<void>
  /** Derives and registers the next free account, returning its index. */
  addAccount: () => Promise<number>
  /** Removes an account from the registry. The seed phrase is never touched. */
  removeAccount: (index: number) => Promise<void>
  renameAccount: (index: number, name: string) => void

}

const WalletContext = createContext<WalletContextValue | null>(null)

export function readMeta(): WalletMeta | null {
  const raw = localStorage.getItem(META_KEY) ?? localStorage.getItem(LEGACY_META_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<WalletMeta>
    if (typeof parsed?.address !== 'string' || !parsed.address) return null
    const active = Number(parsed.activeIndex)
    const activeIndex = Number.isInteger(active) && active >= 0 && active < MAX_ACCOUNTS ? active : 0
    const accountNames = Object.fromEntries(
      Object.entries(parsed.accountNames ?? {})
        .filter(
          ([index, name]) =>
            /^\d+$/.test(index) && Number(index) < MAX_ACCOUNTS && typeof name === 'string',
        )
        .map(([index, name]) => [index, (name as string).trim().slice(0, 14)])
        .filter(([, name]) => Boolean(name)),
    )
    // `undefined` means a build from before the registry (it always showed
    // 0, 1, 2); an explicit list — even an empty one — is authoritative.
    const accountIndices =
      parsed.accountIndices === undefined
        ? legacyAccountIndices(activeIndex, accountNames)
        : sanitizeAccountIndices(
            Array.isArray(parsed.accountIndices) ? parsed.accountIndices : [],
          ).filter((index) => index > 0)
    return {
      ...DEFAULT_META,
      ...parsed,
      address: parsed.address,
      rpc: { ...DEFAULT_META.rpc, ...(parsed.rpc ?? {}) },
      accountNames,
      accountIndices,
      accountAddresses: sanitizeAccountAddresses(parsed.accountAddresses),
      autoLogin: sanitizeAutoLogin(parsed.autoLogin),
      activeIndex,
    }
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

export function hasStoredMeta(): boolean {
  return Boolean(localStorage.getItem(META_KEY) || localStorage.getItem(LEGACY_META_KEY))
}

/**
 * Public address registry: `index -> base58 address`. Only well-formed indices
 * and plausible addresses are kept, so a hand-edited metadata file cannot make
 * the read-only list show something that is not a derived account address.
 */
export function sanitizeAccountAddresses(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, address] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || Number(key) >= MAX_ACCOUNTS) continue
    if (typeof address !== 'string') continue
    const trimmed = address.trim()
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) continue
    out[key] = trimmed
  }
  return out
}

export function writeMeta(meta: WalletMeta): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta))
  } catch {
    throw new Error('지갑 설정을 저장하지 못했습니다. 기존 지갑 데이터를 유지했습니다.')
  }
}

/** Overwrite key bytes in place before releasing the reference. */
function wipeKeypair(keypair: Keypair | null): void {
  if (!keypair) return
  try {
    keypair.secretKey.fill(0)
  } catch {
    /* already wiped / frozen */
  }
}

/** Derive only the base account and indices the user has registered. */
export function accountIndices(activeIndex: number, names?: Record<string, string>, saved?: number[]): number[] {
  const set = new Set<number>([
    0,
    Math.max(0, Math.min(activeIndex, MAX_ACCOUNTS - 1)),
    ...sanitizeAccountIndices(saved ?? []),
  ])
  Object.keys(names ?? {}).forEach((key) => {
    const index = Number(key)
    if (Number.isInteger(index) && index >= 0 && index < MAX_ACCOUNTS) set.add(index)
  })
  return Array.from(set).sort((a, b) => a - b)
}

/** Addresses seen for a derived-account list, as stored in metadata. */
export function addressRecord(list: readonly WalletAccount[]): Record<string, string> {
  const record: Record<string, string> = {}
  list.forEach((account) => {
    if (account.address) record[String(account.index)] = account.address
  })
  return record
}

/**
 * The account list the app can show with no key at all: indices and names from
 * metadata, addresses from the public registry. The active account's address
 * always comes from `meta.address`, which is authoritative.
 */
export function publicAccounts(meta: WalletMeta | null): WalletAccount[] {
  if (!meta?.address) return []
  const stored = sanitizeAccountAddresses(meta.accountAddresses)
  const indices = accountIndices(meta.activeIndex, meta.accountNames, meta.accountIndices)
  return indices
    .map((index) => ({
      index,
      address: index === meta.activeIndex ? meta.address : (stored[String(index)] ?? ''),
      name: accountLabel(meta, index),
    }))
    .filter((account) => Boolean(account.address))
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const [initializationError, setInitializationError] = useState<string | null>(null)
  const [vault, setVault] = useState<Vault | null>(null)
  const [meta, setMeta] = useState<WalletMeta | null>(null)
  const [keypair, setKeypairState] = useState<Keypair | null>(null)
  const [liveAccounts, setLiveAccounts] = useState<WalletAccount[]>([])
  const [liveActiveIndex, setLiveActiveIndex] = useState(0)
  const [viewOnly, setViewOnly] = useState(false)
  const [authPurpose, setAuthPurpose] = useState<string | null>(null)

  const payloadRef = useRef<SecretPayload | null>(null)
  const keypairRef = useRef<Keypair | null>(null)
  const authResolveRef = useRef<((keypair: Keypair | null) => void) | null>(null)
  /** True while the key in memory came from a PIN check for one action. */
  const grantRef = useRef(false)
  const grantStartedRef = useRef(0)
  const grantTimerRef = useRef<number | undefined>(undefined)
  const endAuthRef = useRef<() => void>(() => {})
  const vaultRef = useRef<Vault | null>(null)
  const metaRef = useRef<WalletMeta | null>(null)
  vaultRef.current = vault
  metaRef.current = meta

  const setKeypair = useCallback((next: Keypair | null) => {
    keypairRef.current = next
    setKeypairState(next)
  }, [])

  /**
   * With no key in memory the app still knows its accounts: the registry lives
   * in metadata and the addresses are public (the chain already shows them).
   */
  const derived = keypair !== null && liveAccounts.length > 0
  const accounts = derived ? liveAccounts : publicAccounts(meta)
  const activeIndex = derived ? liveActiveIndex : (meta?.activeIndex ?? 0)

  
useEffect(() => {
  let cancelled = false

  const initialize = async () => {
    try {
      const stored = await loadVault()
      if (cancelled) return

      const storedMeta = readMeta()
      if (hasStoredMeta() && !storedMeta) {
        setInitializationError('저장된 지갑 설정을 읽지 못했습니다. 기존 암호화 지갑과 설정 원본을 유지했습니다.')
      } else if (!stored && storedMeta) {
        setInitializationError('저장된 지갑 설정은 있지만 암호화 지갑 데이터를 불러오지 못했습니다. 기존 데이터를 유지했습니다.')
      } else {
        setVault(stored)
        setMeta(storedMeta)
        // "조회 자동 로그인": open the read-only home without touching the key.
        setViewOnly(shouldAutoEnterViewOnly(storedMeta, Boolean(stored)))
      }
    } catch {
      setInitializationError('저장된 지갑 데이터를 읽지 못했습니다. 데이터를 삭제하거나 초기화하지 않았습니다.')
    } finally {
      if (!cancelled) {
        setReady(true)
      }
    }
  }

  void initialize()

  return () => {
    cancelled = true
  }
}, [])


  const persistMeta = useCallback((next: WalletMeta) => {
    try {
      writeMeta(next)
    } catch (error) {
      setInitializationError(error instanceof Error ? error.message : '지갑 설정을 저장하지 못했습니다. 기존 지갑 데이터를 유지했습니다.')
      throw error
    }
    setMeta(next)
  }, [])

  /**
   * Turns a decrypted payload into the live keypair plus the account list.
   * For a mnemonic wallet the active account may be any index; a raw-key
   * wallet has exactly one account.
   */
  const applyPayload = useCallback(
    async (payload: SecretPayload): Promise<Keypair> => {
      const stored = readMeta()

      if (payload.kind === 'mnemonic') {
        const { deriveAccounts } = await loadKeys()
        const index = stored?.activeIndex ?? 0
        const indices = accountIndices(index, stored?.accountNames, stored?.accountIndices)
        const keypairs = deriveAccounts(payload.mnemonic, indices, payload.path)
        const list: WalletAccount[] = indices.map((accountIndex, position) => ({
          index: accountIndex,
          address: keypairs[position].publicKey.toBase58(),
          name: accountLabel(stored, accountIndex),
        }))
        const activePosition = indices.indexOf(index)
        const active = keypairs[activePosition >= 0 ? activePosition : 0]
        // Anything derived but not active is only needed for its address.
        keypairs.forEach((kp) => {
          if (kp !== active) wipeKeypair(kp)
        })
        const address = active.publicKey.toBase58()
        const nextMeta: WalletMeta = stored ?? { ...DEFAULT_META, address, createdAt: Date.now() }
        const known = sanitizeAccountAddresses(stored?.accountAddresses)
        const seen = addressRecord(list)
        const addressesChanged = Object.entries(seen).some(([key, value]) => known[key] !== value)
        if (!stored || stored.address !== address || addressesChanged) {
          try {
            persistMeta({
              ...nextMeta,
              address,
              activeIndex: index,
              accountAddresses: { ...known, ...seen },
            })
          } catch (error) {
            wipeKeypair(active)
            throw error
          }
        }
        payloadRef.current = payload
        setLiveAccounts(list)
        setLiveActiveIndex(index)
        setKeypair(active)
        return active
      }

      const { keypairFromPayload } = await loadKeys()
      const kp = keypairFromPayload(payload)
      const address = kp.publicKey.toBase58()
      const known = sanitizeAccountAddresses(stored?.accountAddresses)
      if (!stored || stored.address !== address || known['0'] !== address) {
        try {
          persistMeta({
            ...(stored ?? { ...DEFAULT_META, address, createdAt: Date.now() }),
            address,
            activeIndex: 0,
            accountAddresses: { ...known, '0': address },
          })
        } catch (error) {
          wipeKeypair(kp)
          throw error
        }
      }
      payloadRef.current = payload
      setLiveActiveIndex(0)
      setLiveAccounts([{ index: 0, address, name: accountLabel(stored, 0) }])
      setKeypair(kp)
      return kp
    },
    [persistMeta, setKeypair],
  )

  const createWallet = useCallback(
    async (payload: SecretPayload, pin: string) => {
      const { keypairFromPayload } = await loadKeys()
      const kp = keypairFromPayload(payload)
      const nextVault = await encryptSecret(payload, pin)
      await saveVault(nextVault)
      const nextMeta: WalletMeta = {
        ...DEFAULT_META,
        address: kp.publicKey.toBase58(),
        createdAt: Date.now(),
        accountAddresses: { '0': kp.publicKey.toBase58() },
      }
      try {
        persistMeta(nextMeta)
      } catch (error) {
        wipeKeypair(kp)
        throw error
      }
      payloadRef.current = payload
      setVault(nextVault)
      setLiveActiveIndex(0)
      setLiveAccounts([{ index: 0, address: nextMeta.address, name: accountLabel(nextMeta, 0) }])
      setKeypair(kp)
      setViewOnly(false)
      setInitializationError(null)
    },
    [persistMeta, setKeypair],
  )

  const unlock = useCallback(
    async (pin: string) => {
      const current = vault ?? (await loadVault())
      if (!current) throw new Error('지갑이 없습니다.')
      const payload = await decryptSecret(current, pin)
      setVault(current)
      await applyPayload(payload)
      setViewOnly(false)
    },
    [vault, applyPayload],
  )

  /**
   * Drop every decrypted byte we hold, not just the React state. With
   * auto-login on, the app lands on the read-only home instead of the lock
   * screen — there is nothing left to protect at that point.
   */
  const dropSecret = useCallback(() => {
    grantRef.current = false
    if (grantTimerRef.current) {
      window.clearTimeout(grantTimerRef.current)
      grantTimerRef.current = undefined
    }
    wipeKeypair(keypairRef.current)
    setKeypair(null)
    payloadRef.current = null
    setLiveAccounts([])
    const mode = modeAfterKeyWipe({
      autoLogin: sanitizeAutoLogin(metaRef.current?.autoLogin),
      vaultExists: Boolean(vaultRef.current),
    })
    setViewOnly(mode === 'view')
  }, [setKeypair])

  /** Explicit "지금 잠금": always ends at the lock screen. */
  const lock = useCallback(() => {
    dropSecret()
    setViewOnly(false)
  }, [dropSecret])

  const finishAuth = useCallback((keypairResult: Keypair | null) => {
    const resolve = authResolveRef.current
    authResolveRef.current = null
    setAuthPurpose(null)
    resolve?.(keypairResult)
  }, [])

  /**
   * Releases the key that a PIN check supplied. A wallet that was already open
   * (key typed on the lock screen) keeps its session: `grantRef` is false, so
   * finishing an action never locks somebody out mid-use.
   */
  const endAuthSession = useCallback(() => {
    if (!grantRef.current) return
    dropSecret()
  }, [dropSecret])
  endAuthRef.current = endAuthSession

  /**
   * The one door to a decrypted key: open actions call this, get the keypair,
   * and release it with `endAuthSession` when they are done. Nothing else in
   * the app can turn a PIN prompt into a key.
   */
  const requestAuth = useCallback(
    (purpose: AuthPurpose): Promise<Keypair | null> => {
      if (keypairRef.current) return Promise.resolve(keypairRef.current)
      return (async () => {
        const current = vault ?? (await loadVault())
        if (!current) return null
        setVault(current)
        // A second request supersedes the first: its action is cancelled.
        if (authResolveRef.current) {
          const previous = authResolveRef.current
          authResolveRef.current = null
          previous(null)
        }
        return await new Promise<Keypair | null>((resolve) => {
          authResolveRef.current = resolve
          setAuthPurpose(purpose)
        })
      })()
    },
    [vault],
  )

  /** PIN submitted in the auth sheet: verify, decrypt for this action only. */
  const resolveAuth = useCallback(
    async (pin: string) => {
      const current = vault ?? (await loadVault())
      if (!current) throw new Error('지갑이 없습니다.')
      const payload = await decryptSecret(current, pin)
      setVault(current)
      const derived = await applyPayload(payload)
      grantRef.current = true
      grantStartedRef.current = Date.now()
      if (grantTimerRef.current) window.clearTimeout(grantTimerRef.current)
      // A screen that forgets to release the grant still loses the key here.
      grantTimerRef.current = window.setTimeout(() => {
        if (grantRef.current && grantExpired(grantStartedRef.current, Date.now())) {
          endAuthRef.current()
        }
      }, AUTH_GRANT_TTL_MS + 500)
      finishAuth(derived)
    },
    [vault, applyPayload, finishAuth],
  )

  const cancelAuth = useCallback(() => {
    finishAuth(null)
  }, [finishAuth])

  const restoreBackup = useCallback(
    async (nextVault: Vault, pin: string, addressHint?: string, accountMetadata?: BackupAccountMetadata) => {
      const payload = await decryptSecret(nextVault, pin)
      const { deriveAccounts, keypairFromPayload } = await loadKeys()
      const requestedIndex = accountMetadata?.activeIndex
      let index = Number.isInteger(requestedIndex) && requestedIndex! >= 0 && requestedIndex! < 100 ? requestedIndex! : 0
      let derived: Keypair[] = []
      let derivedIndices: number[] = [0]
      let kp: Keypair
      if (payload.kind === 'mnemonic') {
        const hasAccountMetadata = Boolean(accountMetadata?.activeIndex !== undefined || accountMetadata?.accountIndices)
        derivedIndices = hasAccountMetadata
          ? Array.from(
              new Set([
                0,
                ...(accountMetadata?.accountIndices ?? []).filter((value) => Number.isInteger(value) && value >= 0 && value < 100),
                index,
              ]),
            ).sort((a, b) => a - b)
          : addressHint
            ? Array.from({ length: 100 }, (_, value) => value)
            : [0]
        derived = deriveAccounts(payload.mnemonic, derivedIndices, payload.path)
        if (!hasAccountMetadata && addressHint) {
          const found = derived.findIndex((candidate) => candidate.publicKey.toBase58() === addressHint)
          if (found < 0) {
            derived.forEach(wipeKeypair)
            throw new Error('백업 주소에 해당하는 계정을 찾지 못했습니다. 지갑 데이터를 변경하지 않았습니다.')
          }
          index = derivedIndices[found]
        }
        kp = derived[derivedIndices.indexOf(index)]
        if (!kp) {
          derived.forEach(wipeKeypair)
          throw new Error('백업에서 활성 계정을 확인하지 못했습니다. 지갑 데이터를 변경하지 않았습니다.')
        }
        derived.forEach((candidate) => {
          if (candidate !== kp) wipeKeypair(candidate)
        })
      } else {
        if (index !== 0) throw new Error('개인키 백업에는 추가 계정 인덱스를 사용할 수 없습니다.')
        kp = keypairFromPayload(payload)
      }
      const address = kp.publicKey.toBase58()
      if (addressHint && addressHint !== address) {
        wipeKeypair(kp)
        throw new Error('백업 파일의 주소가 PIN과 맞지 않습니다.')
      }
      try {
        await saveVault(nextVault)
      } catch (error) {
        wipeKeypair(kp)
        throw error
      }
      const visibleIndices = payload.kind === 'mnemonic'
        ? accountMetadata?.accountIndices
          ? Array.from(new Set([0, ...accountMetadata.accountIndices.filter((value) => Number.isInteger(value) && value >= 0 && value < 100), index])).sort((a, b) => a - b)
          : index > 0
            ? [0, index]
            : [0]
        : [0]
      const accountNames = accountMetadata?.accountNames ?? {}
      const accountsForRestore: WalletAccount[] = visibleIndices.map((accountIndex) => {
        const accountKeypair = derived[derivedIndices.indexOf(accountIndex)]
        return {
          index: accountIndex,
          address: accountKeypair?.publicKey.toBase58() ?? (accountIndex === 0 ? address : ''),
          name: accountLabel({ ...DEFAULT_META, address, activeIndex: index, accountNames } as WalletMeta, accountIndex),
        }
      })
      const nextMeta: WalletMeta = {
        ...DEFAULT_META,
        address,
        createdAt: nextVault.createdAt ?? Date.now(),
        activeIndex: index,
        accountIndices: visibleIndices.filter((value) => value > 0),
        accountNames,
        accountAddresses: addressRecord(accountsForRestore),
      }
      try {
        persistMeta(nextMeta)
      } catch (error) {
        wipeKeypair(kp)
        throw error
      }
      payloadRef.current = payload
      setVault(nextVault)
      setLiveActiveIndex(index)
      setLiveAccounts(accountsForRestore.filter((account) => account.address))
      setKeypair(kp)
      setViewOnly(false)
      setInitializationError(null)
    },
    [persistMeta, setKeypair],
  )

  const resetWallet = useCallback(async () => {
    try {
      localStorage.removeItem(META_KEY)
      localStorage.removeItem(LEGACY_META_KEY)
    } catch {
      throw new Error('지갑 설정을 삭제하지 못했습니다. 지갑 데이터를 유지했습니다.')
    }
    await clearVault()
    wipeKeypair(keypairRef.current)
    payloadRef.current = null
    setVault(null)
    setMeta(null)
    setKeypair(null)
    setLiveAccounts([])
    setLiveActiveIndex(0)
    setViewOnly(false)
    setInitializationError(null)
  }, [setKeypair])

  const updateMeta = useCallback(
    (patch: Partial<WalletMeta>) => {
      if (!meta) return
      persistMeta({ ...meta, ...patch })
    },
    [meta, persistMeta],
  )

  const switchAccount = useCallback(
    async (index: number) => {
      const payload = payloadRef.current
      if (!payload) throw new Error('지갑 잠금을 먼저 풀어 주세요.')
      if (payload.kind !== 'mnemonic') {
        throw new Error('개인키로 만든 지갑에는 계정을 추가할 수 없습니다.')
      }
      if (!Number.isInteger(index) || index < 0 || index >= MAX_ACCOUNTS) {
        throw new Error('계정 번호가 올바르지 않습니다.')
      }
      if (index === activeIndex) return
      const { keypairForAccount, keypairFromPayload } = await loadKeys()
      const next = index === 0 ? keypairFromPayload(payload) : keypairForAccount(payload.mnemonic, index)
      const address = next.publicKey.toBase58()
      const base = meta ?? readMeta() ?? { ...DEFAULT_META, address, createdAt: Date.now() }
      const ids = Array.from(
        new Set([...(base.accountIndices ?? []), ...(index > 0 ? [index] : [])]),
      )
        .filter((value) => Number.isInteger(value) && value > 0 && value < MAX_ACCOUNTS)
        .sort((a, b) => a - b)
      try {
        persistMeta({
          ...base,
          address,
          activeIndex: index,
          accountIndices: ids,
          accountAddresses: { ...sanitizeAccountAddresses(base.accountAddresses), [String(index)]: address },
        })
      } catch (error) {
        wipeKeypair(next)
        throw error
      }
      wipeKeypair(keypairRef.current)
      setKeypair(next)
      setLiveActiveIndex(index)
      setLiveAccounts((current) => {
        if (current.some((account) => account.index === index)) return current
        return [...current, { index, address, name: accountLabel(base, index) }].sort(
          (a, b) => a.index - b.index,
        )
      })
    },
    [activeIndex, meta, persistMeta, setKeypair],
  )

  /**
   * Adds the next free derived account and makes it active. The registry in
   * metadata is the source of truth, so adding works the same whether the list
   * came from a fresh wallet, an older build, or a restored backup.
   */
  const addAccount = useCallback(async (): Promise<number> => {
    const payload = payloadRef.current
    if (!payload) throw new Error('지갑 잠금을 먼저 풀어 주세요.')
    if (payload.kind !== 'mnemonic') {
      throw new Error('개인키로 만든 지갑에는 계정을 추가할 수 없습니다.')
    }
    const base = meta ?? readMeta()
    const registered = accountIndices(activeIndex, base?.accountNames, base?.accountIndices)
    const index = nextAccountIndex(registered)
    if (index === null) {
      throw new Error(`계정은 최대 ${MAX_ACCOUNTS}개까지 만들 수 있습니다.`)
    }
    const { keypairForAccount } = await loadKeys()
    const next = keypairForAccount(payload.mnemonic, index)
    const address = next.publicKey.toBase58()
    const current = base ?? { ...DEFAULT_META, address, createdAt: Date.now() }
    const ids = Array.from(new Set([...(current.accountIndices ?? []), index]))
      .filter((value) => Number.isInteger(value) && value > 0 && value < MAX_ACCOUNTS)
      .sort((a, b) => a - b)
    try {
      persistMeta({
        ...current,
        address,
        activeIndex: index,
        accountIndices: ids,
        accountAddresses: { ...sanitizeAccountAddresses(current.accountAddresses), [String(index)]: address },
      })
    } catch (error) {
      wipeKeypair(next)
      throw error
    }
    wipeKeypair(keypairRef.current)
    setKeypair(next)
    setLiveActiveIndex(index)
    setLiveAccounts((list) => {
      if (list.some((account) => account.index === index)) return list
      return [...list, { index, address, name: accountLabel(current, index) }].sort(
        (a, b) => a.index - b.index,
      )
    })
    return index
  }, [activeIndex, meta, persistMeta, setKeypair])

  /**
   * Removes one derived account from the registry. Nothing in the vault is
   * rewritten: the seed phrase still derives that address, so re-adding the
   * same index brings back the same account with its funds.
   */
  const removeAccount = useCallback(
    async (index: number) => {
      const payload = payloadRef.current
      if (!payload) throw new Error('지갑 잠금을 먼저 풀어 주세요.')
      const base = meta ?? readMeta()
      if (!base) throw new Error('지갑 설정을 읽지 못했습니다. 기존 데이터는 유지했습니다.')
      const registered = accountIndices(activeIndex, base.accountNames, base.accountIndices)
      if (!registered.includes(index)) throw new Error('목록에 없는 계정입니다.')
      const remaining = registered.filter((value) => value !== index)
      if (remaining.length === 0) throw new Error('계정이 하나뿐일 때는 삭제할 수 없습니다.')

      // Deleting the account in use means the wallet has to show another one;
      // derive it first so a failure leaves the current state untouched.
      const nextActive = index === activeIndex ? remaining[0] : activeIndex
      let nextKeypair: Keypair | null = null
      if (index === activeIndex) {
        if (payload.kind !== 'mnemonic') throw new Error('개인키 지갑의 계정은 삭제할 수 없습니다.')
        const { keypairForAccount, keypairFromPayload } = await loadKeys()
        nextKeypair =
          nextActive === 0 ? keypairFromPayload(payload) : keypairForAccount(payload.mnemonic, nextActive)
      }
      const address = nextKeypair
        ? nextKeypair.publicKey.toBase58()
        : base.address
      const names = { ...base.accountNames }
      delete names[String(index)]
      const ids = remaining.filter((value) => value > 0 && value < MAX_ACCOUNTS).sort((a, b) => a - b)

      try {
        persistMeta({
          ...base,
          address,
          activeIndex: nextActive,
          accountIndices: ids,
          accountNames: names,
          accountAddresses: nextKeypair
            ? { ...sanitizeAccountAddresses(base.accountAddresses), [String(nextActive)]: address }
            : sanitizeAccountAddresses(base.accountAddresses),
        })
      } catch (error) {
        wipeKeypair(nextKeypair)
        throw error
      }

      if (nextKeypair) {
        wipeKeypair(keypairRef.current)
        setKeypair(nextKeypair)
      }
      setLiveActiveIndex(nextActive)
      setLiveAccounts((list) =>
        list
          .filter((account) => account.index !== index)
          .map((account) =>
            account.index === nextActive
              ? { ...account, name: accountLabel({ ...base, accountNames: names }, account.index) }
              : account,
          ),
      )
    },
    [activeIndex, meta, persistMeta, setKeypair],
  )

  const renameAccount = useCallback(
    (index: number, name: string) => {
      if (!meta) return
      const clean = name.trim().slice(0, 14)
      const names = { ...meta.accountNames }
      if (clean) names[String(index)] = clean
      else delete names[String(index)]
      persistMeta({ ...meta, accountNames: names })
      setLiveAccounts((current) =>
        current.map((account) =>
          account.index === index ? { ...account, name: accountLabel({ ...meta, accountNames: names }, index) } : account,
        ),
      )
    },
    [meta, persistMeta],
  )

  const verifyPin = useCallback(
    async (pin: string) => {
      const current = vault ?? (await loadVault())
      if (!current) throw new Error('지갑이 없습니다.')
      return decryptSecret(current, pin)
    },
    [vault],
  )

  // Auto-lock after a period without interaction.
  const lastActivity = useRef(Date.now())
  const autoLockMinutes = meta?.autoLockMinutes ?? 5
  const isUnlocked = keypair !== null

  useEffect(() => {
    if (!isUnlocked) return
    lastActivity.current = Date.now()

    const bump = () => {
      lastActivity.current = Date.now()
    }
    const events: Array<keyof WindowEventMap> = [
      'pointerdown',
      'keydown',
      'wheel',
      'touchstart',
      'scroll',
    ]
    events.forEach((event) => window.addEventListener(event, bump, { passive: true }))

    const expire = () => {
      // Auto-lock drops the key; with auto-login on the app stays on the
      // read-only home instead of covering it with the lock screen.
      grantRef.current = false
      dropSecret()
    }

    const timer = window.setInterval(() => {
      if (autoLockMinutes > 0 && Date.now() - lastActivity.current > autoLockMinutes * 60_000) {
        expire()
      }
    }, 15_000)

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (autoLockMinutes > 0 && Date.now() - lastActivity.current > autoLockMinutes * 60_000) {
          expire()
        } else {
          lastActivity.current = Date.now()
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    // Last line of defence: when the page is put away (tab closed, app
    // backgrounded into a frozen page) drop the decrypted key AND the decrypted
    // payload. Wiping only the key bytes left `unlocked` true with a dead
    // keypair, so the next send signed garbage while the mnemonic was still in
    // memory. `dropSecret` keeps auto-login on the read-only home; an explicit
    // "지금 잠금" is the only path that forces the lock screen.
    const onPageHide = () => {
      grantRef.current = false
      dropSecret()
    }
    window.addEventListener('pagehide', onPageHide)

    return () => {
      events.forEach((event) => window.removeEventListener(event, bump))
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [isUnlocked, autoLockMinutes, dropSecret])

  const activeAccount = accounts.find((account) => account.index === activeIndex) ?? accounts[0] ?? null

  const value = useMemo<WalletContextValue>(
    () => ({
      ready,
      initializationError,
      vaultExists: Boolean(vault),
      vault,
      meta,
      keypair,
      unlocked: keypair !== null,
      viewOnly,
      canView: keypair !== null || viewOnly,
      createWallet,
      unlock,
      lock,
      resetWallet,
      updateMeta,
      verifyPin,
      restoreBackup,
      requestAuth,
      endAuthSession,
      accounts,
      activeIndex,
      activeAccount,
      switchAccount,
      addAccount,
      removeAccount,
      renameAccount,
    }),
    [
      ready,
      initializationError,
      vault,
      meta,
      keypair,
      viewOnly,
      createWallet,
      unlock,
      lock,
      resetWallet,
      updateMeta,
      verifyPin,
      restoreBackup,
      requestAuth,
      endAuthSession,
      accounts,
      activeIndex,
      activeAccount,
      switchAccount,
      addAccount,
      removeAccount,
      renameAccount,
    ],
  )

  return (
    <WalletContext.Provider value={value}>
      {children}
      {/* The PIN check lives above every screen, so an action can never reach
          the key without passing it. */}
      <AuthPrompt purpose={authPurpose} onCancel={cancelAuth} onSubmit={resolveAuth} />
    </WalletContext.Provider>
  )
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext)
  if (!context) throw new Error('useWallet must be used inside WalletProvider')
  return context
}

export { InvalidPinError }
