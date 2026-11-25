import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { fetchHandler } from '../../../push-server/src/handler.js'
import {
  createManagementToken,
  pushSubscriptionId,
  signPushAssociation,
  synchronizePushAssociation,
} from '../../../src/lib/pushSubscriptions'

/**
 * The deployed Vercel server keeps the browser-facing contract the client in
 * `src/lib/pushSubscriptions.ts` already speaks. These tests drive that client
 * against the server handler with an in-memory store, so a change to either
 * side that breaks the contract fails here instead of on a phone.
 */

class MemoryKv {
  data = new Map<string, string>()
  async get(key: string) { return this.data.get(key) ?? null }
  async put(key: string, value: string) { this.data.set(key, String(value)) }
  async delete(key: string) { this.data.delete(key) }
  async list({ prefix = '', limit = 1000 } = {}) {
    const keys = [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name }))
    return { keys, list_complete: keys.length < limit }
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const APP_ORIGIN = 'https://0velo.github.io'
const SERVER = 'https://mono-push.vercel.app'

function serverEnv(kv: MemoryKv, extra: Record<string, unknown> = {}) {
  return { APP_ORIGIN, VAPID_PUBLIC_KEY: encodeBase64Url(new Uint8Array([4, ...new Uint8Array(64)])), ...extra }
}

function jsonRequest(path: string, method: string, body: unknown) {
  return new Request(`${SERVER}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
    body: JSON.stringify(body),
  })
}

test('deployed server answers the client config probe with a 65-byte VAPID key', async () => {
  const kv = new MemoryKv()
  const env = serverEnv(kv)
  const response = await fetchHandler(new Request(`${SERVER}/v1/config`, { headers: { Origin: APP_ORIGIN } }), env, kv)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0')
  assert.equal(response.headers.get('access-control-allow-origin'), APP_ORIGIN)
  assert.deepEqual(await response.json(), { vapidPublicKey: env.VAPID_PUBLIC_KEY })
})

test('a real client-signed registration is accepted and can be revoked by its management token', async () => {
  const kv = new MemoryKv()
  const env = serverEnv(kv)
  const keypair = Keypair.generate()
  const endpoint = 'https://web.push.apple.com/QGVsbG8tc3ludGhldGljLWVuZHBvaW50'
  const input = {
    subscription: {
      endpoint,
      keys: { p256dh: encodeBase64Url(new Uint8Array([4, ...new Uint8Array(64).fill(9)])), auth: encodeBase64Url(new Uint8Array(16).fill(3)) },
    },
    address: keypair.publicKey.toBase58(),
    network: 'mainnet' as const,
    managementToken: createManagementToken(),
    issuedAt: Date.now(),
  }
  let status = 0
  const synced = await synchronizePushAssociation(input, {
    sign: (message) => signPushAssociation(message, keypair),
    post: async (body) => {
      const response = await fetchHandler(jsonRequest('/v1/subscriptions', 'POST', body), env, kv)
      status = response.status
      assert.equal(JSON.stringify(await response.clone().json()).includes(endpoint), false)
    },
    saveAssociation: () => {},
  })
  assert.equal(synced, true)
  assert.equal(status, 201)
  const id = await pushSubscriptionId(endpoint)
  const stored = JSON.parse(kv.data.get(`sub/${id}`) as string)
  assert.equal(stored.network, 'mainnet-beta')
  assert.equal(stored.address, input.address)
  assert.equal(JSON.stringify(stored).includes(input.managementToken), false)

  const revoked = await fetchHandler(jsonRequest(`/v1/subscriptions/${id}`, 'DELETE', { managementToken: input.managementToken }), env, kv)
  assert.equal(revoked.status, 200)
  assert.deepEqual(await revoked.json(), { disabled: true })
  assert.equal(kv.data.has(`sub/${id}`), false)

  const again = await fetchHandler(jsonRequest(`/v1/subscriptions/${id}`, 'DELETE', { managementToken: input.managementToken }), env, kv)
  assert.equal(again.status, 404)
})

test('a foreign origin and an unsigned request are refused without writing', async () => {
  const kv = new MemoryKv()
  const env = serverEnv(kv)
  const foreign = await fetchHandler(new Request(`${SERVER}/v1/config`, { headers: { Origin: 'https://evil.example' } }), env, kv)
  assert.equal(foreign.status, 403)
  const unsigned = await fetchHandler(new Request(`${SERVER}/v1/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
    body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'a', auth: 'b' } } }),
  }), env, kv)
  assert.equal(unsigned.status, 400)
  assert.equal(kv.data.size, 0)
})

test('a server without its database fails closed instead of accepting registrations', async () => {
  const env = serverEnv(new MemoryKv())
  const response = await fetchHandler(new Request(`${SERVER}/v1/config`, { headers: { Origin: APP_ORIGIN } }), env, null as never)
  assert.equal(response.status, 503)
})
