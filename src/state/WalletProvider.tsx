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
  clearEnrolment,
  enrol,
  hasEnrolment,
  isPlatformAuthenticatorAvailable,
  readRecord,
  unlockWithBiometric,
} from '../lib/biometric'
import type { NetworkId } from '../lib/rpc'

const VAULT_KEY = 'solwallet.vault.v1'
const META_KEY = 'solwallet.meta.v1'

export interface WalletMeta {
  address: string
  name: string
  network: NetworkId
  rpc: Record<NetworkId, string>
  autoLockMinutes: number
  createdAt: number
}

const DEFAULT_META: Omit<WalletMeta, 'address'> = {
  name: '내 지갑',
  network: 'mainnet',
  rpc: { mainnet: '', devnet: '' },
  autoLockMinutes: 5,
  createdAt: Date.now(),
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

  /** Face ID state, driven by `lib/biometric.ts`. */
  biometricAvailable: boolean
  biometricEnabled: boolean
  biometricCreatedAt: number | null
  unlockWithFaceId: () => Promise<void>
  enrolBiometric: (payload?: SecretPayload) => Promise<void>
  disableBiometric: () => void
  biometricError: string | null
}

const WalletContext = createContext<WalletContextValue | null>(null)

function readVault(): Vault | null {
  try {
    const raw = localStorage.getItem(VAULT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isVaultShape(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readMeta(): WalletMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as WalletMeta
    if (!parsed?.address) return null
    return {
      ...DEFAULT_META,
      ...parsed,
      rpc: { ...DEFAULT_META.rpc, ...(parsed.rpc ?? {}) },
    }
  } catch {
    return null
  }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const [vault, setVault] = useState<Vault | null>(null)
  const [meta, setMeta] = useState<WalletMeta | null>(null)
  const [keypair, setKeypair] = useState<Keypair | null>(null)

  // Kept in memory only, so Face ID can be enabled from Settings without
  // asking for the PIN again. It is wiped on lock and never persisted.
  const payloadRef = useRef<SecretPayload | null>(null)

  const [biometricAvailable, setBiometricAvailable] = useState(false)
  const [biometricEnabled, setBiometricEnabled] = useState(false)
  const [biometricCreatedAt, setBiometricCreatedAt] = useState<number | null>(null)
  const [biometricError, setBiometricError] = useState<string | null>(null)

  useEffect(() => {
    setVault(readVault())
    setMeta(readMeta())
    const record = readRecord()
    setBiometricEnabled(Boolean(record))
    setBiometricCreatedAt(record?.createdAt ?? null)
    setReady(true)

    let cancelled = false
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
    } catch {
      /* storage full / private mode */
    }
  }, [])

  const createWallet = useCallback(async (payload: SecretPayload, pin: string) => {
    const { keypairFromPayload } = await loadKeys()
    const kp = keypairFromPayload(payload)
    const nextVault = await encryptSecret(payload, pin)
    localStorage.setItem(VAULT_KEY, JSON.stringify(nextVault))
    const nextMeta: WalletMeta = {
      ...DEFAULT_META,
      address: kp.publicKey.toBase58(),
      createdAt: Date.now(),
    }
    localStorage.setItem(META_KEY, JSON.stringify(nextMeta))
    payloadRef.current = payload
    setVault(nextVault)
    setMeta(nextMeta)
    setKeypair(kp)
  }, [])

  const applyPayload = useCallback(
    async (payload: SecretPayload) => {
      const { keypairFromPayload } = await loadKeys()
      const kp = keypairFromPayload(payload)
      payloadRef.current = payload
      setKeypair(kp)
      setMeta((current) => {
        if (current) return current
        const stored = readMeta()
        return stored ?? current
      })
    },
    [],
  )

  const unlock = useCallback(
    async (pin: string) => {
      const current = vault ?? readVault()
      if (!current) throw new Error('지갑이 없습니다.')
      const payload = await decryptSecret(current, pin)
      setVault(current)
      await applyPayload(payload)
    },
    [vault, applyPayload],
  )

  const lock = useCallback(() => {
    payloadRef.current = null
    setKeypair(null)
  }, [])
  const restoreBackup = useCallback(
    async (nextVault: Vault, pin: string, addressHint?: string) => {
      const payload = await decryptSecret(nextVault, pin)
      const { keypairFromPayload } = await loadKeys()
      const kp = keypairFromPayload(payload)
      const address = kp.publicKey.toBase58()
      if (addressHint && addressHint !== address) {
        throw new Error('백업 파일의 주소가 PIN과 맞지 않습니다.')
      }
      localStorage.setItem(VAULT_KEY, JSON.stringify(nextVault))
      const nextMeta: WalletMeta = {
        ...DEFAULT_META,
        address,
        createdAt: nextVault.createdAt ?? Date.now(),
      }
      localStorage.setItem(META_KEY, JSON.stringify(nextMeta))
      // A Face ID credential from another wallet must not outlive the restore.
      clearEnrolment()
      setBiometricEnabled(false)
      setBiometricCreatedAt(null)
      payloadRef.current = payload
      setVault(nextVault)
      setMeta(nextMeta)
      setKeypair(kp)
    },
    [],
  )

  const resetWallet = useCallback(() => {
    localStorage.removeItem(VAULT_KEY)
    localStorage.removeItem(META_KEY)
    clearEnrolment()
    payloadRef.current = null
    setVault(null)
    setMeta(null)
    setKeypair(null)
    setBiometricEnabled(false)
    setBiometricCreatedAt(null)
  }, [])

  const updateMeta = useCallback(
    (patch: Partial<WalletMeta>) => {
      if (!meta) return
      persistMeta({ ...meta, ...patch })
    },
    [meta, persistMeta],
  )

  const verifyPin = useCallback(
    async (pin: string) => {
      const current = vault ?? readVault()
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
    setBiometricCreatedAt(null)
    setBiometricError(null)
  }, [])

  const unlockWithFaceId = useCallback(async () => {
    setBiometricError(null)
    try {
      const payload = await unlockWithBiometric()
      const current = vault ?? readVault()
      if (current) setVault(current)
      await applyPayload(payload)
    } catch (error) {
      if (error instanceof BiometricError) {
        setBiometricError(error.message)
        // A stale record would keep failing: drop it so the PIN stays the way in.
        if (error.reason === 'corrupt' || error.reason === 'prf') {
          clearEnrolment()
          setBiometricEnabled(false)
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

    const timer = window.setInterval(() => {
      if (autoLockMinutes > 0 && Date.now() - lastActivity.current > autoLockMinutes * 60_000) {
        setKeypair(null)
        payloadRef.current = null
      }
    }, 15_000)

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (autoLockMinutes > 0 && Date.now() - lastActivity.current > autoLockMinutes * 60_000) {
          setKeypair(null)
          payloadRef.current = null
        } else {
          lastActivity.current = Date.now()
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      events.forEach((event) => window.removeEventListener(event, bump))
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [isUnlocked, autoLockMinutes])

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
      biometricAvailable,
      biometricEnabled,
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
      biometricAvailable,
      biometricEnabled,
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
