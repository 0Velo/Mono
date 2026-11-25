import { Buffer } from 'buffer'

function assertBuffer(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError('Expected a Buffer')
}

function assertBigInt(value) {
  if (typeof value !== 'bigint') throw new TypeError('Expected a bigint')
}

function assertWidth(width) {
  if (!Number.isSafeInteger(width) || width < 0) {
    throw new RangeError('Buffer width must be a non-negative safe integer')
  }
}

export function toBigIntLE(buffer) {
  assertBuffer(buffer)
  let value = 0n
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(buffer[index])
  }
  return value
}

export function toBigIntBE(buffer) {
  assertBuffer(buffer)
  let value = 0n
  for (let index = 0; index < buffer.length; index += 1) {
    value = (value << 8n) | BigInt(buffer[index])
  }
  return value
}

export function toBufferLE(input, width) {
  assertBigInt(input)
  assertWidth(width)
  if (input < 0n) throw new RangeError('Expected an unsigned bigint')

  const output = Buffer.alloc(width)
  let value = input
  for (let index = 0; index < width && value > 0n; index += 1) {
    output[index] = Number(value & 0xffn)
    value >>= 8n
  }
  if (value !== 0n) throw new RangeError('Bigint does not fit within buffer width')
  return output
}

export function toBufferBE(input, width) {
  assertBigInt(input)
  assertWidth(width)
  if (input < 0n) throw new RangeError('Expected an unsigned bigint')

  const output = Buffer.alloc(width)
  let value = input
  for (let index = width - 1; index >= 0 && value > 0n; index -= 1) {
    output[index] = Number(value & 0xffn)
    value >>= 8n
  }
  if (value !== 0n) throw new RangeError('Bigint does not fit within buffer width')
  return output
}
