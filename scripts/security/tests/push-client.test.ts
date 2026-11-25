import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { fetchHandler } from '../../../push-worker/src/worker.js'
import {
  canonicalPushAssociation,
  createManagementToken,
  pushSubscriptionId,
  serializePushSubscription,
  signPushAssociation,
  synchronizePushAssociation,
  validatePushApiUrl,
} from '../../../src/lib/pushSubscriptions'
import { readRepoFile } from './helpers'

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

class MemoryKv {
  data = new Map<string, string>()
  async get(key: string) { return this.data.get(key) ?? null }
  async put(key: string, value: string) { this.data.set(key, String(value)) }
  async delete(key: string) { this.data.delete(key) }
  async list({ prefix = '', limit = 1000 } = {}) {
    const keys = [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name }))
    return { keys, list_complete: this.data.size <= limit }
  }
}

test('push API accepts one HTTPS base and rejects insecure or credential-bearing URLs', () => {
  assert.equal(validatePushApiUrl('https://push.example.test/mono/'), 'https://push.example.test/mono')
  for (const invalid of [
    'http://push.example.test',
    'https://user:secret@push.example.test',
    'https://push.example.test/?target=other',
    'https://push.example.test/#fragment',
    'not a URL',
  ]) {
    assert.throws(() => validatePushApiUrl(invalid))
  }
})

test('subscription serializer accepts only an HTTPS endpoint and the two required keys', () => {
  const value = serializePushSubscription({
    toJSON: () => ({
      endpoint: 'https://push.example.test/subscription/opaque',
      keys: { p256dh: 'client-key', auth: 'client-auth' },
    }),
  })
  assert.deepEqual(value, {
    endpoint: 'https://push.example.test/subscription/opaque',
    keys: { p256dh: 'client-key', auth: 'client-auth' },
  })
  assert.throws(() => serializePushSubscription({
    toJSON: () => ({ endpoint: 'http://push.example.test/subscription', keys: { p256dh: 'a', auth: 'b' } }),
  } as any))
  assert.throws(() => serializePushSubscription({ toJSON: () => ({ endpoint: 'https://push.example.test' }) } as any))
})

test('association canonicalization hashes endpoint and management token and subscription ID hashes endpoint', async () => {
  const address = Keypair.generate().publicKey.toBase58()
  const endpoint = 'https://push.example.test/opaque'
  const token = createManagementToken()
  const canonical = await canonicalPushAssociation(address, 'devnet', 1_800_000_000_123, endpoint, token)
  assert.equal(
    canonical,
    [
      'MONO-PUSH-V1',
      address,
      'devnet',
      '1800000000',
      await (async () => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      })(),
      await (async () => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      })(),
    ].join('\n'),
  )
  assert.equal(await pushSubscriptionId(endpoint), await (async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  })())
  assert.equal(decodeBase64Url(token).length, 32)
  let requestedBytes = 0
  const mockedToken = createManagementToken({
    getRandomValues: (bytes: Uint8Array) => {
      requestedBytes = bytes.length
      bytes.fill(7)
      return bytes
    },
  } as any)
  assert.equal(requestedBytes, 32)
  assert.equal(decodeBase64Url(mockedToken).length, 32)
})

test('Ed25519 association signature verifies against the synthetic wallet public key only', async () => {
  const keypair = Keypair.generate()
  const message = 'MONO-PUSH-V1\nsynthetic-address\nmainnet\n1\nendpoint-hash\ntoken-hash'
  const encoded = await signPushAssociation(message, keypair)
  const publicKey = await crypto.subtle.importKey('raw', keypair.publicKey.toBytes(), { name: 'Ed25519' }, false, ['verify'])
  assert.equal(
    await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, decodeBase64Url(encoded), new TextEncoder().encode(message)),
    true,
  )
  assert.equal(
    await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, decodeBase64Url(encoded), new TextEncoder().encode(`${message}!`)),
    false,
  )
  const wiped = {
    secretKey: new Uint8Array(64),
    publicKey: keypair.publicKey,
  } as unknown as Keypair
  await assert.rejects(() => signPushAssociation(message, wiped), /키를 확인/)
})

