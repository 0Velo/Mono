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
  isVaultShape,
  type SecretPayload,
  type Vault,
} from '../lib/vault'
import { loadKeys } from '../lib/keys'
import {
  BiometricError,
  biometricSupportedByBrowser,
  clearEnrolment,
  enrol,
  hasEnrolment,
  isPlatformAuthenticatorAvailable,
  readRecord,
  unlockWithBiometric,
  type BiometricMode,
} from '../lib/biometric'
import { loadVault, saveVault, clearVault } from '../lib/vaultStore'
import type { NetworkId } from '../lib/rpc'

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
}

export interface WalletAccount {
  index: number
  address: string
  name: string
}

const DEFAULT_META: Omit<WalletMeta, 'address'> = {
  name: 'Mono',
  network: 'mainnet',
  rpc: { mainnet: '', devnet: '' },
  autoLockMinutes: 5,
  createdAt: Date.now(),
  activeIndex: 0,
  accountNames: {},
}

export function accountLabel(meta: WalletMeta | null, index: number): string {
  const custom = meta?.accountNames?.[String(index)]
  if (custom && custom.trim()) return custom.trim()
  return index === 0 ? '메인' : `계정 ${index + 1}`
}

interface WalletContextValue {
  ready: boolean
  vaultExists: boolean
  vault: Vault | null
  meta: WalletMeta | null
  keypair: Keypair | null
  unlocked: boolean
  createWallet: (payload: SecretPayload, pin: string) => Promise<void>
  unlock: (pin: string) => Promise<void>
  lock: () => void
  resetWallet: () => void
  updateMeta: (patch: Partial<WalletMeta>) => void
  verifyPin: (pin: string) => Promise<SecretPayload>
  restoreBackup: (vault: Vault, pin: string, addressHint?: string) => Promise<void>

  /** Accounts derived from the same seed phrase. A single key shows one. */
  accounts: WalletAccount[]
  activeIndex: number
  activeAccount: WalletAccount | null
  switchAccount: (index: number) => Promise<void>
  renameAccount: (index: number, name: string) => void

  /** Face ID state, driven by `lib/biometric.ts`. */
  /** The browser exposes WebAuthn at all — this is what shows the toggle. */
  biometricSupported: boolean
  /** The platform-authenticator hint; may be false on iOS yet still work. */
  biometricAvailable: boolean
  biometricEnabled: boolean
  biometricMode: BiometricMode | null
  biometricCreatedAt: number | null
  unlockWithFaceId: () => Promise<void>
  enrolBiometric: (payload?: SecretPayload) => Promise<void>
  disableBiometric: () => void
  biometricError: string | null
}

const WalletContext = createContext<WalletContextValue | null>(null)

