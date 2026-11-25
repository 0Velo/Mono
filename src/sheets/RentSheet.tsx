import { useEffect, useState } from 'react'
import type { Connection, Keypair } from '@solana/web3.js'
import { Check, Coins } from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { Button } from '../components/Button'
import { Spinner } from '../components/Spinner'
import { showToast } from '../components/Toast'
import { cx, formatAmount, formatTxAmount, shortAddress } from '../lib/format'
import { BASE_FEE_LAMPORTS } from '../lib/tx'
import {
  closeEmptyTokenAccounts,
  sumLamports,
  type CloseEmptyAccountsResult,
  type EmptyTokenAccount,
} from '../lib/rent'
import { explorerTx, type NetworkId } from '../lib/rpc'

interface RentSheetProps {
  open: boolean
  onClose: () => void
  connection: Connection | null
  keypair: Keypair | null
  network: NetworkId
  accounts: EmptyTokenAccount[]
  onDone: () => void
}

type Step = 'confirm' | 'closing' | 'done'

/**
 * The confirmation for closing empty token accounts. It exists because closing
 * an account is not undoable: the account address disappears and the rent comes
 * back. Everything shown here is the exact list that will be closed.
 */
export function RentSheet({
  open,
  onClose,
  connection,
  keypair,
  network,
  accounts,
  onDone,
}: RentSheetProps) {
  const [step, setStep] = useState<Step>('confirm')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CloseEmptyAccountsResult | null>(null)

  useEffect(() => {
    if (!open) return
    setStep('confirm')
    setError(null)
    setResult(null)
  }, [open])

  const total = sumLamports(accounts)
  const expected = total > BASE_FEE_LAMPORTS ? total - BASE_FEE_LAMPORTS : 0n

  const close = async () => {
    if (!connection || !keypair || accounts.length === 0) return
    setError(null)
    setStep('closing')
    try {
      const next = await closeEmptyTokenAccounts(connection, keypair, accounts)
      setResult(next)
      setStep('done')
      showToast(`${next.closed}개 계정을 닫았습니다`)
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '빈 계정을 정리하지 못했습니다.')
      setStep('confirm')
    }
  }

  const footer =
    step === 'confirm' ? (
      <div className="space-y-2">
        <Button full onClick={() => void close()} disabled={!connection || !keypair || accounts.length === 0} id="rent-confirm">
          빈 계정 {accounts.length}개 닫고 회수
        </Button>
        <Button full variant="secondary" onClick={onClose}>
          취소
        </Button>
      </div>
    ) : step === 'done' ? (
      <Button full onClick={onClose}>
        닫기
      </Button>
    ) : undefined

  return (
    <Sheet
      open={open}
      onClose={step === 'closing' ? () => {} : onClose}
      title={step === 'done' ? undefined : '빈 토큰 계정 정리'}
      footer={footer}
    >
      {step === 'confirm' && (
        <div className="flex flex-col">
          <div className="flex items-center gap-3 rounded-[18px] bg-surface px-4 py-3.5">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-card text-ink">
              <Coins size={18} strokeWidth={1.9} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold tracking-[-0.02em] text-ink">
                약 +{formatAmount(expected, 9, 4)} SOL 회수
              </div>
              <div className="mt-0.5 text-[11.5px] text-muted">
                잔액 0 · 동결되지 않은 계정 {accounts.length}개
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {accounts.slice(0, 12).map((account) => (
              <div key={account.address} className="flex items-center justify-between px-1">
                <span className="font-mono text-[10.5px] text-muted">
                  {shortAddress(account.address, 5)}
                </span>
                <span className="tnum text-[11.5px] text-ink">
                  +{formatTxAmount(account.lamports, 9)} SOL
                </span>
              </div>
            ))}
            {accounts.length > 12 && (
              <div className="px-1 text-[11px] text-faint">외 {accounts.length - 12}개</div>
            )}
          </div>

          <p className="mt-5 text-[11px] leading-[1.7] text-faint">
            계정을 닫으면 묶여 있던 SOL rent가 이 지갑으로 돌아옵니다. 잔액이 생기거나 동결된
            계정은 목록에 없고, 서명 전 시뮬레이션에서 한 번 더 확인합니다.
          </p>

          {error && (
            <div className="mt-4 rounded-[14px] bg-dangerSoft px-3.5 py-2.5 text-[12px] leading-snug text-danger">
              {error}
            </div>
          )}
        </div>
      )}

      {step === 'closing' && (
        <div className="flex flex-col items-center py-12 text-center">
          <Spinner size={27} className="text-ink" />
          <div className="mt-4 text-[14px] font-semibold text-ink">계정을 닫는 중</div>
          <p className="mt-2 max-w-[280px] text-[12px] leading-relaxed text-muted">
            시뮬레이션으로 회수 금액을 확인한 뒤 서명합니다.
          </p>
        </div>
      )}

      {step === 'done' && result && (
        <div className="flex h-full flex-col items-center justify-center pb-6">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-mintSoft text-mint">
            <Check size={28} strokeWidth={2.6} />
          </div>
          <div className="mt-5 text-[19px] font-bold tracking-[-0.03em] text-ink">
            {result.closed}개 정리 완료
          </div>
          <div className={cx('tnum mt-2 text-[15px] font-semibold text-ink')}>
            +{formatTxAmount(result.reclaimedLamports, 9)} SOL
          </div>
          <a
            href={explorerTx(result.signature, network)}
            target="_blank"
            rel="noreferrer"
            className="mt-6 rounded-full bg-surface px-3.5 py-2 text-[12px] font-medium text-ink"
          >
            Solscan에서 보기
          </a>
        </div>
      )}
    </Sheet>
  )
}
