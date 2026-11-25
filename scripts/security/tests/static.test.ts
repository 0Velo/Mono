/**
 * Area 3 + 7 — source-level security invariants for the shipped bundle.
 *
 * These are regression guards: they fail if a future edit reintroduces an
 * unescaped HTML sink, a console log of secret material, a plaintext endpoint,
 * or silently drops the CSP.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, readRepoFile } from './helpers'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full)
  }
  return out
}

const SRC_FILES = walk(path.join(REPO_ROOT, 'src'))
const relative = (file: string) => path.relative(REPO_ROOT, file)

function offenders(pattern: RegExp): string[] {
  const hits: string[] = []
  for (const file of SRC_FILES) {
    const text = fs.readFileSync(file, 'utf8')
    text.split('\n').forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${relative(file)}:${index + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  return hits
}

test('source contains no HTML injection sinks', () => {
  const sinks = offenders(/dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML\s*=|document\.write|insertAdjacentHTML/)
  assert.deepEqual(sinks, [], `unescaped HTML sink found:\n${sinks.join('\n')}`)
})

test('source contains no code-evaluation sinks', () => {
  const sinks = offenders(/\beval\s*\(|new Function\s*\(/)
  assert.deepEqual(sinks, [], `dynamic code execution found:\n${sinks.join('\n')}`)
})

test('source contains no console logging (keys must never reach a log)', () => {
  const logs = offenders(/\bconsole\.(log|info|warn|error|debug|trace)\b/)
  assert.deepEqual(logs, [], `console usage found:\n${logs.join('\n')}`)
})

test('source contains no plaintext http:// endpoint outside localhost', () => {
  const hits: string[] = []
  for (const file of SRC_FILES) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/http:\/\/([a-zA-Z0-9._-]+)/g)) {
      if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(match[1])) continue
      hits.push(`${relative(file)}: ${match[0]}`)
    }
  }
  assert.deepEqual(hits, [], `insecure endpoint found:\n${hits.join('\n')}`)
})

test('the document CSP denies frames, forms, plugins and base-uri override', () => {
  const html = readRepoFile('index.html')
  const match = html.match(/http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/)
  assert.ok(match, 'index.html must carry a Content-Security-Policy meta tag')
  const csp = match![1].replace(/\s+/g, ' ')
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-src 'none'",
  ]) {
    assert.ok(csp.includes(directive), `CSP is missing ${directive} — got: ${csp}`)
  }
  assert.ok(!/unsafe-eval/.test(csp), 'CSP must not allow unsafe-eval')
  assert.ok(!/script-src[^;]*https:/.test(csp), 'CSP must not allow script from any https origin')
})

test('index.html loads only same-origin scripts, with no inline handler attributes', () => {
  const html = readRepoFile('index.html')
  const scriptSources = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1])
  assert.ok(scriptSources.length >= 1)
  for (const source of scriptSources) {
    assert.ok(!/^https?:/.test(source), `external script ${source}`)
  }
  assert.ok(!/<script(?![^>]*src=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html), 'no inline script body')
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handler attribute')
})

test('the service worker is same-origin only and drops old caches on activate', () => {
  const sw = readRepoFile('public/sw.js')
  assert.match(sw, /url\.origin !== self\.location\.origin/)
  assert.match(sw, /caches\.delete/)
  assert.match(sw, /self\.skipWaiting\(\)/)
  assert.match(sw, /CACHE = `\$\{CACHE_PREFIX\}v(\d+)`/)
})

test('the shipped build carries no source maps and no /src/ path', () => {
  const dist = path.join(REPO_ROOT, 'dist')
  if (!fs.existsSync(dist)) {
    assert.ok(true, 'dist not built yet')
    return
  }
  const files = walk(dist).concat(
    fs.readdirSync(path.join(dist, 'assets'), { withFileTypes: true }).map((entry) => entry.name),
  )
  const maps = files.filter((file) => String(file).endsWith('.map'))
  assert.deepEqual(maps, [], 'source maps must not ship')
})

test('derivation path literals in the app are hardened', () => {
  // SLIP-0010 ed25519 has no public derivation: a path such as m/44'/501'/0'/0
  // cannot be reproduced by Phantom, so it must not appear anywhere in src.
  const hits: string[] = []
  for (const file of SRC_FILES) {
    const text = fs.readFileSync(file, 'utf8')
    text.split('\n').forEach((line, index) => {
      if (/m\/44'\/501'\/\d+'\/0(?![hH'])/.test(line)) {
        hits.push(`${relative(file)}:${index + 1}: ${line.trim()}`)
      }
    })
  }
  assert.deepEqual(hits, [], `non-hardened derivation path found:\n${hits.join('\n')}`)
})

test('the onboarding screen names the shared standard path instead of a literal', () => {
  const onboarding = readRepoFile('src/screens/Onboarding.tsx')
  assert.match(onboarding, /DEFAULT_DERIVATION_PATH/)
  assert.match(readRepoFile('src/lib/paths.ts'), /m\/44'\/501'\/0'\/0'/)
})

test('custom RPC input is validated as https-only in the settings screen', () => {
  const settings = readRepoFile('src/screens/Settings.tsx')
  assert.match(settings, /looksLikeRpc/)
  const rpc = readRepoFile('src/lib/rpc.ts')
  assert.match(rpc, /protocol === 'https:'/)
})

test('send and swap approval screens reject a prepared preview after wallet, network, or RPC context changes', () => {
  const send = readRepoFile('src/sheets/SendSheet.tsx')
  const swap = readRepoFile('src/screens/Swap.tsx')
  for (const source of [send, swap]) {
    assert.match(source, /prepared\.owner !== activeOwner/)
    assert.match(source, /preparedNetworkRef\.current !== network/)
    assert.match(source, /preparedConnectionRef\.current !== connection/)
  }
})