function readMeta(): WalletMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY) ?? localStorage.getItem(LEGACY_META_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<WalletMeta>
    if (!parsed?.address) return null
    return {
      ...DEFAULT_META,
      ...parsed,
      address: parsed.address,
      rpc: { ...DEFAULT_META.rpc, ...(parsed.rpc ?? {}) },
      accountNames: { ...(parsed.accountNames ?? {}) },
      accountIndices: Array.isArray(parsed.accountIndices)
        ? parsed.accountIndices.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 100)
        : [],
      activeIndex: Math.max(0, Number(parsed.activeIndex) || 0),
    }
  } catch {
    return null
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

/** The seed indices worth deriving: the base three, plus anything renamed. */
function accountIndices(activeIndex: number, names?: Record<string, string>, saved?: number[]): number[] {
  const set = new Set<number>([0, Math.max(0, activeIndex), ...(saved ?? [])])
  Object.keys(names ?? {}).forEach((key) => {
    const index = Number(key)
    if (Number.isInteger(index) && index >= 0 && index < 100) set.add(index)
  })
  return Array.from(set).sort((a, b) => a - b)
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const [vault, setVault] = useState<Vault | null>(null)
  const [meta, setMeta] = useState<WalletMeta | null>(null)
  const [keypair, setKeypairState] = useState<Keypair | null>(null)
  const [accounts, setAccounts] = useState<WalletAccount[]>([])
  const [activeIndex, setActiveIndex] = useState(0)

  // Kept in memory only, so Face ID can be enabled from Settings without
  // asking for the PIN again. It is wiped on lock and never persisted.
  const payloadRef = useRef<SecretPayload | null>(null)
  const keypairRef = useRef<Keypair | null>(null)

  const [biometricSupported] = useState<boolean>(() => biometricSupportedByBrowser())
  const [biometricAvailable, setBiometricAvailable] = useState(false)
  const [biometricEnabled, setBiometricEnabled] = useState(false)
  const [biometricMode, setBiometricMode] = useState<BiometricMode | null>(null)
  const [biometricCreatedAt, setBiometricCreatedAt] = useState<number | null>(null)
  const [biometricError, setBiometricError] = useState<string | null>(null)

  const setKeypair = useCallback((next: Keypair | null) => {
    keypairRef.current = next
    setKeypairState(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const stored = await loadVault()
      const storedMeta = readMeta()
      const record = readRecord()
      if (cancelled) return
      setVault(stored)
      setMeta(storedMeta)
      setBiometricEnabled(Boolean(record))
      setBiometricMode(record?.mode ?? null)
      setBiometricCreatedAt(record?.createdAt ?? null)
      setReady(true)
    })()

    void isPlatformAuthenticatorAvailable().then((available) => {
      if (!cancelled) setBiometricAvailable(available)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const persistMeta = useCallback((next: WalletMeta) => {
    setMeta(next)
    try {
      localStorage.setItem(META_KEY, JSON.stringify(next))
      localStorage.removeItem(LEGACY_META_KEY)
    } catch {
      /* storage full / private mode */
    }
  }, [])

  /**
   * Turns a decrypted payload into the live keypair plus the account list.
   * For a mnemonic wallet the active account may be any index; a raw-key
   * wallet has exactly one account.
   */
  const applyPayload = useCallback(
    async (payload: SecretPayload) => {
      const stored = readMeta()
      payloadRef.current = payload

      if (payload.kind === 'mnemonic') {
        const { deriveAccounts } = await loadKeys()
        const index = Math.max(0, stored?.activeIndex ?? 0)
        const indices = accountIndices(index, stored?.accountNames, stored?.accountIndices)
        const keypairs = deriveAccounts(payload.mnemonic, indices)
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
        setAccounts(list)
        setActiveIndex(index)
        setKeypair(active)
        if (stored && stored.address !== active.publicKey.toBase58()) {
          persistMeta({ ...stored, address: active.publicKey.toBase58() })
        }
        return
      }

      const { keypairFromPayload } = await loadKeys()
      const kp = keypairFromPayload(payload)
      const address = kp.publicKey.toBase58()
      setActiveIndex(0)
      setAccounts([{ index: 0, address, name: accountLabel(stored, 0) }])
      setKeypair(kp)
      if (stored && stored.address !== address) {
        persistMeta({ ...stored, address, activeIndex: 0 })
      }
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
      }
      try {
        localStorage.setItem(META_KEY, JSON.stringify(nextMeta))
      } catch {
        /* private mode */
      }
      payloadRef.current = payload
      setVault(nextVault)
      setMeta(nextMeta)
      setActiveIndex(0)
      setAccounts([{ index: 0, address: nextMeta.address, name: accountLabel(nextMeta, 0) }])
      setKeypair(kp)
    },
    [setKeypair],
  )

  const unlock = useCallback(
    async (pin: string) => {
      const current = vault ?? (await loadVault())
      if (!current) throw new Error('지갑이 없습니다.')
      const payload = await decryptSecret(current, pin)
      setVault(current)
      await applyPayload(payload)
    },
    [vault, applyPayload],
  )

  /** Lock = drop every decrypted byte we hold, not just the React state. */
  const lock = useCallback(() => {
    wipeKeypair(keypairRef.current)
    setKeypair(null)
    payloadRef.current = null
    setAccounts([])
  }, [setKeypair])

  const restoreBackup = useCallback(
    async (nextVault: Vault, pin: string, addressHint?: string) => {
      const payload = await decryptSecret(nextVault, pin)
      const { keypairFromPayload } = await loadKeys()
      const kp = keypairFromPayload(payload)
      const address = kp.publicKey.toBase58()
      if (addressHint && addressHint !== address) {
        wipeKeypair(kp)
        throw new Error('백업 파일의 주소가 PIN과 맞지 않습니다.')
      }
      await saveVault(nextVault)
      const nextMeta: WalletMeta = {
        ...DEFAULT_META,
        address,
        createdAt: nextVault.createdAt ?? Date.now(),
      }
      try {
        localStorage.setItem(META_KEY, JSON.stringify(nextMeta))
      } catch {
        /* private mode */
      }
      // A Face ID credential from another wallet must not outlive the restore.
      clearEnrolment()
      setBiometricEnabled(false)
      setBiometricMode(null)
      setBiometricCreatedAt(null)
      payloadRef.current = payload
      setVault(nextVault)
      setMeta(nextMeta)
      setActiveIndex(0)
      setAccounts([{ index: 0, address, name: accountLabel(nextMeta, 0) }])
      setKeypair(kp)
    },
    [setKeypair],
  )

  const resetWallet = useCallback(() => {
    void clearVault()
    try {
      localStorage.removeItem(META_KEY)
      localStorage.removeItem(LEGACY_META_KEY)
    } catch {
      /* ignore */
    }
    clearEnrolment()
    wipeKeypair(keypairRef.current)
    payloadRef.current = null
    setVault(null)
    setMeta(null)
    setKeypair(null)
    setAccounts([])
    setActiveIndex(0)
    setBiometricEnabled(false)
    setBiometricMode(null)
    setBiometricCreatedAt(null)
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
      if (!payload || payload.kind !== 'mnemonic') return
      if (index === activeIndex) return
      const { keypairForAccount } = await loadKeys()
      const next = keypairForAccount(payload.mnemonic, index)
      wipeKeypair(keypairRef.current)
      setKeypair(next)
      setActiveIndex(index)
      const address = next.publicKey.toBase58()
      const base = meta ?? readMeta()
      if (base) {
        const ids = Array.from(
          new Set([...(base.accountIndices ?? []), ...(index > 0 ? [index] : [])]),
        )
        persistMeta({ ...base, address, activeIndex: index, accountIndices: ids })
      }
      setAccounts((current) => {
        if (current.some((account) => account.index === index)) return current
        return [...current, { index, address, name: accountLabel(base, index) }].sort(
          (a, b) => a.index - b.index,
        )
      })
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
      setAccounts((current) =>
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

  /* ------------------------------------------------------------- face id */

  const enrolBiometric = useCallback(async (payload?: SecretPayload) => {
    const secret = payload ?? payloadRef.current
    if (!secret) {
      throw new BiometricError('error', 'PIN으로 한 번 잠금 해제한 뒤 다시 시도해 주세요.')
    }
    setBiometricError(null)
    try {
      const record = await enrol(secret)
      setBiometricEnabled(true)
      setBiometricMode(record.mode)
      setBiometricCreatedAt(record.createdAt)
    } catch (error) {
      const message =
        error instanceof BiometricError
          ? error.message
          : 'Face ID를 등록하지 못했습니다. PIN을 계속 사용할 수 있습니다.'
      setBiometricError(message)
      throw error
    }
  }, [])

  const disableBiometric = useCallback(() => {
    clearEnrolment()
    setBiometricEnabled(false)
    setBiometricMode(null)
    setBiometricCreatedAt(null)
    setBiometricError(null)
  }, [])

  const unlockWithFaceId = useCallback(async () => {
    setBiometricError(null)
    try {
      const payload = await unlockWithBiometric()
      const current = vault ?? (await loadVault())
      if (current) setVault(current)
      await applyPayload(payload)
    } catch (error) {
      if (error instanceof BiometricError) {
        setBiometricError(error.message)
        // A stale record would keep failing: drop it so the PIN stays the way in.
        if (error.reason === 'corrupt' || error.reason === 'prf' || error.reason === 'unsupported') {
          clearEnrolment()
          setBiometricEnabled(false)
          setBiometricMode(null)
          setBiometricCreatedAt(null)
        }
      }
      throw error
    }
  }, [vault, applyPayload])

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
      wipeKeypair(keypairRef.current)
      payloadRef.current = null
      setKeypair(null)
      setAccounts([])
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
    // payload, and return the UI to the locked state. Wiping only the key bytes
    // left `unlocked` true with a dead keypair, so the next send signed garbage
    // while the mnemonic was still in memory.
    const onPageHide = () => {
      lock()
    }
    window.addEventListener('pagehide', onPageHide)

    return () => {
      events.forEach((event) => window.removeEventListener(event, bump))
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [isUnlocked, autoLockMinutes, lock, setKeypair])

  const activeAccount = accounts.find((account) => account.index === activeIndex) ?? accounts[0] ?? null

  const value = useMemo<WalletContextValue>(
    () => ({
      ready,
      vaultExists: Boolean(vault),
      vault,
      meta,
      keypair,
      unlocked: keypair !== null,
      createWallet,
      unlock,
      lock,
      resetWallet,
      updateMeta,
      verifyPin,
      restoreBackup,
      accounts,
      activeIndex,
      activeAccount,
      switchAccount,
      renameAccount,
      biometricAvailable,
      biometricSupported,
      biometricEnabled,
      biometricMode,
      biometricCreatedAt,
      unlockWithFaceId,
      enrolBiometric,
      disableBiometric,
      biometricError,
    }),
    [
      ready,
      vault,
      meta,
      keypair,
      createWallet,
      unlock,
      lock,
      resetWallet,
      updateMeta,
      verifyPin,
      restoreBackup,
      accounts,
      activeIndex,
      activeAccount,
      switchAccount,
      renameAccount,
      biometricAvailable,
      biometricSupported,
      biometricEnabled,
      biometricMode,
      biometricCreatedAt,
      unlockWithFaceId,
      enrolBiometric,
      disableBiometric,
      biometricError,
    ],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext)
  if (!context) throw new Error('useWallet must be used inside WalletProvider')
  return context
}

export { InvalidPinError, hasEnrolment }
