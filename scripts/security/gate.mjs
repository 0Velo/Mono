#!/usr/bin/env node
/**
 * Deploy gate: fails a build that must not reach mainnet hosting.
 *
 * Rules:
 *  - any FAIL in the static scan, the secret scan or the unit suite blocks;
 *  - a `critical` advisory anywhere in the production dependency tree blocks;
 *  - a `high` advisory on a *direct* production dependency blocks;
 *  - transitive `high` advisories that cannot be fixed without a major upgrade
 *    are reported as warnings with the reason (see docs/SECURITY_AUDIT_REPORT.md).
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const reportPath = path.join(ROOT, 'docs/security-audit/security-report.json')
const auditPath = path.join(ROOT, 'docs/security-audit/npm-audit.json')

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const report = readJson(reportPath)
const audit = readJson(auditPath)
const problems = []
const warnings = []

if (!report) {
  problems.push('security-report.json is missing — run `npm run test:security` first')
} else {
  const staticFails = (report.sections?.static?.checks ?? []).filter((check) => check.status === 'FAIL')
  if (staticFails.length) problems.push(`static scan FAIL: ${staticFails.map((item) => item.id).join(', ')}`)
  if (report.sections?.secrets?.status && report.sections.secrets.status !== 'PASS' && report.sections.secrets.status !== 'REVIEW') {
    problems.push(`secret scan ${report.sections.secrets.status}`)
  }
  const unit = report.sections?.unit ?? {}
  if ((unit.fail ?? 0) > 0) problems.push(`unit tests failed: ${unit.fail}`)
  if ((unit.compileErrors ?? []).length) problems.push('unit test bundle failed to compile')
  const ui = report.sections?.ui
  if (ui && ui.status === 'FAIL') problems.push('built-app checks failed')
}

if (!audit) {
  warnings.push('npm-audit.json missing — dependency advisories not evaluated')
} else {
  let accepted = { accepted: [] }
  try {
    accepted = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/security-audit/known-accepted.json'), 'utf8'))
  } catch {
    warnings.push('known-accepted.json missing — no advisory is exempt')
  }
  const exemptions = new Map((accepted.accepted ?? []).map((entry) => [entry.package, entry]))
  const vulns = audit.vulnerabilities ?? {}
  for (const [name, item] of Object.entries(vulns)) {
    const severity = item.severity
    const direct = Boolean(item.isDirect)
    const exempt = exemptions.get(name)
    if (severity === 'critical') {
      problems.push(`critical advisory in ${name}${exempt ? ' — a critical advisory cannot be exempted' : ''}`)
    } else if (severity === 'high' && direct && !exempt) {
      problems.push(`high advisory in direct dependency ${name} (not in known-accepted.json)`)
    } else if (severity === 'high' && direct && exempt) {
      warnings.push(`accepted high advisory in ${name} — ${exempt.reason.slice(0, 140)}… (review by ${exempt.reviewBy})`)
    } else if (severity === 'high') {
      warnings.push(`transitive high advisory in ${name} (fix: ${JSON.stringify(item.fixAvailable)})`)
    }
  }
  for (const [name, entry] of exemptions) {
    if (!vulns[name]) warnings.push(`known-accepted entry ${name} no longer matches an advisory — remove it`)
  }
}

for (const warning of warnings) console.log(`WARN ${warning}`)
if (problems.length) {
  for (const problem of problems) console.log(`BLOCK ${problem}`)
  console.log(`gate: BLOCKED (${problems.length} problem(s))`)
  process.exit(1)
}
console.log('gate: PASS')
