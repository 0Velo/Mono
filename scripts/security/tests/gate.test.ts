import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const ROOT = process.cwd()
const GATE = path.join(ROOT, 'scripts/security/gate.mjs')
const ADVISORY = 'GHSA-abc1-def2-ghi3'

function utcDate(offsetDays = 0) {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

function evidence() {
  return {
    sections: {
      static: { checks: [{ id: 'fixture', status: 'PASS' }] },
      secrets: {
        status: 'PASS',
        workingTree: { findings: [] },
        builtArtifacts: { findings: [] },
        gitHistory: { findings: [] },
        scanned: { trackedFiles: 1, commits: 1 },
      },
      unit: { pass: 1, fail: 0, tests: [{ status: 'PASS' }], compileErrors: [] },
      ui: { status: 'PASS', checks: [{ id: 'ui-fixture', status: 'PASS' }] },
    },
  }
}

function auditWithHigh(id = ADVISORY) {
  return {
    metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 0, total: 1 } },
    vulnerabilities: {
      'sample-package': {
        severity: 'high',
        isDirect: true,
        via: [{ name: 'sample-package', severity: 'high', url: `https://github.com/advisories/${id}` }],
      },
    },
  }
}

function cleanAudit() {
  return {
    metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, total: 0 } },
    vulnerabilities: {},
  }
}

function acceptedWith(ids = [ADVISORY], reviewBy = utcDate(90)) {
  return {
    reviewedAt: utcDate(),
    accepted: [
      {
        package: 'sample-package',
        severity: 'high',
        advisories: ids,
        reason: 'The exact advisory was reviewed for the fixture.',
        scope: 'Test-only fixture.',
        reviewBy,
      },
    ],
  }
}

function runGate({ report = evidence(), audit = auditWithHigh(), accepted = acceptedWith() } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-security-gate-'))
  const outputDir = path.join(cwd, 'docs/security-audit')
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, 'security-report.json'), JSON.stringify(report))
  fs.writeFileSync(path.join(outputDir, 'npm-audit.json'), JSON.stringify(audit))
  fs.writeFileSync(path.join(outputDir, 'known-accepted.json'), JSON.stringify(accepted))
  try {
    const result = spawnSync(process.execPath, [GATE], { cwd, encoding: 'utf8' })
    assert.ifError(result.error)
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

test('security gate passes a clean dependency audit', () => {
  const result = runGate({ audit: cleanAudit(), accepted: { reviewedAt: utcDate(), accepted: [] } })
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /gate: PASS/)
})

test('security gate blocks a direct high advisory even when its ID is listed as accepted', () => {
  const result = runGate()
  assert.notEqual(result.status, 0)
  assert.match(result.output, /high advisory in direct dependency sample-package; high findings cannot be exempted/)
})

test('security gate blocks transitive high advisories as well as direct advisories', () => {
  const audit = auditWithHigh()
  audit.vulnerabilities['sample-package'].isDirect = false
  const result = runGate({ audit })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /high advisory in transitive dependency sample-package; high findings cannot be exempted/)
})

test('security gate blocks audit evidence whose reported high count disagrees with its records', () => {
  const audit = cleanAudit()
  audit.metadata.vulnerabilities.high = 1
  const result = runGate({ audit, accepted: { reviewedAt: utcDate(), accepted: [] } })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /high count does not match its vulnerability records/)
})

test('security gate blocks an expired exception', () => {
  const result = runGate({ accepted: acceptedWith([ADVISORY], utcDate(-1)) })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /incomplete advisory exemption/)
})

test('security gate blocks missing or malformed audit evidence', () => {
  const result = runGate({ audit: {} })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /npm-audit.json is missing, malformed, or incomplete/)
})

test('security gate blocks when built-app UI evidence is missing', () => {
  const report = evidence()
  delete (report.sections as Record<string, unknown>).ui
  const result = runGate({ report })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /built-app checks are missing, incomplete, or not PASS/)
})
