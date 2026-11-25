import type { NetworkId } from './rpc'

const KEY_PREFIX = 'mono.pending-tx.v1'

export interface PendingTransaction {
  version: 1
  network: NetworkId
  owner: string
  signature: string
  blockhash: string
  lastValidBlockHeight: number
  createdAt: number
  kind?: 'sol' | 'spl' | 'swap'
  symbol?: string
  amount?: string
}

interface ExclusiveLockOptions {
  mode: 'exclusive'
  ifAvailable: true
}

interface LockManagerLike {
  request<T>(
    name: string,
    options: ExclusiveLockOptions,
    callback: (lock: object | null) => Promise<T>,
  ): Promise<T>
}

export type PendingTransactionLockResult<T> =
  | { kind: 'busy' }
  | { kind: 'pending'; record: PendingTransaction }
  | { kind: 'completed'; value: T }

function storageKey(owner: string, network: NetworkId): string {
  return `${KEY_PREFIX}:${network}:${owner}`
}

function lockName(owner: string, network: NetworkId): string {
  return `${KEY_PREFIX}:exclusive:${network}:${owner}`
}

/**
 * Serialize the full signing/broadcast workflow across same-origin tabs.
 * Browser-managed locks are released if a tab/process dies. Do not use a
 * localStorage or expiring-lease fallback: neither can safely arbitrate a race
 * across contexts or survive a suspended tab without admitting a second send.
 */
export async function withPendingTransactionLock<T>(
  owner: string,
  network: NetworkId,
  operation: () => Promise<T>,
): Promise<PendingTransactionLockResult<T>> {
  let manager: LockManagerLike | undefined
  try {
    manager = (globalThis.navigator as (Navigator & { locks?: LockManagerLike }) | undefined)?.locks
  } catch {
    // Fail closed below if the browser API cannot be accessed.
  }
  if (!manager || typeof manager.request !== 'function') {
    throw new Error('이 브라우저는 탭 간 안전 잠금을 지원하지 않아 전송을 시작하지 않았습니다.')
  }
  return manager.request(
    lockName(owner, network),
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) return { kind: 'busy' }
      const existing = readPendingTransaction(owner, network)
      if (existing) return { kind: 'pending', record: existing }
      return { kind: 'completed', value: await operation() }
    },
  )
}

export function readPendingTransaction(owner: string, network: NetworkId): PendingTransaction | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(storageKey(owner, network))
  } catch {
    throw new Error('저장된 전송 상태를 확인할 수 없어 새 전송을 막았습니다.')
  }
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('저장된 전송 상태가 손상되어 새 전송을 막았습니다. 지원팀에 문의하기 전 지갑 데이터를 지우지 마세요.')
  }
  const record = value as Partial<PendingTransaction> | null
  if (
    !record ||
    record.version !== 1 ||
    record.owner !== owner ||
    record.network !== network ||
    typeof record.signature !== 'string' ||
    record.signature.length < 32 ||
    typeof record.blockhash !== 'string' ||
    !Number.isInteger(record.lastValidBlockHeight) ||
    Number(record.lastValidBlockHeight) < 0
  ) {
    throw new Error('저장된 전송 상태를 검증하지 못해 새 전송을 막았습니다.')
  }
  return record as PendingTransaction
}

export function savePendingTransaction(record: PendingTransaction): void {
  try {
    const key = storageKey(record.owner, record.network)
    if (localStorage.getItem(key) !== null) {
      throw new Error('A pending record already exists')
    }
    localStorage.setItem(key, JSON.stringify(record))
  } catch {
    throw new Error('전송 상태를 저장하지 못했습니다. 안전을 위해 RPC 전송을 시작하지 않았습니다.')
  }
}

export function clearPendingTransaction(
  owner: string,
  network: NetworkId,
  expectedSignature?: string,
): void {
  try {
    const key = storageKey(owner, network)
    if (expectedSignature !== undefined) {
      const current = readPendingTransaction(owner, network)
      // An older confirmation poll must never remove a newer attempt's marker.
      if (!current || current.signature !== expectedSignature) return
    }
    localStorage.removeItem(key)
  } catch {
    throw new Error('전송 결과는 확인됐지만 기록을 지우지 못했습니다. 다음 전송 전에 상태를 다시 확인하세요.')
  }
}
