#!/usr/bin/env node
/**
 * Mono security suite — one command that runs every local check and writes a
 * machine-readable result next to the human report.
 *
 *   npm run test:security              # static + secrets + deps + unit
 *   npm run test:security -- --ui      # ... plus the built-app Playwright checks
 *   npm run test:security -- --live    # ... plus live mainnet/devnet checks
 *
 * Exit code is non-zero when any blocking check fails, so CI can gate on it.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const BUILD_DIR = path.join(ROOT, 'tmp/security-build')
const OUT_DIR = path.join(ROOT, 'docs/security-audit')
const args = process.argv.slice(2)
const wantUi = args.includes('--ui')
const wantLive = args.includes('--live')
const only = (() => {
  const index = args.indexOf('--only')
  return index >= 0 ? args[index + 1].split(',') : null
})()

fs.mkdirSync(BUILD_DIR, { recursive: true })
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(BUILD_DIR, 'package.json'), JSON.stringify({ type: 'module' }))

const started = Date.now()
const report = {
  startedAt: new Date().toISOString(),
  node: process.version,
  sections: {},
}

function log(line = '') {
  process.stdout.write(line + '\n')
}

function runJson(script, extraArgs = [], env = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/security', script), ...extraArgs, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
  try {
    return JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
  } catch {
    return { status: 'ERROR', error: (result.stderr || result.stdout || '').slice(0, 4000) }
  }
}

/* --------------------------------------------------------------- static */
log('== static scan')
const staticScan = runJson('static-scan.mjs')
report.sections.static = staticScan
log(`   ${JSON.stringify(staticScan.counts || staticScan)}`)

/* -------------------------------------------------------------- secrets */
log('== secret scan')
const secretScan = runJson('secret-scan.mjs')
report.sections.secrets = secretScan
log(`   status=${secretScan.status} tree=${secretScan.workingTree?.findings?.length} history=${secretScan.gitHistory?.findings?.length}`)

