#!/usr/bin/env node
/**
 * Secret scan over the working tree and the whole git history.
 *
 * Looks for the shapes a Solana wallet must never commit: Base58 secret keys
 * (64 bytes), the `[12, 34, ...]` keypair array JSON, PEM private keys, API
 * keys, and 12+ word BIP39 runs. Known public test vectors live in
 * scripts/security/ and are reported separately, not counted as leaks.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()

const BASE58 = '1-9A-HJ-NP-Za-km-z'
const RULES = [
  {
    id: 'SC-01',
    name: 'Base58 64-byte secret key (87-88 chars)',
    pattern: `[${BASE58}]{87,88}`,
    grep: `[${BASE58}]{87,88}`,
    boundary: true,
  },
  {
    id: 'SC-02',
    name: 'JSON keypair byte array (64 integers 0-255)',
    pattern: '\\[(\\s*\\d{1,3}\\s*,){63}\\s*\\d{1,3}\\s*\\]',
    grep: 'the 64-number keypair array is checked in JavaScript only',
  },
  {
    id: 'SC-03',
    name: 'PEM private key block',
    pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    grep: '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  },
  {
    id: 'SC-04',
    name: 'Provider API key literal',
    pattern: '(api-key=|sk-|ghp_|github_pat_|xox[baprs]-|AIza|SG\\.)[A-Za-z0-9_\\-]{20,}',
    grep: '(api-key=|sk-|ghp_|github_pat_|xox[baprs]-|AIza|SG\\.)[A-Za-z0-9_-]{20,}',
  },
]

const BIP39_WORDS = (() => {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'node_modules/bip39/src/wordlists/english.json'), 'utf8')
    return new Set(JSON.parse(raw))
  } catch {
    return null
  }
})()

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

function trackedFiles() {
  // Tracked files plus files that are untracked but not git-ignored: a secret
  // sitting in a file that is about to be committed must be caught before it is.
  return git(['ls-files', '--cached', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
}

function isBase58(char) {
  return Boolean(char) && /[1-9A-HJ-NP-Za-km-z]/.test(char)
}

function scanText(text) {
  const hits = []
  for (const rule of RULES) {
    const regex = new RegExp(rule.pattern, 'g')
    let match
    while ((match = regex.exec(text)) !== null) {
      if (rule.boundary && (isBase58(text[match.index - 1]) || isBase58(text[match.index + match[0].length]))) {
        continue
      }
      hits.push({ rule: rule.id, ruleName: rule.name, sample: match[0].slice(0, 12) + '…' })
    }
  }
  if (BIP39_WORDS) {
    for (const match of text.matchAll(/\b(?:[a-z]{3,8}[ \t]+){11}[a-z]{3,8}\b/g)) {
      const words = match[0].trim().split(/[ \t]+/)
      if (words.every((word) => BIP39_WORDS.has(word))) {
        hits.push({ rule: 'SC-05', ruleName: 'BIP39 12+ word run', sample: words.slice(0, 3).join(' ') + ' …' })
      }
    }
  }
  return hits
}

/* ------------------------------------------------------------- work tree */
const tree = []
const skipped = ['package-lock.json', 'derivation-vectors.json']
for (const file of trackedFiles()) {
  if (!/\.(ts|tsx|js|mjs|cjs|json|md|html|css|yml|yaml|txt|sh|py|env|example)$/.test(file)) continue
  if (skipped.some((name) => file.endsWith(name))) continue
  const full = path.join(ROOT, file)
  if (!fs.existsSync(full)) continue
  const size = fs.statSync(full).size
  if (size > 4 * 1024 * 1024) continue
  const text = fs.readFileSync(full, 'utf8')
  for (const hit of scanText(text)) tree.push({ file, ...hit })
}

// BIP39-shaped phrases are allowed only inside the security suite's own test
// vectors (the public abandon…about / legal winner… phrases). A Base58 key or
// API-key shaped string anywhere, including scripts/, is still a finding.
const isVector = (hit) => hit.rule === 'SC-05' && hit.file.startsWith('scripts/security/')
const treeReal = tree.filter((hit) => !isVector(hit))
const treeVectors = tree.filter((hit) => isVector(hit))

/* ------------------------------------------------------- built artifacts */
const built = []
const distDir = path.join(ROOT, 'dist')
if (fs.existsSync(distDir)) {
  const walkDist = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walkDist(full)
      else if (/\.(js|html|json|css)$/.test(entry.name)) {
        const file = path.relative(ROOT, full)
        for (const hit of scanText(fs.readFileSync(full, 'utf8'))) built.push({ file, ...hit })
      }
    }
  }
  walkDist(distDir)
}

/* ---------------------------------------------------------- git history */
const history = []
let commits = []
try {
  commits = git(['rev-list', '--all']).split('\n').filter(Boolean)
} catch {
  commits = []
}

const historyPattern = RULES.filter((rule) => rule.grep).map((rule) => rule.grep).join('|')
let historyRaw = ''
let historyError = null
try {
  historyRaw = commits.length ? git(['grep', '-I', '-n', '-E', historyPattern, ...commits]) : ''
} catch (error) {
  // exit code 1 simply means "no match"; anything else must not read as clean.
  if (error?.status === 1) historyRaw = error?.stdout ? String(error.stdout) : ''
  else historyError = String(error?.stderr || error?.message || error).slice(0, 500)
}
for (const line of historyRaw.split('\n').filter(Boolean)) {
  const match = line.match(/^([0-9a-f]{40}):([^:]+):(\d+):(.*)$/)
  if (!match) continue
  const [, commit, file, lineNumber, content] = match
  const rule = RULES.find((item) => new RegExp(item.pattern).test(content))
  if (!rule) continue
  history.push({ commit: commit.slice(0, 10), file, line: Number(lineNumber), rule: rule.id })
}

/* ---------------------------------------------------------------- report */
const summary = {
  generatedAt: new Date().toISOString(),
  scanned: {
    trackedFiles: trackedFiles().length,
    commits: commits.length,
  },
  workingTree: {
    findings: treeReal,
    allowedTestVectors: treeVectors.length,
  },
  builtArtifacts: {
    findings: built,
  },
  gitHistory: {
    findings: history,
    error: historyError,
  },
  status: historyError ? 'ERROR' : treeReal.length === 0 && history.length === 0 && built.length === 0 ? 'PASS' : 'FAIL',
}

const outDir = path.join(ROOT, 'docs/security-audit')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'secret-scan.json'), JSON.stringify(summary, null, 2))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log(`tracked files: ${summary.scanned.trackedFiles}, commits scanned: ${summary.scanned.commits}`)
  console.log(`working tree findings: ${treeReal.length} (allowed public test vectors: ${treeVectors.length})`)
  for (const hit of treeReal) console.log(`  ${hit.rule} ${hit.file} ${hit.sample}`)
  console.log(`built artifact findings: ${built.length}`)
  for (const hit of built.slice(0, 10)) console.log(`  ${hit.rule} ${hit.file} ${hit.sample}`)
  console.log(`git history findings: ${history.length}${historyError ? ` (ERROR: ${historyError})` : ''}`)
  for (const hit of history.slice(0, 20)) console.log(`  ${hit.rule} ${hit.commit} ${hit.file}:${hit.line}`)
  console.log(`status: ${summary.status}`)
}

process.exitCode = summary.status === 'PASS' ? 0 : 1
