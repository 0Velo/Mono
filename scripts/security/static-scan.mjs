#!/usr/bin/env node
/**
 * Static security checks for the Mono wallet source tree.
 *
 * These complement the runtime/unit tests: they are the cheap, deterministic
 * grep-level rules that must hold for every build. Each check reports
 * PASS / FAIL / REVIEW with a short reason, and is also written to
 * docs/security-audit/static-scan.json.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const checks = []

function record(id, title, status, detail) {
  checks.push({ id, title, status, detail })
}

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, filter, out)
    else if (filter(entry.name)) out.push(full)
  }
  return out
}

const SRC_FILES = fs.existsSync(path.join(ROOT, 'src'))
  ? walk(path.join(ROOT, 'src'), (name) => /\.(ts|tsx|css)$/.test(name))
  : []

function linesMatching(pattern) {
  const hits = []
  for (const file of SRC_FILES) {
    const text = fs.readFileSync(file, 'utf8')
    text.split('\n').forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${path.relative(ROOT, file)}:${index + 1} ${line.trim().slice(0, 160)}`)
    })
  }
  return hits
}

function check(id, title, pattern, condition) {
  const hits = linesMatching(pattern)
  if (condition(hits)) record(id, title, 'PASS', hits.length ? `${hits.length} informational hit(s)` : 'no hits')
  else record(id, title, 'FAIL', hits.slice(0, 12).join(' | '))
}

/* ------------------------------------------------------------ DOM / XSS */
check('SS-01', 'No unescaped HTML sinks (innerHTML / dangerouslySetInnerHTML / document.write)',
  /dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML\s*=|document\.write|insertAdjacentHTML/,
  (hits) => hits.length === 0)

