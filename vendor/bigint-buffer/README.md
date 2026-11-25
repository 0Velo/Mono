# Mono local `bigint-buffer` replacement

This directory provides a small, pure-JavaScript implementation of the public `bigint-buffer` Buffer/BigInt conversion API. The root package manifest redirects the transitive dependency here with an npm override. It includes no native addon and adds no runtime dependencies.

The original package is Apache-2.0 licensed; its license text is retained in `LICENSE`. This local implementation is maintained in this repository and is not an upstream `bigint-buffer` release.

Security behavior is intentionally strict: `toBigIntLE` and `toBigIntBE` require an actual Node-compatible `Buffer` and throw `TypeError` for other values. The BigInt-to-Buffer functions reject negative values, invalid widths, and values that do not fit rather than clipping them. The Solana layout consumer wraps decoded bytes with `Buffer.from(...)` and encodes unsigned fixed-width values.
