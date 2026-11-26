import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Connection, Keypair } from '@solana/web3.js'
import { Bookmark, Check, ChevronDown, ClipboardPaste, ExternalLink, QrCode, X } from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { Button } from '../components/Button'
import { Spinner } from '../components/Spinner'
import { SuccessMark } from '../components/SuccessMark'
import { QrScanner } from '../components/QrScanner'
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
import { useWallet } from '../state/WalletProvider'
import { MEMO_PROGRAM_ID, parseRecipientInput, sanitizeMemo } from '../lib/solanaPay'
import { describeRecipient, remainingSolAfterSend, remainingSolWarning } from '../lib/sendSafety'
import {
  BASE_FEE_LAMPORTS,
  TX_TIMEOUTS,
  assessSend,
  estimateFee,
  inspectTransaction,
  prepareSolSend,
  prepareSplSend,
  signPreparedSend,
  type FeeEstimate,
  type PreparedSend,
  type TransactionResolution,
  TxOutcomeError,
} from '../lib/tx'
import type { TransactionPreview } from '../lib/transactionPreview'
import { explorerTx, networkDisplayName, type NetworkId } from '../lib/rpc'
import {
  clearPendingTransaction,
  readPendingTransaction,
  savePendingTransaction,
  withPendingTransactionLock,
  type PendingTransaction,
} from '../lib/pendingTx'
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

type Step = 'form' | 'preparing' | 'confirm' | 'sending' | 'tracking' | 'done'

/** Sum of the transaction layer's own deadlines plus a small margin. */
const SUBMIT_DEADLINE_MS =
  TX_TIMEOUTS.stepMs + TX_TIMEOUTS.confirmMs + TX_TIMEOUTS.statusMs * 3

function signedAmount(raw: string, decimals: number): string {
  const amount = BigInt(raw)
  const abs = amount < 0n ? -amount : amount
  return `${amount >= 0n ? '+' : '−'}${formatTxAmount(abs, decimals)}`
}

/** A QR amount carries up to 18 decimals; keep only what this asset can hold. */
function clampAmount(value: string, decimals: number): string {
  const [intPart, fracPart = ''] = value.split('.')
  const frac = fracPart.slice(0, decimals).replace(/0+$/, '')
  return frac ? `${intPart}.${frac}` : intPart
}

