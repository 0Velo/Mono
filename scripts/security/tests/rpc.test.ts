/**
 * Area 6 — network endpoints: custom RPC validation, explorer links, defaults.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RPC,
  explorerAddress,
  explorerTx,
  looksLikeRpc,
  rpcHostLabel,
  rpcUrlFor,
} from '../../../src/lib/rpc'

test('looksLikeRpc accepts https endpoints', () => {
  assert.equal(looksLikeRpc('https://mainnet.helius-rpc.com/?api-key=abc'), true)
  assert.equal(looksLikeRpc('  https://solana-rpc.publicnode.com  '), true)
})

test('looksLikeRpc refuses plain http (the RPC URL is typed in and can be remote)', () => {
  assert.equal(looksLikeRpc('http://example.com'), false)
  assert.equal(looksLikeRpc('http://192.168.0.10:8899'), false)
  assert.equal(looksLikeRpc('http://localhost:8899'), true, 'localhost stays usable for a local validator')
  assert.equal(looksLikeRpc('http://127.0.0.1:8899'), true)
})

test('looksLikeRpc refuses non-http schemes and junk', () => {
  for (const value of ['', '   ', 'javascript:alert(1)', 'data:text/html,<script>', 'ftp://x', 'ws://x', 'example.com']) {
    assert.equal(looksLikeRpc(value), false, value)
  }
})

test('an empty custom RPC falls back to the official default per network', () => {
  assert.equal(rpcUrlFor('mainnet', ''), DEFAULT_RPC.mainnet)
  assert.equal(rpcUrlFor('devnet', null), DEFAULT_RPC.devnet)
  assert.equal(rpcUrlFor('devnet', 'https://custom.example/rpc'), 'https://custom.example/rpc')
  assert.equal(rpcHostLabel('devnet', 'https://custom.example/rpc'), 'custom.example')
  // A malformed or downgraded stored value degrades to the official endpoint,
  // never to a plaintext connection.
  assert.equal(rpcUrlFor('devnet', 'not a url'), DEFAULT_RPC.devnet)
  assert.equal(rpcUrlFor('mainnet', 'http://rpc.example.com'), DEFAULT_RPC.mainnet)
  assert.equal(rpcUrlFor('mainnet', 'javascript:alert(1)'), DEFAULT_RPC.mainnet)
  assert.equal(rpcHostLabel('devnet', 'not a url'), 'api.devnet.solana.com')
})

test('explorer links are always https and keep the query for devnet only', () => {
  const signature = '5'.repeat(87)
  const mainnet = explorerTx(signature, 'mainnet')
  const devnet = explorerTx(signature, 'devnet')
  assert.ok(mainnet.startsWith('https://solscan.io/tx/'))
  assert.ok(devnet.endsWith('?cluster=devnet'))
  assert.ok(explorerAddress('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', 'devnet').startsWith('https://'))
})
