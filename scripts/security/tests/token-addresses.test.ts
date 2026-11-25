import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, type PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { fetchPortfolio, fetchTokenAccountAddresses } from '../../../src/lib/tokens'

function installLocalStorage() {
  const storage = new Map<string, string>()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
    },
  })
  return {
    storage,
    restore() {
      if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
      else delete (globalThis as any).localStorage
    },
  }
}

test('portfolio keeps zero-balance token account addresses for history lookup', async () => {
  const owner = Keypair.generate().publicKey
  const tokenAccount = Keypair.generate().publicKey
  const mint = Keypair.generate().publicKey.toBase58()
  const local = installLocalStorage()
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () => ({ ok: false })) as any
  const connection = {
    getBalance: async () => 0,
    getParsedTokenAccountsByOwner: async (_owner: PublicKey, filter: { programId: PublicKey }) => ({
      value: filter.programId.equals(TOKEN_PROGRAM_ID)
        ? [{
            pubkey: tokenAccount,
            account: {
              data: {
                parsed: {
                  info: { mint, tokenAmount: { amount: '0', decimals: 6 } },
                },
              },
            },
          }]
        : [],
    }),
  } as any

  try {
    const portfolio = await fetchPortfolio(connection, owner.toBase58(), 'devnet')
    assert.deepEqual(portfolio.tokenAccountAddresses, [tokenAccount.toBase58()])
    assert.deepEqual(portfolio.tokens, [])
  } finally {
    globalThis.fetch = previousFetch
    local.restore()
  }
})

test('token account discovery remembers seen addresses locally and isolates network', async () => {
  const owner = Keypair.generate().publicKey
  const tokenAccount = Keypair.generate().publicKey
  const local = installLocalStorage()
  let accountStillExists = true
  const connection = {
    getParsedTokenAccountsByOwner: async (_owner: PublicKey, filter: { programId: PublicKey }) => ({
      value: filter.programId.equals(TOKEN_PROGRAM_ID) && accountStillExists
        ? [{ pubkey: tokenAccount }]
        : [],
    }),
  } as any

  try {
    const first = await fetchTokenAccountAddresses(connection, owner.toBase58(), 'mainnet')
    assert.deepEqual(first, [tokenAccount.toBase58()])

    // Once an observed token account is closed, its public address remains
    // available locally for fetching recent transaction signatures.
    accountStillExists = false
    const afterClose = await fetchTokenAccountAddresses(connection, owner.toBase58(), 'mainnet')
    assert.deepEqual(afterClose, [tokenAccount.toBase58()])
    assert.equal(
      local.storage.get(`mono.token-history-addresses.v1:mainnet:${owner.toBase58()}`),
      JSON.stringify([tokenAccount.toBase58()]),
    )

    // Address history is isolated by network.
    const otherNetwork = await fetchTokenAccountAddresses(connection, owner.toBase58(), 'devnet')
    assert.deepEqual(otherNetwork, [])
  } finally {
    local.restore()
  }
})
