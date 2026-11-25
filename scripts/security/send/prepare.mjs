#!/usr/bin/env node
/**
 * Bundles the mock Devnet JSON-RPC next to the build so the Python browser test
 * can start it with plain `node` (it imports @solana/web3.js to read the signed
 * transaction back). Nothing here touches a real cluster or a key.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true })
execFileSync(
  path.join(ROOT, 'node_modules/.bin/esbuild'),
  [
    path.join(ROOT, 'scripts/security/send/mock-rpc-server.mjs'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${path.join(ROOT, 'tmp/mock-rpc-server.bundle.mjs')}`,
    '--log-level=error',
    '--banner:js=import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  ],
  { stdio: 'inherit' },
)
process.stdout.write('mock RPC bundled\n')
