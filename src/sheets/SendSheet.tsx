import { useEffect, useMemo, useState } from 'react'
import type { Connection, Keypair } from '@solana/web3.js'
import { Bookmark, Check, ChevronDown, ClipboardPaste, ExternalLink, X } from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { Button } from '../components/Button'
import { Spinner } from '../components/Spinner'
import { TokenIcon } from '../components/ui'
import {
  cx,
  formatAmount,
  formatPrice,
  formatTxAmount,
  formatUsd,
  fromBaseUnits,
  shortAddress,
  toBaseUnits,
} from '../lib/format'
import { buildAssets, type Asset } from '../lib/assets'
import type { Portfolio } from '../lib/tokens'
import { isValidAddress } from '../lib/wallet'
import { useAddressBook, removeEntry, saveEntry } from '../lib/addressBook'
import {
  BASE_FEE_LAMPORTS,
  assessSend,
  estimateFee,
  sendSol,
  sendSplToken,
  type FeeEstimate,
} from '../lib/tx'
import { explorerTx, type NetworkId } from '../lib/rpc'
import { showToast } from '../components/Toast'

interface SendSheetProps {
  open: boolean
  onClose: () => void
  portfolio: Portfolio | null
  connection: Connection | null
  keypair: Keypair | null
  network: NetworkId
  initialMint: string | null
  onSent: () => void
}

type Step = 'form' | 'confirm' | 'sending' | 'done'

