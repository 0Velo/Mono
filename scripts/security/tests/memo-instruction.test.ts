/**
 * Area 11 — a Solana Pay memo must be exactly what it claims: one Memo-program
 * instruction carrying text, with no accounts and no signer, so the transfer's
 * simulated lamport and token changes stay untouched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { MEMO_PROGRAM_ID, MAX_MEMO_LENGTH } from '../../../src/lib/solanaPay'
import { buildMemoInstruction } from '../../../src/lib/tx'

test('no memo means no instruction at all', () => {
  assert.equal(buildMemoInstruction(null), null)
  assert.equal(buildMemoInstruction(''), null)
  assert.equal(buildMemoInstruction('\n\t  '), null)
})

test('the memo instruction targets the Memo program and touches no account', () => {
  const instruction = buildMemoInstruction('order 42')
  assert.ok(instruction)
  assert.equal(instruction!.programId.toBase58(), MEMO_PROGRAM_ID)
  assert.deepEqual(instruction!.keys, [])
  assert.equal(instruction!.data.toString('utf8'), 'order 42')
})

test('memo text is sanitised and bounded before it reaches the chain', () => {
  const instruction = buildMemoInstruction(`a\u0000b\nc ${'x'.repeat(MAX_MEMO_LENGTH * 2)}`)
  assert.ok(instruction)
  const text = instruction!.data.toString('utf8')
  assert.equal(text.startsWith('a b c xxx'), true)
  assert.equal(Array.from(text).length, MAX_MEMO_LENGTH)
  // The Memo program accepts far more than this, so the length can never be
  // the reason a transfer fails.
  assert.ok(Buffer.byteLength(text, 'utf8') < 200)
})

test('the memo program id is a real 32-byte public key', () => {
  const key = new PublicKey(MEMO_PROGRAM_ID)
  assert.equal(key.toBase58(), MEMO_PROGRAM_ID)
})
