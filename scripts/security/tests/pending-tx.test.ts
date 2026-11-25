import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearPendingTransaction,
  readPendingTransaction,
  savePendingTransaction,
  type PendingTransaction,
} from '../../../src/lib/pendingTx'

class MemoryStorage {
  values = new Map<string, string>()
  failGet = false
  failSet = false
  failRemove = false

  getItem(key: string): string | null {
    if (this.failGet) throw new Error('blocked')
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failSet) throw new Error('quota')
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    if (this.failRemove) throw new Error('blocked')
    this.values.delete(key)
  }
}

function installStorage(t: { after: (fn: () => void) => void }): MemoryStorage {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  t.after(() => {
    if (prior) Object.defineProperty(globalThis, 'localStorage', prior)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  return storage
}

const owner = '11111111111111111111111111111111'
const record: PendingTransaction = {
  version: 1,
  network: 'devnet',
  owner,
  signature: '3'.repeat(64),
  blockhash: 'recent-blockhash',
  lastValidBlockHeight: 123,
  createdAt: 1_700_000_000_000,
  kind: 'sol',
  symbol: 'SOL',
  amount: '25000000',
}

test('pending transaction records round-trip by owner and network', (t) => {
  installStorage(t)
  savePendingTransaction(record)
  assert.deepEqual(readPendingTransaction(owner, 'devnet'), record)
  assert.equal(readPendingTransaction(owner, 'mainnet'), null)
  clearPendingTransaction(owner, 'devnet')
  assert.equal(readPendingTransaction(owner, 'devnet'), null)
})

test('corrupt pending JSON blocks a new transaction', (t) => {
  const storage = installStorage(t)
  storage.values.set('mono.pending-tx.v1:devnet:' + owner, '{broken')
  assert.throws(() => readPendingTransaction(owner, 'devnet'), /손상/)
})

test('unavailable storage blocks reads and writes rather than allowing a broadcast', (t) => {
  const storage = installStorage(t)
  storage.failGet = true
  assert.throws(() => readPendingTransaction(owner, 'devnet'), /확인할 수 없어 새 전송을 막았습니다/)
  storage.failGet = false
  storage.failSet = true
  assert.throws(() => savePendingTransaction(record), /저장하지 못했습니다/)
})

test('a failed marker deletion is surfaced so the next send remains blocked', (t) => {
  const storage = installStorage(t)
  savePendingTransaction(record)
  storage.failRemove = true
  assert.throws(() => clearPendingTransaction(owner, 'devnet'), /기록을 지우지 못했습니다/)
  storage.failRemove = false
  assert.deepEqual(readPendingTransaction(owner, 'devnet'), record)
})

test('tampered owner, network, or missing validity height is rejected', (t) => {
  const storage = installStorage(t)
  const key = 'mono.pending-tx.v1:devnet:' + owner
  storage.values.set(key, JSON.stringify({ ...record, owner: 'another-owner' }))
  assert.throws(() => readPendingTransaction(owner, 'devnet'), /검증하지 못해 새 전송을 막았습니다/)
  storage.values.set(key, JSON.stringify({ ...record, lastValidBlockHeight: null }))
  assert.throws(() => readPendingTransaction(owner, 'devnet'), /검증하지 못해 새 전송을 막았습니다/)
})