export function SendSheet({
  open,
  onClose,
  portfolio,
  connection,
  keypair,
  network,
  initialMint,
  onSent,
}: SendSheetProps) {
  const [step, setStep] = useState<Step>('form')
  const [mint, setMint] = useState<string>('SOL')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [fee, setFee] = useState<FeeEstimate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signature, setSignature] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveLabel, setSaveLabel] = useState('')

  const book = useAddressBook()

  useEffect(() => {
    if (!open) return
    setStep('form')
    setMint(initialMint ?? 'SOL')
    setRecipient('')
    setAmount('')
    setFee(null)
    setError(null)
    setSignature(null)
    setPickerOpen(false)
    setSaveOpen(false)
    setSaveLabel('')
  }, [open, initialMint])
  const assets: Asset[] = useMemo(() => buildAssets(portfolio), [portfolio])

  const asset = assets.find((item) => item.key === mint) ?? assets[0]
  const baseUnits = asset ? toBaseUnits(amount, asset.decimals) : 0n
  const uiAmount = asset ? Number(fromBaseUnits(baseUnits, asset.decimals)) : 0
  const usdValue = asset && asset.priceUsd !== null ? uiAmount * asset.priceUsd : null
  const balanceUi = asset
    ? asset.isSol
      ? formatAmount(asset.amount, 9, 6)
      : formatAmount(asset.amount, asset.decimals, 6)
    : '0'
  // Fee and rent known so far. The token-account rent is fetched below once
  // the recipient address is valid; until then only the base fee is assumed.
  const feeLamportsForCheck = fee?.feeLamports ?? BASE_FEE_LAMPORTS
  const rentLamportsForCheck = fee?.rentLamports ?? 0n
  const solBalance = portfolio?.solLamports ?? 0n
  const affordability = assessSend({
    kind: asset?.isSol ? 'sol' : 'spl',
    amount: baseUnits,
    balance: asset?.amount ?? 0n,
    solBalance,
    feeLamports: feeLamportsForCheck,
    rentLamports: rentLamportsForCheck,
  })
  const insufficient = !affordability.ok && affordability.reason !== 'amount'
  const recipientValid = isValidAddress(recipient)
  const amountValid = baseUnits > 0n && !insufficient
  const canContinue = recipientValid && amountValid

  // A token send needs its real fee + rent before the button can be trusted:
  // whether the recipient already has a token account decides the
  // ~0.00204 SOL rent, and that is read from chain as soon as the address is valid.
  useEffect(() => {
    if (!open || !connection || !keypair || !asset || asset.isSol || !recipientValid) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void estimateFee(connection, 'spl', keypair.publicKey, asset.mint, recipient)
        .then((estimate) => {
          if (!cancelled) setFee(estimate)
        })
        .catch(() => undefined)
    }, 260)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, connection, keypair, asset, recipientValid, recipient])

  const setMax = () => {
    if (!asset) return
    if (asset.isSol) {
      const maxValue = asset.amount > BASE_FEE_LAMPORTS ? asset.amount - BASE_FEE_LAMPORTS : 0n
      setAmount(fromBaseUnits(maxValue, 9))
    } else {
      setAmount(fromBaseUnits(asset.amount, asset.decimals))
    }
    setError(null)
  }

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        setRecipient(text.trim())
        setError(null)
      }
    } catch {
      showToast('클립보드를 읽을 수 없습니다')
    }
  }

  const commitBookmark = () => {
    const entry = saveEntry(saveLabel, recipient)
    if (!entry) {
      showToast('이름과 주소를 확인하세요')
      return
    }
    setSaveOpen(false)
    setSaveLabel('')
    showToast(`주소록에 저장했습니다 · ${entry.label}`)
  }

  const goConfirm = async () => {
    if (!connection || !asset || !keypair) return
    if (!recipientValid) {
      setError('받는 주소가 올바르지 않습니다.')
      return
    }
    if (baseUnits <= 0n) {
      setError('보낼 수량을 입력하세요.')
      return
    }
    if (!affordability.ok) {
      setError(
        affordability.reason === 'insufficient-fee'
          ? '수수료로 쓸 SOL이 부족합니다. SOL을 조금 남겨 두세요.'
          : '잔액이 부족합니다.',
      )
      return
    }
    setStep('confirm')
    setError(null)
    try {
      const estimate = await estimateFee(
        connection,
        asset.isSol ? 'sol' : 'spl',
        keypair.publicKey,
        asset.isSol ? null : asset.mint,
        recipient,
      )
      setFee(estimate)
    } catch {
      setFee({
        feeLamports: BASE_FEE_LAMPORTS,
        rentLamports: 0n,
        totalLamports: BASE_FEE_LAMPORTS,
        createsAta: false,
      })
    }
  }

  const submit = async () => {
    if (!connection || !keypair || !asset) return
    setStep('sending')
    setError(null)
    try {
      let sig: string
      if (asset.isSol) {
        sig = await sendSol(connection, keypair, recipient.trim(), baseUnits)
      } else {
        sig = await sendSplToken(
          connection,
          keypair,
          asset.mint,
          recipient.trim(),
          baseUnits,
          asset.decimals,
        )
      }
      setSignature(sig)
      setStep('done')
      onSent()
    } catch (err: any) {
      const message = String(err?.message ?? '')
      setError(
        message.includes('insufficient')
          ? '잔액이 부족합니다. 수수료를 포함해 다시 확인하세요.'
          : message || '전송에 실패했습니다.',
      )
      setStep('confirm')
    }
  }

  const feeLamports = fee?.feeLamports ?? BASE_FEE_LAMPORTS
  const rentLamports = fee?.rentLamports ?? 0n
  const ticker = asset?.isSol ? 'SOL' : asset?.symbol ?? ''

  const footer =
    step === 'form' ? (
      <Button full disabled={!canContinue} onClick={goConfirm} id="send-next">
        다음
      </Button>
    ) : step === 'confirm' ? (
      <div className="space-y-2">
        <Button full onClick={submit} id="send-confirm">
          전송
        </Button>
        <Button full variant="secondary" onClick={() => setStep('form')}>
          이전
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
      onClose={onClose}
      title={step === 'done' ? undefined : step === 'confirm' ? '전송 확인' : '보내기'}
      footer={footer}
    >
      {step === 'form' && asset && (
        <div className="flex flex-col">
          {network === 'devnet' && (
            <div className="mb-4 rounded-[14px] bg-surface px-3.5 py-2.5 text-[11.5px] leading-snug text-muted">
              Devnet에서는 테스트용 SOL만 전송됩니다.
            </div>
          )}

          <button
            onClick={() => setPickerOpen((value) => !value)}
            className="flex w-full items-center gap-3 rounded-[18px] bg-surface px-3.5 py-3 text-left active:bg-press"
          >
            <TokenIcon symbol={asset.isSol ? 'SOL' : asset.symbol} icon={asset.icon} size={34} />
            <div className="flex-1">
              <div className="text-[14px] font-semibold tracking-[-0.02em] text-ink">
                {asset.isSol ? 'Solana' : asset.name}
              </div>
              <div className="mt-0.5 text-[11.5px] text-muted tnum">
                잔액 {balanceUi} {ticker}
              </div>
            </div>
            <ChevronDown
              size={16}
              className={cx('text-faint transition-transform', pickerOpen && 'rotate-180')}
            />
          </button>

          {pickerOpen && (
            <div className="no-scrollbar mt-2 max-h-[196px] overflow-y-auto rounded-[18px] bg-surface p-1.5">
              {assets.map((item) => (
                <button
                  key={item.key}
                  onClick={() => {
                    setMint(item.key)
                    setAmount('')
                    setPickerOpen(false)
                    setError(null)
                  }}
                  className="flex w-full items-center gap-2.5 rounded-[14px] px-2.5 py-2 text-left active:bg-card"
                >
                  <TokenIcon
                    symbol={item.isSol ? 'SOL' : item.symbol}
                    icon={item.icon}
                    size={28}
                  />
                  <span className="flex-1 text-[13px] font-medium text-ink">
                    {item.isSol ? 'SOL' : item.symbol}
                  </span>
                  <span className="text-[11.5px] text-muted tnum">
                    {formatAmount(item.amount, item.decimals, 4)}
                  </span>
                  {item.key === asset.key && <Check size={14} className="text-ink" />}
                </button>
              ))}
            </div>
          )}

          <div className="mt-6">
            <div className="flex items-center justify-between px-1">
              <span className="text-[12px] font-medium text-muted">받는 주소</span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    if (!recipientValid) {
                      showToast('주소를 먼저 입력하세요')
                      return
                    }
                    setSaveOpen((value) => !value)
                    setSaveLabel('')
                  }}
                  className="flex items-center gap-1 text-[11.5px] font-medium text-muted active:opacity-60"
                >
                  <Bookmark size={12} /> 주소록 저장
                </button>
                <button
                  onClick={paste}
                  className="flex items-center gap-1 text-[11.5px] font-medium text-ink active:opacity-60"
                >
                  <ClipboardPaste size={12} /> 붙여넣기
                </button>
              </div>
            </div>
            <input
              value={recipient}
              onChange={(event) => {
                setRecipient(event.target.value.trim())
                setError(null)
              }}
              placeholder="Solana 주소"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              id="recipient-input"
              className={cx(
                'mt-2 w-full rounded-[14px] bg-surface px-3.5 py-3.5 font-mono text-[11.5px] text-ink outline-none placeholder:font-sans placeholder:text-faint',
                recipient && !recipientValid && 'text-danger',
              )}
            />
            {recipient && !recipientValid && (
              <div className="mt-1.5 px-1 text-[11.5px] text-danger">주소 형식을 확인하세요.</div>
            )}

            {book.length > 0 && (
              <div className="no-scrollbar -mx-1 mt-2.5 flex gap-2 overflow-x-auto px-1 pb-1">
                {book.slice(0, 12).map((entry) => {
                  const selected = entry.address === recipient
                  return (
                    <button
                      key={entry.id}
                      onClick={() => {
                        setRecipient(entry.address)
                        setError(null)
                      }}
                      className={cx(
                        'shrink-0 rounded-full px-3 py-1.5 text-left transition-colors',
                        selected ? 'bg-ink text-onInk' : 'bg-surface text-ink active:bg-press',
                      )}
                    >
                      <span className="block max-w-[112px] truncate text-[11.5px] font-semibold">
                        {entry.label}
                      </span>
                      <span
                        className={cx(
                          'tnum block max-w-[112px] truncate text-[10px]',
                          selected ? 'text-onInk/70' : 'text-muted',
                        )}
                      >
                        {shortAddress(entry.address, 4)}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {saveOpen && (
              <div className="animate-pop mt-2.5 flex items-center gap-2 rounded-[14px] bg-surface p-1.5 pl-3">
                <input
                  value={saveLabel}
                  onChange={(event) => setSaveLabel(event.target.value.slice(0, 24))}
                  placeholder="이름 (예: 투빗 입금)"
                  className="min-w-0 flex-1 bg-transparent py-1.5 text-[12.5px] text-ink outline-none placeholder:text-faint"
                  autoFocus
                />
                <button
                  onClick={commitBookmark}
                  className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-[11.5px] font-semibold text-onInk"
                >
                  저장
                </button>
                <button
                  onClick={() => setSaveOpen(false)}
                  aria-label="취소"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted"
                >
                  <X size={13} />
                </button>
              </div>
            )}
          </div>

          <div className="mt-6">
            <div className="flex items-center justify-between px-1">
              <span className="text-[12px] font-medium text-muted">보낼 수량</span>
              <button
                onClick={setMax}
                className="rounded-full bg-surface px-2.5 py-1 text-[10.5px] font-semibold text-ink active:bg-press"
              >
                MAX
              </button>
            </div>
            <div className="mt-2 flex items-baseline gap-2 rounded-[14px] bg-surface px-3.5 py-3">
              <input
                value={amount}
                onChange={(event) => {
                  const next = event.target.value.replace(/,/g, '')
                  if (!/^[0-9]*\.?[0-9]*$/.test(next)) return
                  const [, frac = ''] = next.split('.')
                  if (frac.length > asset.decimals) return
                  setAmount(next)
                  setError(null)
                }}
                inputMode="decimal"
                placeholder="0"
                id="amount-input"
                className="tnum min-w-0 flex-1 bg-transparent text-[26px] font-bold tracking-[-0.03em] text-ink outline-none placeholder:text-faint2"
              />
              <span className="text-[14px] font-semibold text-muted">{ticker}</span>
            </div>
            <div className="mt-2 flex items-center justify-between px-1 text-[11.5px] text-muted">
              <span className="tnum">{usdValue !== null ? formatUsd(usdValue) : ''}</span>
              <button
                onClick={() => setAmount(balanceUi.replace(/,/g, ''))}
                className="tnum active:opacity-60"
              >
                잔액 {balanceUi}
              </button>
            </div>
          </div>

          <div className="mt-5 text-[11.5px] leading-relaxed text-faint">
            네트워크 수수료 {formatTxAmount(feeLamports, 9)} SOL
            {rentLamports > 0n
              ? ` · 토큰 계정 생성 ${formatTxAmount(rentLamports, 9)} SOL`
              : !asset.isSol
                ? ' · 받는 지갑에 토큰 계정이 없으면 약 0.002 SOL이 추가됩니다.'
                : ''}
          </div>

          {error && (
            <div className="mt-4 rounded-[14px] bg-dangerSoft px-3.5 py-2.5 text-[12px] leading-snug text-danger">
              {error}
            </div>
          )}
        </div>
      )}

      {step === 'confirm' && asset && (
        <div className="flex flex-col">
          <div className="flex flex-col items-center pt-3">
            <TokenIcon symbol={asset.isSol ? 'SOL' : asset.symbol} icon={asset.icon} size={52} />
            <div className="tnum mt-4 text-[27px] font-bold tracking-[-0.035em] text-ink">
              {formatTxAmount(baseUnits, asset.decimals)} {ticker}
            </div>
            <div className="mt-1.5 text-[12.5px] text-muted tnum">
              {usdValue !== null ? formatUsd(usdValue) : '—'}
              {asset.priceUsd !== null ? ` · ${formatPrice(asset.priceUsd)}` : ''}
            </div>
          </div>

          <div className="mt-7 space-y-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] text-muted">받는 주소</span>
              <span className="font-mono text-[12px] text-ink">{shortAddress(recipient, 6)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] text-muted">네트워크</span>
              <span className="text-[12.5px] text-ink">
                {network === 'mainnet' ? 'Solana Mainnet' : 'Solana Devnet'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] text-muted">네트워크 수수료</span>
              <span className="text-[12.5px] tnum text-ink">
                {formatTxAmount(feeLamports, 9)} SOL
              </span>
            </div>
            {rentLamports > 0n && (
              <div className="flex items-center justify-between">
                <span className="text-[12.5px] text-muted">토큰 계정 생성</span>
                <span className="text-[12.5px] tnum text-ink">
                  {formatTxAmount(rentLamports, 9)} SOL
                </span>
              </div>
            )}
          </div>

          <div className="mt-4 h-px bg-line" />

          <div className="mt-4 flex items-center justify-between">
            <span className="text-[13px] text-muted">
              {asset.isSol ? '총 차감' : '차감 (수수료 포함)'}
            </span>
            <span className="tnum text-[14px] font-semibold text-ink">
              {formatTxAmount(baseUnits + feeLamports + rentLamports, 9)} SOL
            </span>
          </div>

          {error && (
            <div className="mt-4 rounded-[14px] bg-dangerSoft px-3.5 py-2.5 text-[12px] leading-snug text-danger">
              {error}
            </div>
          )}
        </div>
      )}

      {step === 'sending' && (
        <div className="flex h-full flex-col items-center justify-center pb-16">
          <Spinner size={28} className="text-ink" />
          <div className="mt-4 text-[14.5px] font-semibold text-ink">전송 중</div>
          <div className="mt-1.5 text-[12.5px] text-muted">네트워크에 서명을 보내고 있습니다.</div>
        </div>
      )}

      {step === 'done' && signature && (
        <div className="flex h-full flex-col items-center justify-center pb-6">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-mintSoft text-mint">
            <Check size={28} strokeWidth={2.6} />
          </div>
          <div className="mt-5 text-[19px] font-bold tracking-[-0.03em] text-ink">전송 완료</div>
          <div className="tnum mt-2 text-[15px] font-semibold text-ink">
            {formatTxAmount(baseUnits, asset?.decimals ?? 9)} {ticker}
          </div>
          <div className="mt-1 text-[12px] text-muted tnum">
            수수료 {formatTxAmount(feeLamports, 9)} SOL
          </div>

          <a
            href={explorerTx(signature, network)}
            target="_blank"
            rel="noreferrer"
            className="mt-6 flex items-center gap-1.5 rounded-full bg-surface px-3.5 py-2 text-[12px] font-medium text-ink"
          >
            Solscan에서 보기 <ExternalLink size={12} />
          </a>
          <div className="mt-2 font-mono text-[10.5px] text-faint">
            {shortAddress(signature, 8)}
          </div>
        </div>
      )}
    </Sheet>
  )
}
