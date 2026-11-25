/// <reference types="node" />
/** Convert a little-endian Buffer to a BigInt. */
export declare function toBigIntLE(buf: Buffer): bigint
/** Convert a big-endian Buffer to a BigInt. */
export declare function toBigIntBE(buf: Buffer): bigint
/** Convert a non-negative BigInt to a fixed-width little-endian Buffer. */
export declare function toBufferLE(num: bigint, width: number): Buffer
/** Convert a non-negative BigInt to a fixed-width big-endian Buffer. */
export declare function toBufferBE(num: bigint, width: number): Buffer
