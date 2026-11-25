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
  createWallet: (payload: SecretPayload, pin: string) => Promise<void>
  unlock: (pin: string) => Promise<void>
  lock: () => void
  resetWallet: () => Promise<void>
  updateMeta: (patch: Partial<WalletMeta>) => void
  verifyPin: (pin: string) => Promise<SecretPayload>
  restoreBackup: (vault: Vault, pin: string, addressHint?: string, accountMetadata?: BackupAccountMetadata) => Promise<void>

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

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const [initializationError, setInitializationError] = useState<string | null>(null)
  const [vault, setVault] = useState<Vault | null>(null)
  const [meta, setMeta] = useState<WalletMeta | null>(null)
  const [keypair, setKeypairState] = useState<Keypair | null>(null)
  const [accounts, setAccounts] = useState<WalletAccount[]>([])
  const [activeIndex, setActiveIndex] = useState(0)

  const payloadRef = useRef<SecretPayload | null>(null)
  const keypairRef = useRef<Keypair | null>(null)

  const setKeypair = useCallback((next: Keypair | null) => {
    keypairRef.current = next
    setKeypairState(next)
  }, [])

  
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
    async (payload: SecretPayload) => {
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
        if (!stored || stored.address !== address) {
          try {
            persistMeta({ ...nextMeta, address, activeIndex: index })
          } catch (error) {
            wipeKeypair(active)
            throw error
          }
        }
        payloadRef.current = payload
        setAccounts(list)
        setActiveIndex(index)
        setKeypair(active)
        return
      }

      const { keypairFromPayload } = await loadKeys()
      const kp = keypairFromPayload(payload)
      const address = kp.publicKey.toBase58()
      if (!stored || stored.address !== address) {
        try {
          persistMeta({ ...(stored ?? { ...DEFAULT_META, address, createdAt: Date.now() }), address, activeIndex: 0 })
        } catch (error) {
          wipeKeypair(kp)
          throw error
        }
      }
      payloadRef.current = payload
      setActiveIndex(0)
      setAccounts([{ index: 0, address, name: accountLabel(stored, 0) }])
      setKeypair(kp)
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
        persistMeta(nextMeta)
      } catch (error) {
        wipeKeypair(kp)
        throw error
      }
      payloadRef.current = payload
      setVault(nextVault)
      setActiveIndex(0)
      setAccounts([{ index: 0, address: nextMeta.address, name: accountLabel(nextMeta, 0) }])
      setKeypair(kp)
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
      const nextMeta: WalletMeta = {
        ...DEFAULT_META,
        address,
        createdAt: nextVault.createdAt ?? Date.now(),
        activeIndex: index,
        accountIndices: visibleIndices.filter((value) => value > 0),
        accountNames,
      }
      try {
        persistMeta(nextMeta)
      } catch (error) {
        wipeKeypair(kp)
        throw error
      }
      payloadRef.current = payload
      setVault(nextVault)
      setActiveIndex(index)
      const accountsForRestore: WalletAccount[] = visibleIndices.map((accountIndex) => {
        const accountKeypair = derived[derivedIndices.indexOf(accountIndex)]
        return {
          index: accountIndex,
          address: accountKeypair?.publicKey.toBase58() ?? (accountIndex === 0 ? address : ''),
          name: accountLabel(nextMeta, accountIndex),
        }
      })
      setAccounts(accountsForRestore.filter((account) => account.address))
      setKeypair(kp)
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
    setAccounts([])
    setActiveIndex(0)
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
        persistMeta({ ...base, address, activeIndex: index, accountIndices: ids })
      } catch (error) {
        wipeKeypair(next)
        throw error
      }
      wipeKeypair(keypairRef.current)
      setKeypair(next)
      setActiveIndex(index)
      setAccounts((current) => {
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
      persistMeta({ ...current, address, activeIndex: index, accountIndices: ids })
    } catch (error) {
      wipeKeypair(next)
      throw error
    }
    wipeKeypair(keypairRef.current)
    setKeypair(next)
    setActiveIndex(index)
    setAccounts((list) => {
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
        persistMeta({ ...base, address, activeIndex: nextActive, accountIndices: ids, accountNames: names })
      } catch (error) {
        wipeKeypair(nextKeypair)
        throw error
      }

      if (nextKeypair) {
        wipeKeypair(keypairRef.current)
        setKeypair(nextKeypair)
      }
      setActiveIndex(nextActive)
      setAccounts((list) =>
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
      initializationError,
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
      addAccount,
      removeAccount,
      renameAccount,
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
