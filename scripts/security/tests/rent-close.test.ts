/**
 * Area 10 — closing empty token accounts must never close anything that holds
 * value, and must return exactly the rent that was locked in them.
 *
 * The network paths (RPC + simulation) are exercised by the built-app and live
 * checks; here are the rules that decide which accounts are even offered, and
 * the exact instructions that get signed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Connection, PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  MAX_CLOSE_PER_TRANSACTION,
  buildCloseInstructions,
  chunkTargets,
  findEmptyTokenAccounts,
  isClosableTokenAccount,
  sortByRent,
  sumLamports,
  type EmptyTokenAccount,
} from '../../../src/lib/rent'

const OWNER = new PublicKey('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk')
const ownerText = OWNER.toBase58()

function account(address: string, lamports = 2_039_280n): EmptyTokenAccount {
  return {
    address,
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    programId: TOKEN_PROGRAM_ID.toBase58(),
    lamports,
  }
}

const A = account('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T')
const B = account('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', 2_500_000n)

test('an empty, unfrozen, self-closable account is offered', () => {
  assert.equal(
    isClosableTokenAccount({ amount: 0n, state: 'initialized', closeAuthority: null, owner: ownerText }),
    true,
  )
})

test('an account with tokens is never offered, not even a single base unit', () => {
  assert.equal(
    isClosableTokenAccount({ amount: 1n, state: 'initialized', closeAuthority: null, owner: ownerText }),
    false,
  )
})

test('a frozen account is left alone', () => {
  assert.equal(
    isClosableTokenAccount({ amount: 0n, state: 'frozen', closeAuthority: null, owner: ownerText }),
    false,
  )
})

test('an account whose close authority is someone else is left alone', () => {
  assert.equal(
    isClosableTokenAccount({
      amount: 0n,
      state: 'initialized',
      closeAuthority: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      owner: ownerText,
    }),
    false,
  )
  assert.equal(
    isClosableTokenAccount({
      amount: 0n,
      state: 'initialized',
      closeAuthority: ownerText,
      owner: ownerText,
    }),
    true,
  )
})

test('rent is summarised and the largest account comes first', () => {
  assert.equal(sumLamports([A, B]), 2_039_280n + 2_500_000n)
  assert.deepEqual(sortByRent([A, B]).map((item) => item.address), [B.address, A.address])
})

test('chunks stay inside the per-transaction limit', () => {
  const items = Array.from({ length: 19 }, (_, index) => index)
  const chunks = chunkTargets(items)
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].length, MAX_CLOSE_PER_TRANSACTION)
  assert.equal(chunks[2].length, 19 - MAX_CLOSE_PER_TRANSACTION * 2)
  assert.deepEqual(chunkTargets([], 4), [])
})

test('each close instruction pays the rent to the wallet and uses the right token program', () => {
  const token2022 = {
    ...account('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'),
    programId: TOKEN_2022_PROGRAM_ID.toBase58(),
  }
  const instructions = buildCloseInstructions([A, token2022], OWNER)
  assert.equal(instructions.length, 2)
  const [spl, t22] = instructions
  // CloseAccount = 9, no data beyond the tag.
  assert.equal(spl.data[0], 9)
  assert.equal(t22.data[0], 9)
  assert.equal(spl.programId.equals(TOKEN_PROGRAM_ID), true)
  assert.equal(t22.programId.equals(TOKEN_2022_PROGRAM_ID), true)
  for (const instruction of instructions) {
    const accountKey = instruction.keys[0]
    const destinationKey = instruction.keys[1]
    const authorityKey = instruction.keys[2]
    assert.equal(instruction.keys.length, 3)
    assert.equal(accountKey.isSigner, false)
    assert.equal(accountKey.isWritable, true)
    assert.equal(destinationKey.pubkey.equals(OWNER), true, 'rent goes to the wallet')
    assert.equal(destinationKey.isWritable, true)
    assert.equal(authorityKey.pubkey.equals(OWNER), true)
    assert.equal(authorityKey.isSigner, true)
  }
  assert.equal(instructions[0].keys[0].pubkey.toBase58(), A.address)
  assert.equal(instructions[1].keys[0].pubkey.toBase58(), token2022.address)
})

function parsedAccount(
  address: string,
  info: Record<string, unknown>,
  lamports: number,
): unknown {
  return {
    pubkey: new PublicKey(address),
    account: {
      lamports,
      executable: false,
      owner: TOKEN_PROGRAM_ID,
      rentEpoch: 0,
      data: { program: 'spl-token', parsed: { type: 'account', info }, space: 165 },
    },
  }
}

function fakeConnection(byProgram: Record<string, unknown[]>): Connection {
  return {
    getParsedTokenAccountsByOwner: async (
      _owner: PublicKey,
      filter: { programId: PublicKey },
    ) => ({
      context: { slot: 1 },
      value: byProgram[filter.programId.toBase58()] ?? [],
    }),
  } as unknown as Connection
}

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
test('the on-chain lookup offers only the accounts that can safely be closed', async () => {
  const info = (amount: string, extra: Record<string, unknown> = {}) => ({
    mint: MINT,
    tokenAmount: { amount, decimals: 6, uiAmount: Number(amount), uiAmountString: amount },
    state: 'initialized',
    isNative: false,
    closeAuthority: null,
    ...extra,
  })
  const connection = fakeConnection({
    [TOKEN_PROGRAM_ID.toBase58()]: [
      parsedAccount('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', info('0'), 2_039_280),
      parsedAccount('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', info('1500'), 2_039_280),
      parsedAccount('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', info('0', { state: 'frozen' }), 2_039_280),
      parsedAccount(
        '2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9',
        info('0', { closeAuthority: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }),
        2_039_280,
      ),
    ],
    [TOKEN_2022_PROGRAM_ID.toBase58()]: [
      parsedAccount('3mfpD9vX9y69pkWWCToCat2yU1yVjfpnYmcWLYFDhiqR', info('0'), 1_488_440),
    ],
  })

  const found = await findEmptyTokenAccounts(connection, ownerText)
  assert.deepEqual(
    found.map((item) => item.address),
    [
      '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T',
      '3mfpD9vX9y69pkWWCToCat2yU1yVjfpnYmcWLYFDhiqR',
    ],
  )
  // The Token-2022 account keeps its own program id, so the close instruction
  // is built against the program that actually owns it.
  assert.equal(found[1].programId, TOKEN_2022_PROGRAM_ID.toBase58())
  assert.equal(sumLamports(found), 2_039_280n + 1_488_440n)
})

test('a wallet with no token accounts yields an empty list', async () => {
  const found = await findEmptyTokenAccounts(fakeConnection({}), ownerText)
  assert.deepEqual(found, [])
})
