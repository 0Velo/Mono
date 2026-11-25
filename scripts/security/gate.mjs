#!/usr/bin/env node
/**
 * Fail-closed deployment gate. Missing, malformed, or incomplete evidence blocks.
 * Every critical or high dependency advisory blocks; the accepted list is audit
 * metadata only and cannot suppress a high-severity finding.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const reportPath = path.join(ROOT, 'docs/security-audit/security-report.json')
const auditPath = path.join(ROOT, 'docs/security-audit/npm-audit.json')
const acceptedPath = path.join(ROOT, 'docs/security-audit/known-accepted.json')
const problems = []
const warnings = []

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const report = readJson(reportPath)
const audit = readJson(auditPath)
const accepted = readJson(acceptedPath)

function parseDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed
}

if (!report || typeof report !== 'object' || !report.sections || typeof report.sections !== 'object') {
  problems.push('security-report.json is missing, malformed, or has no sections — rerun the security suite')
} else {
  const staticScan = report.sections.static
  if (!staticScan || !Array.isArray(staticScan.checks) || staticScan.checks.length === 0) {
    problems.push('static scan evidence is missing or incomplete')
  } else {
    const invalid = staticScan.checks.filter((check) => !['PASS', 'FAIL', 'INFO', 'REVIEW'].includes(check?.status))
    if (invalid.length) problems.push(`static scan contains invalid status on ${invalid.length} check(s)`)
    const fails = staticScan.checks.filter((check) => check.status === 'FAIL')
    if (fails.length) problems.push(`static scan FAIL: ${fails.map((item) => item.id ?? 'unknown').join(', ')}`)
  }

  const secrets = report.sections.secrets
  if (
    !secrets ||
    secrets.status !== 'PASS' ||
    !Array.isArray(secrets.workingTree?.findings) ||
    !Array.isArray(secrets.builtArtifacts?.findings) ||
    !Array.isArray(secrets.gitHistory?.findings) ||
    typeof secrets.scanned?.trackedFiles !== 'number' ||
    typeof secrets.scanned?.commits !== 'number' ||
    secrets.gitHistory.error
  ) {
    problems.push('secret scan evidence is missing, incomplete, or not PASS (working tree, build, and git history are all required)')
  } else if (
    secrets.workingTree.findings.length ||
    secrets.builtArtifacts.findings.length ||
    secrets.gitHistory.findings.length
  ) {
    problems.push('secret scan found potential secret material')
  }

  const unit = report.sections.unit
  if (
    !unit ||
    !Number.isInteger(unit.pass) ||
    !Number.isInteger(unit.fail) ||
    !Array.isArray(unit.tests) ||
    unit.tests.length === 0 ||
    !Array.isArray(unit.compileErrors) ||
    unit.pass + unit.fail !== unit.tests.length
  ) {
    problems.push('unit test evidence is missing, malformed, or incomplete')
  } else {
    if (unit.fail > 0) problems.push(`unit tests failed: ${unit.fail}`)
    if (unit.compileErrors.length) problems.push(`unit test bundle failed to compile: ${unit.compileErrors.length} file(s)`)
    if (unit.tests.some((test) => !['PASS', 'FAIL'].includes(test?.status))) {
      problems.push('unit test report contains an invalid test status')
    }
  }

  const ui = report.sections.ui
  if (
    !ui ||
    ui.status !== 'PASS' ||
    !Array.isArray(ui.checks) ||
    ui.checks.length === 0 ||
    ui.checks.some((check) => !['PASS', 'FAIL', 'INFO', 'REVIEW'].includes(check?.status)) ||
    ui.checks.some((check) => check.status === 'FAIL')
  ) {
    problems.push(`built-app checks are missing, incomplete, or not PASS: ${ui?.status ?? 'missing status'}`)
  }
}

if (
  !audit ||
  typeof audit !== 'object' ||
  !audit.metadata?.vulnerabilities ||
  typeof audit.metadata.vulnerabilities !== 'object' ||
  !audit.vulnerabilities ||
  typeof audit.vulnerabilities !== 'object'
) {
  problems.push('npm-audit.json is missing, malformed, or incomplete — dependency risk was not evaluated')
} else {
  const counts = audit.metadata.vulnerabilities
  for (const severity of ['critical', 'high']) {
    if (!Number.isInteger(counts[severity]) || counts[severity] < 0) {
      problems.push(`npm-audit.json has an invalid ${severity} vulnerability count`)
      continue
    }
    const actual = Object.values(audit.vulnerabilities).filter((item) => item?.severity === severity).length
    if (actual !== counts[severity]) {
      problems.push(`npm-audit.json ${severity} count does not match its vulnerability records (${counts[severity]} reported, ${actual} listed)`)
    }
  }
}

if (!accepted || !Array.isArray(accepted.accepted)) {
  problems.push('known-accepted.json is missing, malformed, or has no accepted array')
}

const today = parseDateOnly(new Date().toISOString().slice(0, 10))
const reviewedAt = parseDateOnly(accepted?.reviewedAt)
if (!reviewedAt) {
  problems.push('known-accepted.json needs a valid reviewedAt date')
} else if (reviewedAt > today) {
  problems.push('known-accepted.json reviewedAt cannot be in the future')
}

let exemptions = new Map()
if (Array.isArray(accepted?.accepted)) {
  for (const entry of accepted.accepted) {
    const reviewBy = parseDateOnly(entry?.reviewBy)
    const advisoryIds = entry?.advisories
    const maxReviewBy = reviewedAt ? new Date(reviewedAt) : null
    if (maxReviewBy) maxReviewBy.setUTCFullYear(maxReviewBy.getUTCFullYear() + 1)
    if (
      !entry ||
      typeof entry.package !== 'string' ||
      !entry.package ||
      entry.severity !== 'high' ||
      typeof entry.reason !== 'string' ||
      !entry.reason.trim() ||
      typeof entry.scope !== 'string' ||
      !entry.scope.trim() ||
      !Array.isArray(advisoryIds) ||
      advisoryIds.length === 0 ||
      advisoryIds.some((id) => typeof id !== 'string' || !/^GHSA-[0-9A-Z]+-[0-9A-Z]+-[0-9A-Z]+$/i.test(id)) ||
      !reviewBy ||
      (today && reviewBy < today) ||
      (reviewedAt && reviewBy <= reviewedAt) ||
      (maxReviewBy && reviewBy > maxReviewBy)
    ) {
      problems.push('known-accepted.json contains an incomplete advisory exemption')
      continue
    }
    if (exemptions.has(entry.package)) problems.push(`duplicate exemption for ${entry.package}`)
    exemptions.set(entry.package, entry)
  }
}

if (audit?.vulnerabilities && typeof audit.vulnerabilities === 'object' && exemptions instanceof Map) {
  for (const [name, item] of Object.entries(audit.vulnerabilities)) {
    if (!item || !['critical', 'high', 'moderate', 'low'].includes(item.severity)) {
      problems.push(`npm audit has an invalid advisory record for ${name}`)
      continue
    }
    if (item.severity === 'critical') {
      problems.push(`critical advisory in ${name}; critical findings cannot be exempted`)
    } else if (item.severity === 'high') {
      const directness = item.isDirect ? 'direct' : 'transitive'
      problems.push(`high advisory in ${directness} dependency ${name}; high findings cannot be exempted (fix: ${JSON.stringify(item.fixAvailable)})`)
    }
  }
  for (const [name] of exemptions) {
    if (!audit.vulnerabilities[name]) warnings.push(`known-accepted entry ${name} no longer matches an advisory — review and remove it`)
  }
}

for (const warning of warnings) console.log(`WARN ${warning}`)
if (problems.length) {
  for (const problem of problems) console.log(`BLOCK ${problem}`)
  console.log(`gate: BLOCKED (${problems.length} problem(s))`)
  process.exit(1)
}
console.log('gate: PASS')