test('association sync posts only contract fields and persists the association after success', async () => {
  const input = {
    subscription: { endpoint: 'https://push.example.test/opaque', keys: { p256dh: 'public-client-key', auth: 'client-auth' } },
    address: Keypair.generate().publicKey.toBase58(),
    network: 'mainnet' as const,
    managementToken: createManagementToken(),
    issuedAt: 1_800_000_000_123,
  }
  const posts: any[] = []
  let signedCanonical = ''
  let saved: unknown = null
  const synced = await synchronizePushAssociation(input, {
    sign: async (message) => {
      signedCanonical = message
      return 'synthetic-signature'
    },
    post: async (body) => { posts.push(body) },
    saveAssociation: (association) => { saved = association },
  })
  assert.equal(synced, true)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].signature, 'synthetic-signature')
  assert.deepEqual(posts[0].subscription, input.subscription)
  assert.equal(posts[0].network, 'mainnet-beta')
  assert.equal(posts[0].issuedAt, '1800000000')
  assert.equal(posts[0].managementToken, input.managementToken)
  assert.deepEqual(saved, { address: input.address, network: 'mainnet', issuedAt: input.issuedAt })
  assert.match(signedCanonical, /^MONO-PUSH-V1\n/)
  assert.equal('privateKey' in posts[0], false)
  assert.equal('secretKey' in posts[0], false)
  assert.equal('seed' in posts[0], false)
})

test('client registration payloads for both networks are accepted by the Worker contract', async () => {
  const kv = new MemoryKv()
  const env = { SUBSCRIPTIONS: kv, APP_ORIGIN: 'https://app.example.test' }
  const pushKey = encodeBase64Url(new Uint8Array([4, ...new Uint8Array(64)]))
  const auth = encodeBase64Url(new Uint8Array(16).fill(7))

  for (const network of ['mainnet', 'devnet'] as const) {
    const keypair = Keypair.generate()
    const input = {
      subscription: {
        endpoint: `https://fcm.googleapis.com/fcm/send/integration-${network}`,
        keys: { p256dh: pushKey, auth },
      },
      address: keypair.publicKey.toBase58(),
      network,
      managementToken: createManagementToken(),
      issuedAt: Date.now(),
    }
    let workerStatus = 0
    const synced = await synchronizePushAssociation(input, {
      sign: (message) => signPushAssociation(message, keypair),
      post: async (body) => {
        const response = await fetchHandler(new Request('https://worker.example/v1/subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: env.APP_ORIGIN },
          body: JSON.stringify(body),
        }), env, {})
        workerStatus = response.status
        assert.ok([201, 200].includes(response.status), await response.text())
      },
      saveAssociation: () => {},
    })

    assert.equal(synced, true)
    assert.equal(workerStatus, 201)
    const record = [...kv.data.entries()]
      .filter(([key]) => key.startsWith('sub/'))
      .map(([, value]) => JSON.parse(value))
      .find((value) => value.address === input.address)
    assert.ok(record)
    assert.equal(record.address, input.address)
    assert.equal(record.network, network === 'mainnet' ? 'mainnet-beta' : 'devnet')
  }
})

test('stale wallet/network sync stops after signing and never posts', async () => {
  const input = {
    subscription: { endpoint: 'https://push.example.test/opaque', keys: { p256dh: 'client-key', auth: 'client-auth' } },
    address: Keypair.generate().publicKey.toBase58(),
    network: 'devnet' as const,
    managementToken: createManagementToken(),
    issuedAt: 1_800_000_000_123,
  }
  let current = true
  let postCount = 0
  let saveCount = 0
  const synced = await synchronizePushAssociation(input, {
    sign: async () => { current = false; return 'signature' },
    post: async () => { postCount += 1 },
    saveAssociation: () => { saveCount += 1 },
    isCurrent: () => current,
  })
  assert.equal(synced, false)
  assert.equal(postCount, 0)
  assert.equal(saveCount, 0)
})

test('activity monitor and token detail hold data to their current scopes and show unknown while loading', () => {
  const monitor = readRepoFile('src/components/ActivityMonitor.tsx')
  assert.match(monitor, /accountsSnapshot\.network === network/)
  assert.match(monitor, /accountsSnapshot\.rpc === rpc/)
  assert.match(monitor, /if \(!cancelled\) setAccountsSnapshot/)
  const detail = readRepoFile('src/sheets/TokenDetailSheet.tsx')
  assert.match(detail, /portfolioReady\s*\?/)
  assert.match(detail, /'보유 — · —'/)
  const shell = readRepoFile('src/Shell.tsx')
  assert.match(shell, /portfolioReady=\{Boolean\(portfolio\.data\)\}/)
})
