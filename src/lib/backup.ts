/**
 * One-tap encrypted backup file.
 *
 * The file carries the *sealed* vault that already sits in IndexedDB — the
 * same AES-256-GCM ciphertext the PIN unlocks. No seed word, private key or
 * PIN ever enters the file, so it can live in iCloud Drive or Files without
 * exposing anything. Restoring still needs the PIN.
 */

import { isVaultShape, type Vault } from './vault'

export type BackupApp = 'mono' | 'sol-wallet'

export interface BackupFile extends Vault {
  app: BackupApp
  kind: string
  exportedAt: number
  /** Public key — identifies the file without revealing any secret. */
  address?: string
}

export function buildBackupFile(vault: Vault, address?: string): BackupFile {
  return {
    ...vault,
    app: 'mono',
    kind: 'mono-backup',
    exportedAt: Date.now(),
    ...(address ? { address } : {}),
  }
}

export function backupFileName(date = new Date()): string {
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
    date.getDate(),
  ).padStart(2, '0')}`
  return `mono-backup-${stamp}.json`
}

export type BackupSaveResult = 'shared' | 'downloaded'

/**
 * iPhone-first: hand the file to the iOS share sheet so "Save to Files" or
 * iCloud Drive is one tap away. Falls back to a normal download everywhere
 * else (or when sharing files is unsupported).
 */
export async function saveBackupFile(vault: Vault, address?: string): Promise<BackupSaveResult> {
  const json = JSON.stringify(buildBackupFile(vault, address), null, 2)
  const name = backupFileName()
  const file = new File([json], name, { type: 'application/json' })

  const nav = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean
  }
  if (typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: 'Mono 백업' })
      return 'shared'
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw error
      // fall through to the download path
    }
  }

  const url = URL.createObjectURL(file)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 4000)
  return 'downloaded'
}

export interface ParsedBackup {
  vault: Vault
  address?: string
  exportedAt?: number
}

/** Throws a plain Korean error when the file is not a Mono backup. */
export function parseBackupFile(text: string): ParsedBackup {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('JSON 파일이 아닙니다. 백업 파일을 다시 선택해 주세요.')
  }
  if (!isVaultShape(parsed)) {
    throw new Error('Mono 백업 파일이 아닙니다.')
  }
  const record = parsed as BackupFile
  // Files exported before the rename carry app: 'sol-wallet' — still valid.
  if (record.app && record.app !== 'mono' && record.app !== 'sol-wallet') {
    throw new Error('Mono 백업 파일이 아닙니다.')
  }
  return {
    vault: {
      v: 1,
      alg: 'AES-GCM',
      kdf: 'PBKDF2-SHA256',
      iter: record.iter,
      salt: record.salt,
      iv: record.iv,
      ct: record.ct,
      createdAt: record.createdAt ?? Date.now(),
    },
    address: typeof record.address === 'string' ? record.address : undefined,
    exportedAt: typeof record.exportedAt === 'number' ? record.exportedAt : undefined,
  }
}