check('SS-02', 'No dynamic code evaluation (eval / new Function)',
  /\beval\s*\(|new Function\s*\(/,
  (hits) => hits.length === 0)

check('SS-03', 'No console logging of application state (secrets must never reach a log)',
  /\bconsole\.(log|info|warn|error|debug|trace)\b/,
  (hits) => hits.length === 0)

/* --------------------------------------------------------------- network */
const httpHits = []
for (const file of SRC_FILES) {
  const text = fs.readFileSync(file, 'utf8')
  for (const match of text.matchAll(/http:\/\/([a-zA-Z0-9._-]+)/g)) {
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(match[1])) continue
    httpHits.push(`${path.relative(ROOT, file)} ${match[0]}`)
  }
}
record('SS-04', 'No plaintext http:// endpoints outside localhost', httpHits.length === 0 ? 'PASS' : 'FAIL',
  httpHits.slice(0, 10).join(' | ') || 'no hits')

// Inventory of every origin the wallet can talk to (informational, for the report).
const origins = new Map()
for (const file of SRC_FILES) {
  const text = fs.readFileSync(file, 'utf8')
  for (const match of text.matchAll(/https:\/\/([a-zA-Z0-9.-]+)/g)) {
    const host = match[1]
    if (!origins.has(host)) origins.set(host, new Set())
    origins.get(host).add(path.relative(ROOT, file))
  }
}
record('SS-05', 'External origin inventory', 'INFO',
  [...origins.entries()].sort().map(([host, files]) => `${host} (${[...files].join(', ')})`).join(' ; '))

/* ------------------------------------------------------------------- CSP */
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
const cspMatch = indexHtml.match(/http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/)
const csp = cspMatch ? cspMatch[1].replace(/\s+/g, ' ') : ''
if (!cspMatch) {
  record('SS-06', 'Content-Security-Policy meta tag present', 'FAIL', 'no CSP meta tag in index.html')
} else {
  const required = [
    "default-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-src 'none'",
  ]
  const missing = required.filter((directive) => !csp.includes(directive))
  const unsafeEval = /unsafe-eval/.test(csp)
  const scriptsAnyHttps = /script-src[^;]*https:/.test(csp)
  record(
    'SS-06',
    'CSP blocks inline/external script, plugins, base-uri override, forms and frames',
    missing.length === 0 && !unsafeEval && !scriptsAnyHttps ? 'PASS' : 'FAIL',
    missing.length || unsafeEval || scriptsAnyHttps
      ? `missing=[${missing.join(', ')}] unsafe-eval=${unsafeEval} script-https=${scriptsAnyHttps} :: ${csp}`
      : csp,
  )
}

const connectAnyHttps = /connect-src[^;]*https:/.test(csp)
record('SS-07', 'CSP connect-src scope', connectAnyHttps ? 'REVIEW' : 'PASS',
  connectAnyHttps
    ? "connect-src allows any https/wss origin because the user may point the wallet at their own RPC (HTTP + its WebSocket); script execution stays self-only, so this cannot load code."
    : csp)

const imgAnyHttps = /img-src[^;]*https:/.test(csp)
record('SS-08', 'CSP img-src scope', imgAnyHttps ? 'REVIEW' : 'PASS',
  imgAnyHttps
    ? 'img-src allows https so token logos from DexScreener render; images cannot execute script and referrer/URLs are external-visible.'
    : csp)

const inlineScript = /<script(?![^>]*src=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(indexHtml)
const inlineHandler = /\son[a-z]+\s*=/i.test(indexHtml)
const externalScript = [...indexHtml.matchAll(/<script[^>]*src="([^"]+)"/g)].some((match) => /^https?:/.test(match[1]))
record('SS-09', 'index.html has no inline script body, inline handler or external script',
  !inlineScript && !inlineHandler && !externalScript ? 'PASS' : 'FAIL',
  `inlineScript=${inlineScript} inlineHandler=${inlineHandler} externalScript=${externalScript}`)

/* -------------------------------------------------------- service worker */
const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8')
const cachesCrossOrigin = /cache\.put\((request|url)/.test(sw) && !/url\.origin !== self\.location\.origin/.test(sw)
record('SS-10', 'Service worker caches same-origin assets only and prunes old caches',
  /url\.origin !== self\.location\.origin/.test(sw) && /caches\.delete/.test(sw) && !cachesCrossOrigin ? 'PASS' : 'FAIL',
  `cacheVersion=${(sw.match(/CACHE = `\$\{CACHE_PREFIX\}v(\d+)`/) || [])[1] ?? 'unparsed'}`)

/* ------------------------------------------------------------ local state */
const localStorageKeys = new Set()
for (const file of SRC_FILES) {
  const text = fs.readFileSync(file, 'utf8')
  for (const match of text.matchAll(/localStorage\.(?:setItem|getItem|removeItem)\(\s*([A-Z_a-z][\w.]*|'[^']+'|"[^"]+")/g)) {
    const raw = match[1].replace(/^['"]|['"]$/g, '')
    if (!raw.includes('KEY') && !raw.includes('.')) localStorageKeys.add(raw)
  }
  for (const match of text.matchAll(/(?:const|let)\s+([A-Z_]*KEY[A-Z_]*)\s*=\s*'([^']+)'/g)) {
    localStorageKeys.add(match[2])
  }
}
record('SS-11', 'localStorage key inventory (no plaintext secret keys expected)', 'INFO',
  [...localStorageKeys].sort().join(', '))

const secretInLocalStorage = linesMatching(/localStorage\.setItem\([^)]*(mnemonic|secretKey)/)
record('SS-12', 'No mnemonic/secretKey written to localStorage', secretInLocalStorage.length === 0 ? 'PASS' : 'FAIL',
  secretInLocalStorage.join(' | ') || 'no hits')

/* ---------------------------------------------------------------- supply chain */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const looseDeps = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
  .filter(([, version]) => !/^[~^]?\d+\.\d+\.\d+/.test(version))
  .map(([name, version]) => `${name}@${version}`)
record('SS-13', 'Every dependency version is pinned to a semver range', looseDeps.length === 0 ? 'PASS' : 'REVIEW',
  looseDeps.join(', ') || Object.entries({ ...pkg.dependencies }).map(([n, v]) => `${n}@${v}`).join(', '))

const distAssets = path.join(ROOT, 'dist/assets')
const maps = fs.existsSync(distAssets) ? fs.readdirSync(distAssets).filter((name) => name.endsWith('.map')) : []
record('SS-14', 'Deployed bundle has no source maps', maps.length === 0 ? 'PASS' : 'FAIL', maps.join(', ') || 'none')

const distIndex = path.join(ROOT, 'dist/index.html')
const distCsp = fs.existsSync(distIndex)
  ? (fs.readFileSync(distIndex, 'utf8').match(/http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/) || [])[1] ?? ''
  : ''
record('SS-15', 'Built dist/index.html carries the CSP', distCsp.length > 0 ? 'PASS' : (fs.existsSync(distIndex) ? 'FAIL' : 'REVIEW'),
  distCsp ? distCsp.replace(/\s+/g, ' ') : 'no built index.html')

const allowlist = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
const lockPackages = Object.keys(allowlist.packages || {}).length
record('SS-16', 'package-lock.json present and structurally valid', 'PASS', `${lockPackages} locked package entries`)

/* ------------------------------------------------------- camera + QR decoder */
// Scanning a QR loads a decoder. That code must come from this bundle — an
// external script would be blocked by `script-src 'self'` anyway, but a build
// that only worked with one would fail closed on the price tab instead of on
// the send screen. `jsqr` is pinned in the lockfile and imported dynamically.
const pkgDeps = { ...pkg.dependencies }
const cdnHits = linesMatching(/\b(?:cdn\.|cdnjs\.|unpkg\.com|jsdelivr\.net)/)
const decoderPinned = typeof pkgDeps.jsqr === 'string' && /^\^?\d+\.\d+\.\d+$/.test(pkgDeps.jsqr)
const decoderBundled = SRC_FILES.some((file) =>
  /import\(['"]jsqr['"]\)/.test(fs.readFileSync(file, 'utf8')),
)
record(
  'SS-17',
  'QR decoding is bundled and pinned, with no external script or CDN',
  cdnHits.length === 0 && decoderPinned && decoderBundled ? 'PASS' : 'FAIL',
  cdnHits.length
    ? cdnHits.slice(0, 6).join(' | ')
    : `jsqr@${pkgDeps.jsqr ?? 'missing'} dynamic=${decoderBundled}`,
)

const cameraGuard = SRC_FILES.some((file) => {
  const text = fs.readFileSync(file, 'utf8')
  return /getUserMedia/.test(text) && /track\.stop\(\)|\.stop\(\)/s.test(text)
})
record(
  'SS-18',
  'The camera stream is released by the code that opens it',
  cameraGuard ? 'PASS' : 'FAIL',
  cameraGuard ? 'getUserMedia + track.stop() in the same module tree' : 'no getUserMedia release found',
)

/* ------------------------------------------------------------------ output */
const summary = {
  generatedAt: new Date().toISOString(),
  checks,
  counts: checks.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1
    return acc
  }, {}),
}

const outDir = path.join(ROOT, 'docs/security-audit')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'static-scan.json'), JSON.stringify(summary, null, 2))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  for (const item of checks) {
    console.log(`${item.status.padEnd(6)} ${item.id} ${item.title}`)
    if (item.status !== 'PASS' && item.status !== 'INFO') console.log(`       ${item.detail}`)
  }
  console.log('', JSON.stringify(summary.counts))
}

process.exitCode = checks.some((item) => item.status === 'FAIL') ? 1 : 0