function programLabel(program: string): string {
  if (program === '11111111111111111111111111111111') return 'System Program'
  if (program === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') return 'SPL Token'
  if (program === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') return 'Token-2022'
  if (program === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL') return 'Associated Token Account'
  if (program === MEMO_PROGRAM_ID) return 'Memo'
  return '프로그램'
}

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
  const [memo, setMemo] = useState('')
  const [scanOpen, setScanOpen] = useState(false)
  const [fee, setFee] = useState<FeeEstimate | null>(null)
  const [preview, setPreview] = useState<TransactionPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signature, setSignature] = useState<string | null>(null)
  const [pendingTx, setPendingTx] = useState<PendingTransaction | null>(null)
  const [resolution, setResolution] = useState<TransactionResolution | null>(null)
  const [checking, setChecking] = useState(false)
  const [sendingSeconds, setSendingSeconds] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveLabel, setSaveLabel] = useState('')
  const inFlightRef = useRef(false)
  const preparedRef = useRef<PreparedSend | null>(null)
  const preparedNetworkRef = useRef<NetworkId | null>(null)
  const preparedConnectionRef = useRef<Connection | null>(null)
  const signedRef = useRef(false)
  const statusCheckRef = useRef(false)
  const reportedSignatureRef = useRef<string | null>(null)

  const book = useAddressBook()
  const { accounts, requestAuth, endAuthSession } = useWallet()
  const owner = keypair?.publicKey.toBase58() ?? ''
  // The key that a PIN check supplied for this send. It is released as soon as
  // the send reaches a result or the sheet closes.
  const signerRef = useRef<Keypair | null>(null)

  useEffect(() => {
    if (!open) return
    setMint(initialMint ?? 'SOL')
    setRecipient('')
    setAmount('')
    setMemo('')
    setScanOpen(false)
    setFee(null)
    setPreview(null)
    preparedRef.current = null
    preparedNetworkRef.current = null
    preparedConnectionRef.current = null
    setError(null)
    setSignature(null)
    setPendingTx(null)
    setResolution(null)
    setPickerOpen(false)
    setSaveOpen(false)
    setSaveLabel('')
    if (!owner) {
      setStep('form')
      return
    }
    try {
      const saved = readPendingTransaction(owner, network)
      if (saved) {
        setPendingTx(saved)
        setSignature(saved.signature)
        setResolution('pending')
        setStep('tracking')
      } else {
        setStep('form')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '저장된 전송 상태를 확인할 수 없습니다.')
      setStep('tracking')
    }
  }, [open, initialMint, owner, network])
  const assets: Asset[] = useMemo(() => buildAssets(portfolio), [portfolio])

  const discardPrepared = () => {
    preparedRef.current = null
    preparedNetworkRef.current = null
    preparedConnectionRef.current = null
    setPreview(null)
  }

  // Leaving the send screen always drops a key that the PIN check supplied.
  useEffect(() => {
    if (open) return
    signerRef.current = null
    endAuthSession()
  }, [open, endAuthSession])

  // A finished send needs no key any more.
  useEffect(() => {
    if (step !== 'done') return
    signerRef.current = null
    endAuthSession()
  }, [step, endAuthSession])

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

  const normalizedMemo = sanitizeMemo(memo) || null
  // Who this address is, in one word: an own account, a saved recipient, or a
  // caution chip for somewhere this device has never sent to.
  const recipientBadge = recipientValid
    ? describeRecipient(recipient, { owner, accounts, book })
    : null
  const remainingSol = remainingSolAfterSend({
    kind: asset?.isSol ? 'sol' : 'spl',
    amount: baseUnits,
    solBalance,
    feeLamports: feeLamportsForCheck,
    rentLamports: rentLamportsForCheck,
  })
  const remainingWarning = amountValid ? remainingSolWarning(remainingSol) : null

  const applyRecipientInput = (raw: string) => {
    const parsed = parseRecipientInput(raw)
    if (!parsed.ok) {
      showToast(
        parsed.reason === 'invalid-amount'
          ? 'QR의 송금 금액 형식이 올바르지 않습니다'
          : parsed.reason === 'invalid-token'
            ? 'QR의 토큰 주소가 올바르지 않습니다'
            : 'Solana 주소나 송금 QR이 아닙니다',
      )
      return
    }
    setError(null)
    setRecipient(parsed.address)
    setFee(null)
    if (parsed.memo) setMemo(parsed.memo)
    let decimals = asset?.decimals ?? 9
    if (parsed.splToken) {
      const target = assets.find((item) => item.mint === parsed.splToken)
      if (target) {
        setMint(target.key)
        decimals = target.decimals
      } else {
        showToast('이 지갑에 없는 토큰 요청입니다')
      }
    }
    if (parsed.amount) setAmount(clampAmount(parsed.amount, decimals))
  }

  const checkPending = useCallback(async (record?: PendingTransaction) => {
    const target = record ?? pendingTx
    if (!target) return
    if (!connection || target.network !== network) {
      setResolution('unknown')
      return
    }
    if (statusCheckRef.current) return
    statusCheckRef.current = true
    setChecking(true)
    try {
      const result = await inspectTransaction(
        connection,
        target.signature,
        target.lastValidBlockHeight,
      )
      setResolution(result)
      if (result === 'confirmed' || result === 'failed') {
        try {
          clearPendingTransaction(target.owner, target.network, target.signature)
          setPendingTx(null)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : '확인된 전송 기록을 정리하지 못했습니다.')
        }
        if (result === 'confirmed') {
          setSignature(target.signature)
          setStep('tracking')
          if (reportedSignatureRef.current !== target.signature) {
            reportedSignatureRef.current = target.signature
            try {
              onSent()
            } catch {
              // A balance refresh cannot change the confirmed transaction result.
            }
          }
        }
      }
    } finally {
      statusCheckRef.current = false
      setChecking(false)
    }
  }, [connection, network, onSent, pendingTx])

  // The "sending" screen must visibly move: an elapsed counter proves the app
  // is alive while an RPC is slow, instead of looking like a frozen spinner.
  useEffect(() => {
    if (step !== 'sending') {
      setSendingSeconds(0)
      return
    }
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setSendingSeconds(Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
    }, 500)
    return () => window.clearInterval(timer)
  }, [step])

  useEffect(() => {
    if (!open || step !== 'tracking' || !pendingTx || !connection) return
    let active = true
    const check = () => {
      if (active) void checkPending(pendingTx)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    void checkPending(pendingTx)
    const timer = window.setInterval(check, 8_000)
    window.addEventListener('online', check)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('online', check)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [open, step, pendingTx, connection, checkPending])

  // A token send needs its real fee + rent before the button can be trusted:
  // whether the recipient already has a token account decides the
  // ~0.00204 SOL rent, and that is read from chain as soon as the address is valid.
  useEffect(() => {
    if (!open || !connection || !keypair || !asset || asset.isSol || !recipientValid) return
    let cancelled = false
    setFee(null)
    const timer = window.setTimeout(() => {
      void estimateFee(connection, 'spl', keypair.publicKey, asset.mint, recipient)
        .then((estimate) => {
          if (!cancelled) setFee(estimate)
        })
        .catch((cause) => {
          if (!cancelled) {
            setError(
              cause instanceof Error
                ? cause.message
                : '토큰 계정 및 수수료를 확인하지 못했습니다. 네트워크를 확인하세요.',
            )
          }
        })
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
      if (text) applyRecipientInput(text)
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
    if (!connection || !asset) return
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
    setError(null)
    discardPrepared()
    // With auto-login on this sheet opened without a key: sending is the action
    // that asks for the PIN, and only then is the vault decrypted.
    const signer = keypair ?? (await requestAuth('send'))
    if (!signer) return
    signerRef.current = signer
    setStep('preparing')
    try {
      const estimate = await estimateFee(
        connection,
        asset.isSol ? 'sol' : 'spl',
        signer.publicKey,
        asset.isSol ? null : asset.mint,
        recipient,
      )
      setFee(estimate)
      const latestAffordability = assessSend({
        kind: asset.isSol ? 'sol' : 'spl',
        amount: baseUnits,
        balance: asset.amount,
        solBalance,
        feeLamports: estimate.feeLamports,
        rentLamports: estimate.rentLamports,
      })
      if (!latestAffordability.ok) {
        setError(
          latestAffordability.reason === 'insufficient-fee'
            ? '수수료와 계정 생성 비용을 포함할 SOL 잔액이 부족합니다.'
            : '잔액이 부족합니다.',
        )
        setStep('form')
        return
      }
      const prepared = asset.isSol
        ? await prepareSolSend(connection, signer, recipient.trim(), baseUnits, normalizedMemo)
        : await prepareSplSend(
            connection,
            signer,
            asset.mint,
            recipient.trim(),
            baseUnits,
            asset.decimals,
            normalizedMemo,
          )
      const exactFee = BigInt(prepared.preview.feeLamports)
      const exactAffordability = assessSend({
        kind: asset.isSol ? 'sol' : 'spl',
        amount: baseUnits,
        balance: asset.amount,
        solBalance,
        feeLamports: exactFee,
        rentLamports: prepared.rentLamports,
      })
      if (!exactAffordability.ok) {
        throw new Error(
          exactAffordability.reason === 'insufficient-fee'
            ? '시뮬레이션 수수료와 계정 생성 비용을 포함할 SOL 잔액이 부족합니다.'
            : '시뮬레이션 결과 잔액이 부족해 서명하지 않았습니다.',
        )
      }
      preparedRef.current = prepared
      preparedNetworkRef.current = network
      preparedConnectionRef.current = connection
      setPreview(prepared.preview)
      setFee({
        feeLamports: exactFee,
        rentLamports: prepared.rentLamports,
        totalLamports: exactFee + prepared.rentLamports,
        createsAta: prepared.createsAta,
      })
      setStep('confirm')
    } catch (cause) {
      discardPrepared()
      setError(
        cause instanceof Error
          ? cause.message
          : '시뮬레이션 미리보기를 만들지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.',
      )
      setStep('form')
    }
  }

  const submit = async () => {
    const signer = keypair ?? signerRef.current
    if (!connection || !signer || !asset) return
    if (inFlightRef.current) return
    const prepared = preparedRef.current
    const activeOwner = signer.publicKey.toBase58()
    if (
      !prepared ||
      !preview ||
      prepared.owner !== activeOwner ||
      preparedNetworkRef.current !== network ||
      preparedConnectionRef.current !== connection ||
      prepared.recipient !== recipient.trim() ||
      prepared.amount !== baseUnits ||
      prepared.memo !== normalizedMemo ||
      prepared.kind !== (asset.isSol ? 'sol' : 'spl') ||
      prepared.mint !== (asset.isSol ? null : asset.mint)
    ) {
      discardPrepared()
      setError('미리보기와 현재 전송 내용이 달라졌습니다. 다시 시뮬레이션해 주세요.')
      setStep('form')
      return
    }
    inFlightRef.current = true
    setStep('sending')
    setError(null)
    try {
      const lockResult = await withPendingTransactionLock(activeOwner, network, async () => {
        signedRef.current = false
        let persistedSignature: string | undefined
        const hooks = {
          onSigned: (attempt: { signature: string; blockhash: string; lastValidBlockHeight: number }) => {
            const record: PendingTransaction = {
              version: 1,
              network,
              owner: activeOwner,
              signature: attempt.signature,
              blockhash: attempt.blockhash,
              lastValidBlockHeight: attempt.lastValidBlockHeight,
              createdAt: Date.now(),
              symbol: ticker,
              amount: baseUnits.toString(),
            }
            // Persist synchronously before any bytes are sent to an RPC.
            savePendingTransaction(record)
            persistedSignature = record.signature
            signedRef.current = true
            setPendingTx(record)
            setSignature(record.signature)
            setResolution('pending')
            setStep('tracking')
          },
          // The RPC accepted the bytes: stop the "sending" spinner now and let
          // the tracking screen own the confirmation wait.
          onSubmitted: () => {
            setResolution('pending')
            setStep('tracking')
          },
          onTerminal: () => clearPendingTransaction(activeOwner, network, persistedSignature),
        }
        // Backstop above the sum of every inner deadline (12s + 30s + reads):
        // even a browser API that never settles ends here with a signature.
        let deadlineTimer: number | undefined
        const overallDeadline = new Promise<never>((_, reject) => {
          deadlineTimer = window.setTimeout(() => {
            reject(
              new TxOutcomeError(
                'unknown',
                persistedSignature ?? '',
                '네트워크 응답이 예상보다 오래 걸립니다. 같은 송금을 다시 보내지 말고 이 화면에서 서명 상태를 확인하세요.',
              ),
            )
          }, SUBMIT_DEADLINE_MS)
        })
        try {
          let sig: string
          sig = await Promise.race([
            signPreparedSend(connection, prepared, signer, hooks),
            overallDeadline,
          ])
          setSignature(sig)
          setResolution('confirmed')
          setPendingTx(null)
          setStep('done')
          try {
            onSent()
          } catch {
            // Refreshing balances must never turn a confirmed transaction into a retry prompt.
          }
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause ?? '')
          if (cause instanceof TxOutcomeError && !signedRef.current) {
            // Nothing was ever broadcast, so there is no signature to track.
            discardPrepared()
            setError(message || '전송이 시작되지 않았습니다. 잠시 후 다시 시도하세요.')
            setStep('form')
          } else if (cause instanceof TxOutcomeError) {
            setSignature(cause.signature)
            setResolution(cause.outcome)
            try {
              setPendingTx(readPendingTransaction(activeOwner, network))
            } catch (storageError) {
              setError(storageError instanceof Error ? storageError.message : message)
            }
            setError(message)
            setStep('tracking')
          } else if (signedRef.current) {
            setResolution('unknown')
            try {
              setPendingTx(readPendingTransaction(activeOwner, network))
            } catch (storageError) {
              setError(storageError instanceof Error ? storageError.message : message)
            }
            setError(message || '서명 이후 오류가 발생했습니다. 같은 전송을 다시 시도하지 마세요.')
            setStep('tracking')
          } else {
            discardPrepared()
            setError(
              message.includes('insufficient')
                ? '잔액이 부족합니다. 수수료를 포함해 다시 확인하세요.'
                : message || '서명 또는 RPC 준비 단계에서 실패했습니다. 전송이 시작되지 않았습니다.',
            )
            setStep('form')
          }
        }
      })
      if (lockResult.kind === 'pending') {
        setPendingTx(lockResult.record)
        setSignature(lockResult.record.signature)
        setResolution('pending')
        setStep('tracking')
        void checkPending(lockResult.record)
      } else if (lockResult.kind === 'busy') {
        setError('다른 탭에서 전송 또는 스왑을 진행 중입니다. 완료 여부를 확인한 뒤 다시 시도하세요.')
        setStep('confirm')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '전송을 위한 안전 잠금을 확인하지 못했습니다.')
      setStep('confirm')
    } finally {
      inFlightRef.current = false
    }
  }

  const handleClose = () => {
    if (inFlightRef.current && !signedRef.current) {
      showToast('안전한 상태 기록을 마칠 때까지 잠시 기다려 주세요.')
      return
    }
    discardPrepared()
    signerRef.current = null
    endAuthSession()
    onClose()
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
          시뮬레이션 내용대로 서명·전송
        </Button>
        <Button full variant="secondary" onClick={() => { discardPrepared(); setStep('form') }}>
          이전
        </Button>
      </div>
    ) : step === 'done' ? (
      <Button full onClick={handleClose}>
        닫기
      </Button>
    ) : step === 'tracking' ? (
      <div className="space-y-2">
        <Button full onClick={() => void checkPending()} disabled={checking || !pendingTx || !connection}>
          {checking ? '서명 상태 확인 중…' : '서명 상태 다시 확인'}
        </Button>
        <Button full variant="secondary" onClick={handleClose}>
          닫기
        </Button>
      </div>
    ) : undefined

  return (
    <>
      <Sheet
        open={open}
        onClose={handleClose}
        title={step === 'done' ? undefined : step === 'tracking' ? '전송 상태' : step === 'confirm' ? '전송 확인' : step === 'preparing' ? '시뮬레이션 확인' : '보내기'}
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
                    setFee(null)
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
            <div className="mt-2 flex items-stretch gap-2">
              <input
                value={recipient}
                onChange={(event) => {
                  const next = event.target.value
                  if (/^solana:/i.test(next.trim())) {
                    applyRecipientInput(next)
                    return
                  }
                  setRecipient(next.trim())
                  setFee(null)
                  setError(null)
                }}
                placeholder="Solana 주소"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                id="recipient-input"
                className={cx(
                  'min-w-0 flex-1 rounded-[14px] bg-surface px-3.5 py-3.5 font-mono text-[11.5px] text-ink outline-none placeholder:font-sans placeholder:text-faint',
                  recipient && !recipientValid && 'text-danger',
                )}
              />
              <button
                onClick={() => setScanOpen(true)}
                aria-label="QR 스캔"
                className="press flex w-[46px] shrink-0 items-center justify-center rounded-[14px] bg-surface text-ink active:bg-press"
              >
                <QrCode size={17} strokeWidth={1.9} />
              </button>
            </div>
            {recipient && !recipientValid && (
              <div className="mt-1.5 px-1 text-[11.5px] text-danger">주소 형식을 확인하세요.</div>
            )}

            {(recipientBadge || memo) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1">
                {recipientBadge && (
                  <span
                    data-recipient-badge={recipientBadge.kind}
                    className={cx(
                      'rounded-full px-2 py-[3px] text-[10.5px] font-semibold',
                      recipientBadge.caution
                        ? 'bg-warn/10 text-warn'
                        : 'bg-surface text-ink',
                    )}
                  >
                    {recipientBadge.label}
                  </span>
                )}
                {memo && (
                  <span
                    data-memo-chip="true"
                    className="flex max-w-full items-center gap-1 rounded-full bg-surface py-[3px] pl-2 pr-1 text-[10.5px] font-medium text-muted"
                  >
                    <span className="truncate">메모 · {normalizedMemo ?? memo}</span>
                    <button
                      onClick={() => setMemo('')}
                      aria-label="메모 지우기"
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-faint active:opacity-60"
                    >
                      <X size={9} strokeWidth={2.4} />
                    </button>
                  </span>
                )}
              </div>
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
            {amountValid && (
              <div className="mt-1.5 flex items-center justify-between px-1 text-[11.5px]">
                <span className="text-muted">보낸 뒤 잔액</span>
                <span className="tnum font-medium text-ink" data-remaining-sol="true">
                  {formatTxAmount(remainingSol, 9)} SOL
                </span>
              </div>
            )}
            {remainingWarning && (
              <div className="mt-1 px-1 text-[11px] leading-snug text-warn">{remainingWarning}</div>
            )}
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

      {step === 'preparing' && (
        <div className="flex flex-col items-center py-12 text-center">
          <Spinner size={27} className="text-ink" />
          <div className="mt-4 text-[14px] font-semibold text-ink">서명 전 시뮬레이션 중</div>
          <p className="mt-2 max-w-[280px] text-[12px] leading-relaxed text-muted">
            수신 계정, 지갑 잔액 변화, 수수료와 호출 프로그램을 확인합니다. 검증에 실패하면 서명하지 않습니다.
          </p>
        </div>
      )}

      {step === 'confirm' && asset && preview && (
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
            <div className="space-y-1">
              <span className="text-[12.5px] text-muted">받는 주소</span>
              <div className="break-all font-mono text-[10.5px] leading-relaxed text-ink">{recipient}</div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] text-muted">네트워크</span>
              <span className="text-[12.5px] text-ink">
                {networkDisplayName(network)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] text-muted">네트워크 수수료</span>
              <span className="text-[12.5px] tnum text-ink">
                {formatTxAmount(BigInt(preview.feeLamports), 9)} SOL
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
            {preview && normalizedMemo && (
              <div className="flex items-start justify-between gap-4">
                <span className="shrink-0 text-[12.5px] text-muted">메모</span>
                <span className="break-all text-right text-[12.5px] text-ink" data-confirm-memo="true">
                  {normalizedMemo}
                </span>
              </div>
            )}
          </div>

          <section className="mt-5 rounded-[16px] bg-surface p-3.5">
            <div className="text-[12px] font-semibold text-ink">시뮬레이션 잔액 변화</div>
            <div className="mt-3 space-y-2.5">
              {preview.nativeChanges.map((change) => (
                <div key={`sol-${change.address}`} className="flex items-start justify-between gap-3 text-[11.5px]">
                  <span className="text-muted">{change.address === owner ? '내 SOL' : '받는 주소 SOL'}</span>
                  <span className="tnum text-right font-medium text-ink">
                    {signedAmount(change.deltaLamports, 9)} SOL
                    <span className="block text-[10px] font-normal text-faint">
                      {formatTxAmount(BigInt(change.beforeLamports), 9)} → {formatTxAmount(BigInt(change.afterLamports), 9)}
                    </span>
                  </span>
                </div>
              ))}
              {preview.tokenChanges.map((change) => (
                <div key={`token-${change.owner}-${change.mint}`} className="flex items-start justify-between gap-3 text-[11.5px]">
                  <span className="text-muted">{change.owner === owner ? '내 토큰' : '받는 주소 토큰'}</span>
                  <span className="tnum text-right font-medium text-ink">
                    {signedAmount(change.deltaAmount, change.decimals)} {ticker}
                    <span className="block text-[10px] font-normal text-faint">
                      {formatTxAmount(BigInt(change.beforeAmount), change.decimals)} → {formatTxAmount(BigInt(change.afterAmount), change.decimals)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3 border-t border-line pt-2.5">
              <div className="text-[11px] font-semibold text-ink">호출 프로그램</div>
              <div className="mt-1.5 space-y-1.5">
                {preview.invokedPrograms.map((program) => (
                  <div key={program} className="break-all text-[9.5px] leading-relaxed text-muted">
                    <span className="font-medium text-ink">{programLabel(program)}</span> · {program}
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-2 text-[9.5px] leading-relaxed text-faint">
              슬롯 {preview.slot}에서 얻은 미리보기입니다. 네트워크 상태는 서명 전후 달라질 수 있습니다.
            </p>
          </section>

          <div className="mt-4 h-px bg-line" />

          <div className="mt-4 flex items-center justify-between">
            <span className="text-[13px] text-muted">
              {asset.isSol ? '총 차감' : '차감 (수수료 포함)'}
            </span>
            <span className="tnum text-[14px] font-semibold text-ink">
              {asset.isSol
                ? `${formatTxAmount(baseUnits + feeLamports + rentLamports, 9)} SOL`
                : `${formatTxAmount(baseUnits, asset.decimals)} ${ticker} + ${formatTxAmount(feeLamports + rentLamports, 9)} SOL`}
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
          <div className="mt-1.5 text-center text-[12.5px] leading-relaxed text-muted">
            서명을 저장한 뒤 네트워크로 보내고 있습니다.
            <br />
            응답이 늦으면 서명 상태 확인 화면으로 넘어갑니다.
          </div>
          <div className="tnum mt-3 text-[12px] text-faint">{sendingSeconds}초</div>
        </div>
      )}

      {step === 'tracking' && (
        <div className="flex flex-col items-center pb-6 pt-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface text-ink">
            {checking ? <Spinner size={23} /> : <ExternalLink size={22} />}
          </div>
          <div className="mt-4 text-[18px] font-bold tracking-[-0.03em] text-ink">
            {resolution === 'confirmed'
              ? '전송 성공 확인'
              : resolution === 'pending'
              ? '네트워크 확인 중'
              : resolution === 'failed'
                ? '전송 실패 확인'
                : resolution === 'expired'
                  ? '블록해시 만료 · 결과 미확정'
                  : '전송 결과 불명확'}
          </div>
          <div className="mt-2 max-w-[290px] text-[12.5px] leading-relaxed text-muted">
            {resolution === 'confirmed'
              ? '네트워크에서 이 서명의 성공을 확인했습니다.'
              : resolution === 'failed'
                ? '네트워크가 이 서명의 실패를 확인했습니다. 새 전송을 하려면 닫은 뒤 직접 다시 시작하세요.'
                : resolution === 'expired'
                  ? '블록해시 유효기간은 지났지만 이 서명이 처리됐는지는 확인되지 않았습니다. 중복 송금 방지를 위해 새 전송은 차단됩니다.'
                  : resolution === 'pending'
                    ? '이 서명의 확정을 기다리는 중입니다. 같은 송금을 다시 보내지 마세요.'
                    : '이 서명의 상태를 확인할 수 없습니다. 같은 송금을 다시 보내지 말고 네트워크 복구 후 다시 조회하세요.'}
          </div>
          {pendingTx?.symbol && (
            <div className="tnum mt-3 text-[12.5px] font-semibold text-ink">{pendingTx.symbol}</div>
          )}
          {signature && (
            <>
              <a
                href={explorerTx(signature, network)}
                target="_blank"
                rel="noreferrer"
                className="mt-5 flex items-center gap-1.5 rounded-full bg-surface px-3.5 py-2 text-[12px] font-medium text-ink"
              >
                Solscan에서 확인 <ExternalLink size={12} />
              </a>
              <div className="mt-2 font-mono text-[10.5px] text-faint">{shortAddress(signature, 8)}</div>
            </>
          )}
          {error && (
            <div className="mt-4 w-full rounded-[14px] bg-dangerSoft px-3.5 py-2.5 text-left text-[12px] leading-snug text-danger">
              {error}
            </div>
          )}
        </div>
      )}

      {step === 'done' && signature && (
        <div className="flex h-full flex-col items-center justify-center pb-6">
          <SuccessMark />
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
      <QrScanner
        open={scanOpen && open}
        onClose={() => setScanOpen(false)}
        onPayload={(text) => {
          setScanOpen(false)
          applyRecipientInput(text)
        }}
      />
    </>
  )
}
