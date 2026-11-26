/**
 * Auth policy for the view-only ("조회 자동 로그인") session.
 *
 * With auto-login on, opening the app shows the wallet's public data — address,
 * accounts, balances, tokens, history — without decrypting anything. The
 * mnemonic never leaves the encrypted vault, so the screens are wired to the
 * address alone.
 *
 * Anything that spends, signs, or reveals a secret has to pass one PIN check
 * first. This module is the single, testable description of that rule: which
 * actions are gated, what the gate says, and how long a grant may keep a key
 * in memory. It intentionally holds no React and no wallet state, so the
 * policy can be asserted by unit tests rather than by reading the components.
 */

export type AuthPurpose =
  | 'send'
  | 'swap'
  | 'reclaim'
  | 'reveal-seed'
  | 'export-backup'
  | 'auto-login'
  | 'account'
  | 'reset'

export interface AuthPurposeInfo {
  /** Short name shown in the sheet title area. */
  label: string
  /** One line explaining why the check is happening right now. */
  detail: string
}

export const AUTH_PURPOSES: Record<AuthPurpose, AuthPurposeInfo> = {
  send: {
    label: '송금',
    detail: '잔액을 보내려면 PIN으로 본인 확인이 필요합니다. 확인한 뒤에만 키를 복호화해 서명합니다.',
  },
  swap: {
    label: '스왑',
    detail: '스왑을 실행하려면 PIN으로 본인 확인이 필요합니다. 확인한 뒤에만 키를 복호화해 서명합니다.',
  },
  reclaim: {
    label: '빈 계정 정리',
    detail: '빈 토큰 계정을 닫으려면 PIN으로 본인 확인이 필요합니다. 확인한 뒤에만 서명합니다.',
  },
  'reveal-seed': {
    label: '시드 문구 확인',
    detail: '시드 문구는 PIN을 확인한 뒤에만 화면에 표시합니다.',
  },
  'export-backup': {
    label: '백업 내보내기',
    detail: '암호화 백업 파일을 내보내려면 PIN으로 본인 확인이 필요합니다.',
  },
  'auto-login': {
    label: '보안 설정 변경',
    detail: '자동 로그인 설정을 바꾸려면 PIN으로 본인 확인이 필요합니다.',
  },
  account: {
    label: '계정 관리',
    detail: '계정을 바꾸거나 추가하려면 PIN으로 본인 확인이 필요합니다. 주소는 시드 문구에서 파생됩니다.',
  },
  reset: {
    label: '지갑 초기화',
    detail: '기기에 저장된 지갑을 지우려면 PIN으로 본인 확인이 필요합니다.',
  },
}

/**
 * Whether the action needs a fresh check. Every known purpose does; an unknown
 * string also fails closed, so a new call site cannot quietly skip the gate.
 */
export function requiresAuth(purpose: string): boolean {
  return purpose in AUTH_PURPOSES ? true : true
}

/** Purpose text for the sheet, with a safe fallback for an unknown purpose. */
export function authPurposeInfo(purpose: string): AuthPurposeInfo {
  return AUTH_PURPOSES[purpose as AuthPurpose] ?? {
    label: '인증',
    detail: '이 작업을 실행하려면 PIN으로 본인 확인이 필요합니다.',
  }
}

/**
 * A grant keeps the decrypted key alive only while the action is running. Even
 * if a screen forgets to release it, the key is wiped at this deadline.
 */
export const AUTH_GRANT_TTL_MS = 180_000

export function grantExpired(startedAt: number, now: number, ttl: number = AUTH_GRANT_TTL_MS): boolean {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return true
  return now - startedAt >= ttl
}

/** Persisted auto-login choice: only a literal `true` turns it on. */
export function sanitizeAutoLogin(value: unknown): boolean {
  return value === true
}

/**
 * Should this launch open straight into the read-only home? Only when a vault
 * exists and the person turned auto-login on. Anything unreadable (no meta, no
 * vault) keeps the normal lock screen, so a damaged store never looks like an
 * unlocked wallet.
 */
export function shouldAutoEnterViewOnly(
  storedMeta: { autoLogin?: unknown } | null | undefined,
  vaultExists: boolean,
): boolean {
  if (!vaultExists || !storedMeta) return false
  return sanitizeAutoLogin(storedMeta.autoLogin)
}

/** Where a wipe leaves the app: the read-only home, or the lock screen. */
export function modeAfterKeyWipe(options: {
  autoLogin: boolean
  vaultExists: boolean
}): 'view' | 'locked' {
  return options.vaultExists && options.autoLogin ? 'view' : 'locked'
}

export interface WipeableKeypair {
  secretKey: Uint8Array
}

/** Overwrite the 64 secret bytes in place. Returns true when they are zeroed. */
export function wipeSecretBytes(keypair: WipeableKeypair | null | undefined): boolean {
  if (!keypair || !keypair.secretKey) return false
  try {
    keypair.secretKey.fill(0)
    return true
  } catch {
    return false
  }
}

/** True when every secret byte is zero (used by tests and by the lock path). */
export function isSecretWiped(keypair: WipeableKeypair | null | undefined): boolean {
  if (!keypair || !keypair.secretKey) return true
  const bytes = keypair.secretKey
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) return false
  }
  return true
}

/** Public label used wherever the app tells the person it is read-only. */
export const VIEW_ONLY_CHIP = '조회 전용'
export const VIEW_ONLY_NOTICE = '자동 로그인 (조회 전용)'
