# Dependency advisory remediations

## `bigint-buffer` / Solana High findings — GHSA-3gc7-fjrx-p6mg

The upstream advisory affects `bigint-buffer` versions through 1.1.5 and has no upstream patched release listed. The affected conversion path can send an invalid value to native conversion code and crash the process. `@solana/buffer-layout-utils` and `@solana/spl-token` inherit the same transitive dependency; these are three npm audit package records for one underlying advisory, not three separate root causes.

This repository overrides the transitive package with `vendor/bigint-buffer`, a small Apache-2.0-compatible pure-JavaScript implementation of the public API. It contains no native addon or added runtime dependencies. The decoding functions reject non-Buffer input with `TypeError`; they do not use the `0n` fallback in the separately reviewed third-party fork. Fixed-width encoders reject negative values and overflow. Regression tests cover LE/BE conversion, invalid input, and large buffers.

This is a repository-maintained mitigation, not an upstream patched npm release. Keep the override and tests until upstream publishes and the project verifies an official fix, or the replacement is independently re-reviewed.

## Vite High finding — GHSA-587h-7wmj-h5pm

The project updates Vite to at least 6.4.4, the first patched Vite release for the affected `launch-editor` path. The issue is specific to Windows dev-server editor launch handling and is not present in the static production bundle. The installed React and Node-polyfill Vite plugins declare Vite 6-compatible peer ranges.

## Verification

The current branch's audit counts and test results are recorded by `npm run test:security` in `security-report.json` and `npm-audit.json`; run `npm run security:gate` after the suite. No advisory is exempted by `known-accepted.json`.
