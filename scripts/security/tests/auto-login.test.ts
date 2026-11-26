/**
 * Read-only auto-login ("조회 자동 로그인") and its PIN gate.
 *
 * The promise being tested is narrow and checkable: with auto-login on, the app
 * can show balances, tokens and history from public data alone, and every
 * action that needs the key passes one PIN check — no screen can reach a
 * signing path without it. Anything the browser would have to prove (an actual
 * Face ID sheet, iOS keychain behaviour) is checked in the built-app suite or
 * left as UNVERIFIED, never asserted here.
 */
import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTH_GRANT_TTL_MS,
  AUTH_PURPOSES,
  authPurposeInfo,
  grantExpired,
  isSecretWiped,
  modeAfterKeyWipe,
  requiresAuth,
  sanitizeAutoLogin,
  shouldAutoEnterViewOnly,
  wipeSecretBytes,
} from '../../../src/lib/authGate'
import {
  accountIndices,
  addressRecord,
  publicAccounts,
  readMeta,
  sanitizeAccountAddresses,
  writeMeta,
  type WalletMeta,
} from '../../../src/state/WalletProvider'
import { NETWORK_DISPLAY_NAME, networkDisplayName } from '../../../src/lib/rpc'
import { readRepoFile } from './helpers'

class FakeStorage {
  values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

let storage: FakeStorage
let originalStorage: PropertyDescriptor | undefined

beforeEach(() => {
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  storage = new FakeStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
})

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

const ADDRESS_A = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const ADDRESS_B = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'

const meta = (overrides: Partial<WalletMeta> = {}): WalletMeta => ({
  address: ADDRESS_A,
  name: 'Mono',
  network: 'mainnet',
  rpc: { mainnet: '', devnet: '' },
  autoLockMinutes: 5,
  createdAt: 1,
  activeIndex: 0,
  accountNames: {},
  autoLogin: false,
  ...overrides,
})

/* ------------------------------------------------------------- the setting */

test('auto-login is off unless the stored value is exactly true', () => {
  assert.equal(sanitizeAutoLogin(true), true)
  for (const value of [false, 'true', 'on', 1, 0, null, undefined, {}, []]) {
    assert.equal(sanitizeAutoLogin(value), false, `${JSON.stringify(value)} must not enable auto-login`)
  }
})

test('the choice survives a metadata round trip and junk keeps it off', () => {
  writeMeta(meta({ autoLogin: true }))
  assert.equal(readMeta()?.autoLogin, true)
  writeMeta(meta({ autoLogin: false }))
  assert.equal(readMeta()?.autoLogin, false)

  storage.setItem(
    'mono.meta.v1',
    JSON.stringify({ ...meta(), autoLogin: 'yes' }),
  )
  assert.equal(readMeta()?.autoLogin, false, 'a hand-edited string must not open the wallet')

  storage.setItem('mono.meta.v1', JSON.stringify({ address: ADDRESS_A }))
  assert.equal(readMeta()?.autoLogin, false, 'metadata from an older build has no auto-login')
})

test('a launch opens the read-only home only with a vault and the setting on', () => {
  assert.equal(shouldAutoEnterViewOnly({ autoLogin: true }, true), true)
  assert.equal(shouldAutoEnterViewOnly({ autoLogin: true }, false), false)
  assert.equal(shouldAutoEnterViewOnly({ autoLogin: false }, true), false)
  assert.equal(shouldAutoEnterViewOnly(null, true), false)
  assert.equal(shouldAutoEnterViewOnly(undefined, true), false)
  assert.equal(shouldAutoEnterViewOnly({ autoLogin: 'true' }, true), false)
})

test('wiping a key leaves the read-only home when auto-login is on, else the lock screen', () => {
  assert.equal(modeAfterKeyWipe({ autoLogin: true, vaultExists: true }), 'view')
  assert.equal(modeAfterKeyWipe({ autoLogin: false, vaultExists: true }), 'locked')
  assert.equal(modeAfterKeyWipe({ autoLogin: true, vaultExists: false }), 'locked')
})

/* --------------------------------------------------------------- the gate */

test('every action that needs the key asks for the PIN, and unknown asks too', () => {
  for (const purpose of ['send', 'swap', 'reclaim', 'reveal-seed', 'export-backup', 'auto-login']) {
    assert.equal(requiresAuth(purpose), true, `${purpose} must be gated`)
  }
  // Fail closed: a call site with a typo cannot silently skip the check.
  assert.equal(requiresAuth('sendd'), true)
  assert.equal(requiresAuth(''), true)
})

test('each gated action explains itself in one line', () => {
  for (const purpose of Object.keys(AUTH_PURPOSES)) {
    const info = authPurposeInfo(purpose)
    assert.ok(info.label.trim().length > 0, `${purpose} needs a label`)
    assert.ok(info.detail.trim().length > 10, `${purpose} needs a sentence`)
  }
  const fallback = authPurposeInfo('not-a-purpose')
  assert.ok(fallback.label.length > 0 && fallback.detail.length > 0)
})

test('a PIN grant expires on its own', () => {
  const start = 1_000_000
  assert.equal(grantExpired(start, start + 1_000), false)
  assert.equal(grantExpired(start, start + AUTH_GRANT_TTL_MS - 1), false)
  assert.equal(grantExpired(start, start + AUTH_GRANT_TTL_MS), true)
  assert.equal(grantExpired(0, Date.now()), true)
  assert.equal(grantExpired(Number.NaN, Date.now()), true)
})

test('releasing the key zeroes the secret bytes in place', () => {
  const secretKey = new Uint8Array(64).fill(7)
  const keypair = { secretKey }
  assert.equal(isSecretWiped(keypair), false)
  assert.equal(wipeSecretBytes(keypair), true)
  assert.equal(isSecretWiped(keypair), true)
  assert.equal(secretKey.every((byte) => byte === 0), true)
  // Wiping twice is harmless, and no keypair is treated as already wiped.
  assert.equal(wipeSecretBytes(keypair), true)
  assert.equal(isSecretWiped(null), true)
})

/* ------------------------------------------------- the screens need no key */

test('accounts are listed from public metadata alone', () => {
  const local = meta({
    activeIndex: 2,
    accountIndices: [1, 2],
    accountNames: { '1': '투빗' },
    accountAddresses: { '0': ADDRESS_A, '1': ADDRESS_B, '2': '9xQeWvG816bUx9EPfEZvJ6W4Z8W1k1m8m8s8m8s8m8s8' },
  })
  const list = publicAccounts(local)
  assert.deepEqual(
    list.map((account) => account.index),
    accountIndices(2, { '1': '투빗' }, [1, 2]),
  )
  assert.equal(list.find((account) => account.index === 2)?.address, local.address)
  assert.equal(list.find((account) => account.index === 1)?.name, '투빗')
  assert.equal(list.find((account) => account.index === 1)?.address, ADDRESS_B)
  // No metadata, no list: the app must not invent an account.
  assert.deepEqual(publicAccounts(null), [])
})

test('the stored address registry rejects anything that is not a derived address', () => {
  const clean = sanitizeAccountAddresses({
    '0': ADDRESS_A,
    '1': '  ',
    '2': '<script>alert(1)</script>',
    '3': 42,
    '999': ADDRESS_B,
    'x': ADDRESS_B,
  })
  assert.deepEqual(clean, { '0': ADDRESS_A })
  assert.deepEqual(sanitizeAccountAddresses(null), {})
  assert.deepEqual(sanitizeAccountAddresses([ADDRESS_A]), {})
  assert.deepEqual(addressRecord([{ index: 0, address: ADDRESS_A, name: '메인' }]), { '0': ADDRESS_A })
})

test('the provider enters read-only mode without decrypting anything', () => {
  const provider = readRepoFile('src/state/WalletProvider.tsx')
  // The launch path consults the setting; the key is only produced by unlock,
  // the PIN sheet, seed reveal or a backup restore.
  assert.match(provider, /shouldAutoEnterViewOnly\(storedMeta, Boolean\(stored\)\)/)
  const initializeBlock = provider.slice(
    provider.indexOf('const initialize = async () => {'),
    provider.indexOf('void initialize()'),
  )
  assert.ok(initializeBlock.length > 0, 'launch path found')
  assert.ok(!/decryptSecret/.test(initializeBlock), 'launch must not decrypt the vault')
  assert.ok(!/applyPayload/.test(initializeBlock), 'launch must not derive keys')
  // One prompt for the whole app, rendered by the provider itself.
  assert.match(provider, /<AuthPrompt purpose=\{authPurpose\}/)
  assert.match(provider, /canView: keypair !== null \|\| viewOnly/)
})

test('every sensitive action goes through requestAuth before it signs', () => {
  const sites: Array<[string, string]> = [
    ['src/sheets/SendSheet.tsx', "requestAuth('send')"],
    ['src/screens/Swap.tsx', "requestAuth('swap')"],
    ['src/sheets/RentSheet.tsx', "requestAuth('reclaim')"],
    ['src/sheets/BackupSheet.tsx', "requestAuth('export-backup')"],
    ['src/screens/Settings.tsx', "requestAuth('auto-login')"],
    ['src/screens/Settings.tsx', "requestAuth('export-backup')"],
    ['src/sheets/AccountsSheet.tsx', "requestAuth('account')"],
    ['src/sheets/ResetSheet.tsx', "requestAuth('reset')"],
  ]
  for (const [file, needle] of sites) {
    assert.ok(readRepoFile(file).includes(needle), `${file} must ask for ${needle}`)
  }
  // The send signature uses the key the gate returned, never a stale prop.
  const send = readRepoFile('src/sheets/SendSheet.tsx')
  assert.match(send, /signPreparedSend\(connection, prepared, signer, hooks\)/)
  // ...and every send path releases it again.
  assert.match(send, /endAuthSession\(\)/)
  assert.match(readRepoFile('src/screens/Swap.tsx'), /signPreparedSwap\(\{ connection, keypair: signer,/)
})

test('the app shows the shell when read-only and never leaves the seed on screen', () => {
  const app = readRepoFile('src/App.tsx')
  // After a real unlock the lock screen keeps its place for one short beat so
  // the mascot can react; a read-only launch never gets that beat, because it
  // never held a key to release.
  assert.match(app, /!canView \|\| unlockBeat/g)
  assert.match(app, /<LockScreen celebrating=\{canView\} \/>/)
  assert.match(app, /canView && !wasCanView\.current && !viewOnly/)
  assert.match(app, /<Shell \/>/)
  // The splash lands on a lock screen; auto-login has no keypad to land on.
  assert.match(app, /if \(vaultExists && !canView\) beginSplashLanding\(\)/)
})

/* ------------------------------------------------------- token detail: 받기 */

test('token detail offers 보내기·받기·스왑 in one row and wires 받기 to the receive sheet', () => {
  const detail = readRepoFile('src/sheets/TokenDetailSheet.tsx')
  assert.match(detail, /onReceive: \(\) => void/)
  const actions = detail.slice(detail.indexOf('mt-5 grid grid-cols-3 gap-2'))
  assert.ok(actions.length > 0, 'three-button action row found')
  assert.match(actions, /data-token-actions/)
  for (const id of ['token-send', 'token-receive', 'token-swap']) {
    assert.match(actions, new RegExp(`id="${id}"`))
  }
  assert.ok(actions.indexOf('token-send') < actions.indexOf('token-receive'))
  assert.ok(actions.indexOf('token-receive') < actions.indexOf('token-swap'))
  assert.match(actions, /onClick=\{onReceive\}/)

  const shell = readRepoFile('src/Shell.tsx')
  assert.match(shell, /onReceive=\{\(\) => setSheet\(\{ type: 'receive' \}\)\}/)
})

/* ------------------------------------------------ receive: network wording */

test('the receive screen names the network the way an exchange does', () => {
  assert.equal(NETWORK_DISPLAY_NAME.mainnet, 'Solana (SOL · SPL)')
  assert.equal(NETWORK_DISPLAY_NAME.devnet, 'Solana Devnet')
  assert.equal(networkDisplayName('mainnet'), 'Solana (SOL · SPL)')
  assert.equal(networkDisplayName('devnet'), 'Solana Devnet')

  const receive = readRepoFile('src/sheets/ReceiveSheet.tsx')
  assert.match(receive, /subtitle=\{networkDisplayName\(network\)\}/)
  const hint = receive.slice(receive.indexOf('data-receive-network-hint'))
  assert.match(hint, /Solana\(SOL\)/)
  assert.match(hint, /BEP20\/ERC20 불가/)
  assert.ok(!/Solana Mainnet/.test(receive), 'the developer-facing "Mainnet" label must be gone')
  // The other places that used to print it agree.
  assert.ok(!/Solana Mainnet/.test(readRepoFile('src/sheets/TokenDetailSheet.tsx')))
  assert.ok(!/Solana Mainnet/.test(readRepoFile('src/sheets/SendSheet.tsx')))
})