/* ----------------------------------------------------------- dependencies */
log('== dependency audit (npm audit)')
const auditRaw = spawnSync('npm', ['audit', '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
let audit = {}
try {
  audit = JSON.parse(auditRaw.stdout)
} catch {
  audit = { error: (auditRaw.stderr || '').slice(0, 2000) }
}
const vulns = audit.metadata?.vulnerabilities ?? {}
const advisories = Object.entries(audit.vulnerabilities ?? {}).map(([name, item]) => ({
  package: name,
  severity: item.severity,
  range: item.range,
  direct: Boolean(item.isDirect),
  fixAvailable: item.fixAvailable,
  advisories: (item.via ?? [])
    .filter((via) => typeof via === 'object')
    .map((via) => ({ title: via.title, url: via.url, cvss: via.cvss?.score, cwe: via.cwe })),
}))
report.sections.dependencies = {
  counts: vulns,
  advisories,
  prodDependencies: audit.metadata?.dependencies?.prod,
  totalDependencies: audit.metadata?.dependencies?.total,
}
fs.writeFileSync(path.join(OUT_DIR, 'npm-audit.json'), JSON.stringify(audit, null, 2))
log(`   ${JSON.stringify(vulns)}`)

/* ------------------------------------------------------------------ unit */
log('== unit tests (esbuild bundle + node:test)')
const testDir = path.join(ROOT, 'scripts/security/tests')
let testFiles = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join(testDir, name))
if (only) testFiles = testFiles.filter((file) => only.some((needle) => file.includes(needle)))

const esbuild = path.join(ROOT, 'node_modules/.bin/esbuild')
const bundleBanner =
  "import { createRequire as __monoCreateRequire } from 'node:module'; import { fileURLToPath as __monoFileURLToPath } from 'node:url'; import { dirname as __monoDirname } from 'node:path'; const require = __monoCreateRequire(import.meta.url); const __filename = __monoFileURLToPath(import.meta.url); const __dirname = __monoDirname(__filename);"
const bundles = []
const compileErrors = []
for (const file of testFiles) {
  const name = path.basename(file, '.ts')
  const outfile = path.join(BUILD_DIR, `${name}.mjs`)
  const result = spawnSync(
    esbuild,
    [file, '--bundle', '--platform=node', '--format=esm', `--outfile=${outfile}`, `--banner:js=${bundleBanner}`, '--log-level=error'],
    { cwd: ROOT, encoding: 'utf8' },
  )
  if (result.status === 0) bundles.push(outfile)
  else compileErrors.push({ file: path.relative(ROOT, file), error: (result.stderr || '').slice(0, 3000) })
}
for (const failure of compileErrors) log(`   COMPILE FAIL ${failure.file}: ${failure.error.split('\n')[0]}`)

let unit = { tests: [], pass: 0, fail: 0, compileErrors }
if (bundles.length) {
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...bundles], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  fs.writeFileSync(path.join(OUT_DIR, 'unit-tests.tap.txt'), output)
  const suiteFile = new Map()
  let currentFile = null
  for (const line of output.split('\n')) {
    const header = line.match(/^# Subtest: (.+)$/)
    if (header && bundles.some((bundle) => header[1].includes(path.basename(bundle)))) {
      currentFile = path.basename(header[1])
      continue
    }
    const ok = line.match(/^(not ok|ok) \d+ - (.+?)(?: # (SKIP|TODO).*)?$/)
    if (ok) {
      const status = ok[1] === 'ok' ? 'PASS' : 'FAIL'
      unit.tests.push({ name: ok[2], status, file: currentFile })
      if (status === 'PASS') unit.pass += 1
      else unit.fail += 1
    }
  }
  const comment = output.match(/# fail (\d+)/)
  if (comment && Number(comment[1]) !== unit.fail) unit.fail = Number(comment[1])
  for (const test of unit.tests.filter((item) => item.status === 'FAIL')) log(`   FAIL ${test.file} :: ${test.name}`)
}
report.sections.unit = unit
log(`   ${unit.pass} passed, ${unit.fail} failed, ${compileErrors.length} file(s) failed to compile`)

/* -------------------------------------------------------------------- ui */
if (wantUi) {
  log('== built-app checks (Playwright)')
  const result = spawnSync('python3', [path.join(ROOT, 'scripts/security/ui-check.py'), '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  try {
    report.sections.ui = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
  } catch {
    report.sections.ui = { status: 'ERROR', error: (result.stderr || result.stdout || '').slice(0, 4000) }
  }
  if (
    report.sections.ui.status === 'ERROR' &&
    /libnspr4|TargetClosedError|BrowserType.launch|Executable doesn't exist/i.test(report.sections.ui.error ?? '')
  ) {
    report.sections.ui = {
      status: 'REVIEW',
      error: '이 환경에서는 Playwright 브라우저를 실행할 수 없습니다 (시스템 라이브러리 부족). CI의 browser job에서 실행됩니다.',
    }
  }
  log(`   ${report.sections.ui.status} ${JSON.stringify(report.sections.ui.counts ?? {})}`)
}

/* ------------------------------------------------------------------ live */
if (wantLive) {
  log('== live checks (Jupiter guard + devnet)')
  const liveDir = path.join(ROOT, 'scripts/security/live')
  for (const name of fs.readdirSync(liveDir).filter((file) => file.endsWith('.ts'))) {
    const outfile = path.join(BUILD_DIR, `${path.basename(name, '.ts')}.mjs`)
    const bundle = spawnSync(
      esbuild,
      [path.join(liveDir, name), '--bundle', '--platform=node', '--format=esm', `--outfile=${outfile}`, `--banner:js=${bundleBanner}`, '--log-level=error'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    if (bundle.status !== 0) log(`   bundle failed ${name}: ${(bundle.stderr || '').split('\n')[0]}`)
  }
  for (const script of ['live-swap-guard.mjs', 'devnet-send.mjs']) {
    const result = spawnSync(process.execPath, [path.join(BUILD_DIR, script)], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    })
    const key = script.replace('.mjs', '')
    try {
      report.sections[key] = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf('{')))
    } catch {
      report.sections[key] = { status: 'ERROR', error: (result.stderr || result.stdout || '').slice(0, 4000) }
    }
    log(`   ${key}: ${report.sections[key].status}`)
  }
}

/* ---------------------------------------------------------------- summary */
report.durationSeconds = Math.round((Date.now() - started) / 10) / 100
const blocking = []
if (staticScan.checks?.some((item) => item.status === 'FAIL')) blocking.push('static')
if (secretScan.status === 'FAIL') blocking.push('secrets')
if (unit.fail > 0 || compileErrors.length > 0) blocking.push('unit')
if (wantUi && report.sections.ui?.status === 'FAIL') blocking.push('ui')
report.blockingFailures = blocking

fs.writeFileSync(path.join(OUT_DIR, 'security-report.json'), JSON.stringify(report, null, 2))
log('')
log(`result: ${blocking.length === 0 ? 'PASS' : 'FAIL'} (${blocking.join(', ') || 'no blocking failures'}) in ${report.durationSeconds}s`)
log(`wrote ${path.relative(ROOT, path.join(OUT_DIR, 'security-report.json'))}`)
process.exitCode = blocking.length === 0 ? 0 : 1
