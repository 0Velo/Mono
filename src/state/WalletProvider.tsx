import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Keypair } from '@solana/web3.js'
import {
  InvalidPinError,
  decryptSecret,
  encryptSecret,
  isVaultShape,
  type SecretPayload,
  type Vault,
} from '../lib/vault'
import { keypairFromPayload } from '../lib/wallet'
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

  useEffect(() => {
    setVault(readVault())
    setMeta(readMeta())
    setReady(true)
  }, [])

  const persistMeta = useCallback((next: WalletMeta) => {
    setMeta(next)
    try {
      localStorage.setItem(META_KEY, JSON.stringify(next))
    } catch {
      /* storage full / private mode */
    }
  }, [])

  const createWallet = useCallback(
    async (payload: SecretPayload, pin: string) => {
      const kp = keypairFromPayload(payload)
      const nextVault = await encryptSecret(payload, pin)
      localStorage.setItem(VAULT_KEY, JSON.stringify(nextVault))
      const nextMeta: WalletMeta = {
        ...DEFAULT_META,
        address: kp.publicKey.toBase58(),
        createdAt: Date.now(),
      }
      localStorage.setItem(META_KEY, JSON.stringify(nextMeta))
      setVault(nextVault)
      setMeta(nextMeta)
      setKeypair(kp)
    },
    [],
  )

  const unlock = useCallback(
    async (pin: string) => {
      const current = vault ?? readVault()
      if (!current) throw new Error('지갑이 없습니다.')
      const payload = await decryptSecret(current, pin)
      const kp = keypairFromPayload(payload)
      setVault(current)
      setKeypair(kp)
      if (!meta) {
        const stored = readMeta()
        if (stored) setMeta(stored)
      }
    },
    [vault, meta],
  )

  const lock = useCallback(() => {
    setKeypair(null)
  }, [])

  const resetWallet = useCallback(() => {
    localStorage.removeItem(VAULT_KEY)
    localStorage.removeItem(META_KEY)
    setVault(null)
    setMeta(null)
    setKeypair(null)
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
      }
    }, 15_000)

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (autoLockMinutes > 0 && Date.now() - lastActivity.current > autoLockMinutes * 60_000) {
          setKeypair(null)
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
    ],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext)
  if (!context) throw new Error('useWallet must be used inside WalletProvider')
  return context
}

export { InvalidPinError }
