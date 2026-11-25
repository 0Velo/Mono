import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE } from 'bigint-buffer'

const require = createRequire(import.meta.url)
const commonJsApi = require('bigint-buffer') as typeof import('bigint-buffer')

test('bigint-buffer replacement preserves little- and big-endian conversions', () => {
  const bytes = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])

  assert.equal(toBigIntLE(bytes), 0x0807060504030201n)
  assert.equal(toBigIntBE(bytes), 0x0102030405060708n)
  assert.deepEqual(toBufferLE(0x0807060504030201n, 8), bytes)
  assert.deepEqual(toBufferBE(0x0102030405060708n, 8), bytes)
  assert.equal(toBigIntLE(Buffer.alloc(0)), 0n)
  assert.equal(toBigIntBE(Buffer.alloc(0)), 0n)
})

test('ESM and CommonJS entry points produce the same results', () => {
  const bytes = Buffer.from([0x10, 0x20, 0x30, 0x40])
  assert.equal(commonJsApi.toBigIntLE(bytes), toBigIntLE(bytes))
  assert.equal(commonJsApi.toBigIntBE(bytes), toBigIntBE(bytes))
  assert.deepEqual(commonJsApi.toBufferLE(0x40302010n, 4), toBufferLE(0x40302010n, 4))
  assert.deepEqual(commonJsApi.toBufferBE(0x10203040n, 4), toBufferBE(0x10203040n, 4))
})

test('bigint-buffer replacement rejects non-Buffer inputs before conversion', () => {
  const invalidInputs: unknown[] = [null, undefined, {}, 'not a buffer', new Uint8Array([1, 2])]
  for (const input of invalidInputs) {
    assert.throws(() => toBigIntLE(input as never), TypeError)
    assert.throws(() => toBigIntBE(input as never), TypeError)
    assert.throws(() => commonJsApi.toBigIntLE(input as never), TypeError)
    assert.throws(() => commonJsApi.toBigIntBE(input as never), TypeError)
  }
})

test('bigint-buffer replacement safely converts large valid buffers without native code', () => {
  const width = 1024
  const expected = (1n << BigInt(width * 8)) - 1n
  const little = toBufferLE(expected, width)
  const big = toBufferBE(expected, width)

  assert.equal(little.length, width)
  assert.equal(big.length, width)
  assert.equal(toBigIntLE(little), expected)
  assert.equal(toBigIntBE(big), expected)
})

test('bigint-buffer replacement rejects invalid widths, negative values, and overflow', () => {
  assert.throws(() => toBufferLE(1n, -1), RangeError)
  assert.throws(() => toBufferBE(1n, 1.5), RangeError)
  assert.throws(() => toBufferLE(-1n, 8), RangeError)
  assert.throws(() => toBufferBE(1n << 64n, 8), RangeError)
})
