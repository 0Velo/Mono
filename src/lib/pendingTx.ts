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

function storageKey(owner: string, network: NetworkId): string {
  return `${KEY_PREFIX}:${network}:${owner}`
}

export function readPendingTransaction(owner: string, network: NetworkId): PendingTransaction | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(storageKey(owner, network))
  } catch {
    throw new Error('저장된 전송 상태를 확인할 수 없어 새 전송을 막았습니다.')
  }
  if (!raw) return null
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
    localStorage.setItem(storageKey(record.owner, record.network), JSON.stringify(record))
  } catch {
    throw new Error('전송 상태를 저장하지 못했습니다. 안전을 위해 RPC 전송을 시작하지 않았습니다.')
  }
}

export function clearPendingTransaction(owner: string, network: NetworkId): void {
  try {
    localStorage.removeItem(storageKey(owner, network))
  } catch {
    throw new Error('전송 결과는 확인됐지만 기록을 지우지 못했습니다. 다음 전송 전에 상태를 다시 확인하세요.')
  }
}
