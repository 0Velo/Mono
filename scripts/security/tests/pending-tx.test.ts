import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearPendingTransaction,
  readPendingTransaction,
  savePendingTransaction,
  withPendingTransactionLock,
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

class FakeLockManager {
  private readonly active = new Set<string>()

  async request<T>(
    name: string,
    _options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: object | null) => Promise<T>,
  ): Promise<T> {
    if (this.active.has(name)) return callback(null)
    this.active.add(name)
    try {
      return await callback({})
    } finally {
      this.active.delete(name)
    }
  }
}

function installLocks(t: { after: (fn: () => void) => void }, locks?: FakeLockManager): void {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: locks ? { locks } : {},
  })
  t.after(() => {
    if (prior) Object.defineProperty(globalThis, 'navigator', prior)
    else Reflect.deleteProperty(globalThis, 'navigator')
  })
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

test('an existing uncertain signature cannot be overwritten by a later attempt', (t) => {
  const storage = installStorage(t)
  savePendingTransaction(record)
  const replacement = { ...record, signature: '4'.repeat(64), createdAt: record.createdAt + 1 }
  assert.throws(() => savePendingTransaction(replacement), /저장하지 못했습니다/)
  assert.deepEqual(readPendingTransaction(owner, 'devnet'), record)
  assert.equal(storage.values.size, 1)
})

test('a stale terminal check cannot delete a newer signature marker', (t) => {
  const storage = installStorage(t)
  const newer = { ...record, signature: '5'.repeat(64), createdAt: record.createdAt + 1 }
  storage.values.set('mono.pending-tx.v1:devnet:' + owner, JSON.stringify(newer))
  clearPendingTransaction(owner, 'devnet', record.signature)
  assert.deepEqual(readPendingTransaction(owner, 'devnet'), newer)
})

test('the same owner/network lock excludes concurrent send and swap workflows', async (t) => {
  installStorage(t)
  installLocks(t, new FakeLockManager())
  let releaseFirst!: () => void
  let started!: () => void
  const firstStarted = new Promise<void>((resolve) => { started = resolve })
  const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve })
  let operationCount = 0
  const first = withPendingTransactionLock(owner, 'devnet', async () => {
    operationCount += 1
    started()
    await holdFirst
    return 'send'
  })
  await firstStarted
  const second = await withPendingTransactionLock(owner, 'devnet', async () => {
    operationCount += 1
    return 'swap'
  })
  assert.deepEqual(second, { kind: 'busy' })
  assert.equal(operationCount, 1)
  releaseFirst()
  assert.deepEqual(await first, { kind: 'completed', value: 'send' })
  const afterRelease = await withPendingTransactionLock(owner, 'devnet', async () => 'swap')
  assert.deepEqual(afterRelease, { kind: 'completed', value: 'swap' })
})

test('a pending signature is returned without running another operation', async (t) => {
  installStorage(t)
  installLocks(t, new FakeLockManager())
  savePendingTransaction(record)
  let called = false
  const result = await withPendingTransactionLock(owner, 'devnet', async () => {
    called = true
  })
  assert.deepEqual(result, { kind: 'pending', record })
  assert.equal(called, false)
})

test('an error after signature persistence releases the lock but preserves the blocking signature', async (t) => {
  installStorage(t)
  installLocks(t, new FakeLockManager())
  await assert.rejects(withPendingTransactionLock(owner, 'devnet', async () => {
    savePendingTransaction(record)
    throw new Error('simulated tab failure after the signed marker was persisted')
  }), /simulated tab failure/)
  const retry = await withPendingTransactionLock(owner, 'devnet', async () => 'should not run')
  assert.deepEqual(retry, { kind: 'pending', record })
})

test('browsers without Web Locks fail closed instead of starting a send', async (t) => {
  installStorage(t)
  installLocks(t)
  let called = false
  await assert.rejects(
    withPendingTransactionLock(owner, 'devnet', async () => { called = true }),
    /안전 잠금을 지원하지 않아 전송을 시작하지 않았습니다/,
  )
  assert.equal(called, false)
})

test('tampered owner, network, or missing validity height is rejected', (t) => {
  const storage = installStorage(t)
  const key = 'mono.pending-tx.v1:devnet:' + owner
  storage.values.set(key, JSON.stringify({ ...record, owner: 'another-owner' }))
  assert.throws(() => readPendingTransaction(owner, 'devnet'), /검증하지 못해 새 전송을 막았습니다/)
  storage.values.set(key, JSON.stringify({ ...record, lastValidBlockHeight: null }))
  assert.throws(() => readPendingTransaction(owner, 'devnet'), /검증하지 못해 새 전송을 막았습니다/)
})
