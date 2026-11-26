import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Connection, Keypair } from '@solana/web3.js'
import { ArrowDownUp, Check, ChevronDown, ExternalLink, Info, Loader2 } from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { Button } from '../components/Button'
import { SuccessMark } from '../components/SuccessMark'
import { AnimatedNumber } from '../components/AnimatedNumber'
import { TokenIcon } from '../components/ui'

import {
  cx,
  formatAmount,
  formatPrice,
  formatUsd,
  fromBaseUnits,
  toBaseUnits,
} from '../lib/format'
import { buildAssets, type Asset } from '../lib/assets'
import { KNOWN_TOKENS, type Portfolio } from '../lib/tokens'
import {
  USDC_MINT,
  USDT_MINT,
  fetchSwapQuote,
  fetchSwapTransaction,
  type SwapQuote,
} from '../lib/swap'
import { explorerTx, type NetworkId } from '../lib/rpc'
import { prepareSwap, signPreparedSwap, type PreparedSwapExecution } from '../lib/swapExecute'
import { PROGRAM_IDS, SwapGuardError } from '../lib/swapGuard'
import { inspectTransaction, TxOutcomeError, type TransactionResolution } from '../lib/tx'
import type { TransactionPreview } from '../lib/transactionPreview'
import {
  clearPendingTransaction,
  readPendingTransaction,
  savePendingTransaction,
  withPendingTransactionLock,
  type PendingTransaction,
} from '../lib/pendingTx'
import { useWallet } from '../state/WalletProvider'

interface SwapProps {
  portfolio: Portfolio | null
  connection: Connection | null
  keypair: Keypair | null
  network: NetworkId
  initialMint: string | null
  onDone: () => void
  onOpenReceive: () => void
}

const SLIPPAGE_OPTIONS = [
  { bps: 50, label: '0.5%' },
  { bps: 100, label: '1%' },
  { bps: 300, label: '3%' },
]

const SWAP_CANDIDATES = [USDC_MINT, USDT_MINT]

function signedAmount(raw: string, decimals: number): string {
  const amount = BigInt(raw)
  const abs = amount < 0n ? -amount : amount
  return `${amount >= 0n ? '+' : '−'}${formatAmount(abs, decimals, 6)}`
}

function programLabel(program: string): string {
  if (program === PROGRAM_IDS.jupiter) return 'Jupiter'
  if (program === PROGRAM_IDS.token) return 'SPL Token'
  if (program === PROGRAM_IDS.token2022) return 'Token-2022'
  if (program === PROGRAM_IDS.associatedToken) return 'Associated Token Account'
  if (program === PROGRAM_IDS.computeBudget) return 'Compute Budget'
  if (program === PROGRAM_IDS.system) return 'System Program'
  if (program === PROGRAM_IDS.memoV1) return 'Memo v1'
  if (program === PROGRAM_IDS.memoV2) return 'Memo v2'
  return '프로그램'
}

function pseudoAsset(mint: string): Asset | null {
  const known = KNOWN_TOKENS[mint]
  if (!known) return null
  return {
    key: mint,
    mint,
    symbol: known.symbol,
    name: known.name,
    decimals: known.decimals,
    amount: 0n,
    priceUsd: null,
    valueUsd: null,
  }
}

function swapUniverse(portfolio: Portfolio | null): Asset[] {
  const held = buildAssets(portfolio)
  const seen = new Set(held.map((asset) => asset.mint))
  const extras = SWAP_CANDIDATES.map(pseudoAsset).filter(
    (asset): asset is Asset => Boolean(asset) && !seen.has((asset as Asset).mint),
  )
  return [...held, ...extras]
}

export default function Swap({
  portfolio,
  connection,
  keypair,
  network,
  initialMint,
  onDone,
  onOpenReceive,
}: SwapProps) {
  const universe = useMemo(() => swapUniverse(portfolio), [portfolio])

  const [inputKey, setInputKey] = useState('SOL')
  const [outputKey, setOutputKey] = useState(USDC_MINT)
  const [amount, setAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(50)
  const [picker, setPicker] = useState<'in' | 'out' | null>(null)
  const [quote, setQuote] = useState<SwapQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [step, setStep] = useState<'form' | 'confirm' | 'sending' | 'tracking' | 'done'>('form')
  const [sending, setSending] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [preview, setPreview] = useState<TransactionPreview | null>(null)
  const [signature, setSignature] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [pendingTx, setPendingTx] = useState<PendingTransaction | null>(null)
  const [resolution, setResolution] = useState<TransactionResolution | null>(null)
  const [checking, setChecking] = useState(false)
  /** 방향을 바꾼 횟수 × 180° — 버튼이 제자리에서 한 바퀴씩 돈다. */
  const [flips, setFlips] = useState(0)
  /**
   * 견적은 입력이 멈출 때마다 새로 오고, 오는 동안에는 이전 값이 화면에 남는다.
   * 그 값이 있어야 새 견적이 0이 아닌 "방금 전 숫자"에서 굴러 올라간다.
   */
  const [lastOut, setLastOut] = useState<number | null>(null)
  const requestId = useRef(0)
  const previewGeneration = useRef(0)
  const inFlightRef = useRef(false)
  const preparedRef = useRef<PreparedSwapExecution | null>(null)
  const preparedNetworkRef = useRef<NetworkId | null>(null)
  const preparedConnectionRef = useRef<Connection | null>(null)
  const signedRef = useRef(false)
  const statusCheckRef = useRef(false)
  const reportedSignatureRef = useRef<string | null>(null)
  const owner = keypair?.publicKey.toBase58() ?? ''

  // A swap signs with a key that the PIN check released for this action only.
  const { requestAuth, endAuthSession } = useWallet()
  const signerRef = useRef<Keypair | null>(null)
  const endAuthRef = useRef(endAuthSession)
  endAuthRef.current = endAuthSession
  useEffect(() => () => endAuthRef.current(), [])

  useEffect(() => {
    if (step !== 'done') return
    signerRef.current = null
    endAuthRef.current()
  }, [step])

  useEffect(() => {
    if (step === 'form') signerRef.current = null
  }, [step])

  const discardPrepared = () => {
    previewGeneration.current += 1
    preparedRef.current = null
    preparedNetworkRef.current = null
    preparedConnectionRef.current = null
    setPreview(null)
  }

  const inputAsset = universe.find((asset) => asset.key === inputKey) ?? universe[0]
  const outputAsset =
    universe.find((asset) => asset.key === outputKey) ??
    universe.find((asset) => asset.mint !== inputAsset?.mint) ??
    universe[0]

  useEffect(() => {
    if (!initialMint) return
    const match = universe.find((asset) => asset.key === initialMint || asset.mint === initialMint)
    if (match) {
      setInputKey(match.key)
      const other = universe.find((asset) => asset.mint !== match.mint)
      if (other && other.mint === outputAsset?.mint) setOutputKey(other.key)
    }
    // Intentional: seed once per arrival from token detail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMint])

  useEffect(() => {
    if (!owner) return
    try {
      const saved = readPendingTransaction(owner, network)
      if (saved) {
        setPendingTx(saved)
        setSignature(saved.signature)
        setResolution('pending')
        setStep('tracking')
      }
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : '저장된 전송 상태를 확인할 수 없습니다.')
      setStep('tracking')
    }
  }, [owner, network])

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
          setSendError(cause instanceof Error ? cause.message : '확인된 전송 기록을 정리하지 못했습니다.')
        }
        if (result === 'confirmed') {
          setSignature(target.signature)
          setStep('tracking')
          if (reportedSignatureRef.current !== target.signature) {
            reportedSignatureRef.current = target.signature
            try {
              onDone()
            } catch {
              // Navigation or refresh errors cannot change a confirmed swap.
            }
          }
        }
      }
    } finally {
      statusCheckRef.current = false
      setChecking(false)
    }
  }, [connection, network, onDone, pendingTx])

  useEffect(() => {
    if (step !== 'tracking' || !pendingTx || !connection) return
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
  }, [step, pendingTx, connection, checkPending])

  const inDecimals = inputAsset?.decimals ?? 9
  const outDecimals = outputAsset?.decimals ?? 6
  const baseUnits = toBaseUnits(amount, inDecimals)
  const amountUi = Number(fromBaseUnits(baseUnits, inDecimals))
  const inputValueUsd =
    inputAsset?.priceUsd !== null && inputAsset?.priceUsd !== undefined
      ? amountUi * inputAsset.priceUsd
      : inputAsset?.isSol && portfolio?.solPriceUsd
        ? amountUi * portfolio.solPriceUsd
        : null
  const balanceUi = inputAsset ? Number(fromBaseUnits(inputAsset.amount, inputAsset.decimals)) : 0
  const insufficient = inputAsset
    ? inputAsset.isSol
      ? baseUnits + 10_000_000n > inputAsset.amount // keep ~0.01 SOL for fees + rent
      : baseUnits > inputAsset.amount
    : false
  const sameToken = inputAsset?.mint === outputAsset?.mint
  const outAmount = quote ? Number(fromBaseUnits(BigInt(quote.outAmount), outDecimals)) : null
  const minReceived = quote
    ? Number(fromBaseUnits(BigInt(quote.otherAmountThreshold), outDecimals))
    : null
  const rate =
    quote && amountUi > 0 ? Number(fromBaseUnits(BigInt(quote.outAmount), outDecimals)) / amountUi : null

  /* 마지막으로 받은 견적 수량을 들고 있는다: 새 견적이 오는 동안에도 화면에 남아
   * 있다가, 도착하면 그 값에서 새 값으로 굴러 올라간다. */
  useEffect(() => {
    if (quote) setLastOut(Number(quote.outAmount))
  }, [quote])

  useEffect(() => {
    if (baseUnits <= 0n) setLastOut(null)
  }, [baseUnits])

  const outText = (base: number | null) =>
    base === null ? '—' : formatAmount(BigInt(Math.round(base)), outDecimals, 6)
  const shownOut = baseUnits > 0n ? (quote ? Number(quote.outAmount) : lastOut) : null

  /* ------------------------------------------------------------- quoting */

  useEffect(() => {
    discardPrepared()
    setQuote(null)
    setQuoteError(null)
    if (!connection || network !== 'mainnet' || !inputAsset || !outputAsset) return
    if (sameToken || baseUnits <= 0n || insufficient) return

    const id = ++requestId.current
    const timer = window.setTimeout(async () => {
      setQuoting(true)
      try {
        const next = await fetchSwapQuote({
          inputMint: inputAsset.isSol ? 'So11111111111111111111111111111111111111112' : inputAsset.mint,
          outputMint: outputAsset.isSol ? 'So11111111111111111111111111111111111111112' : outputAsset.mint,
          amount: baseUnits.toString(),
          slippageBps,
        })
        if (id === requestId.current) {
          setQuote(next)
          setQuoteError(null)
        }
      } catch (error) {
        if (id === requestId.current) {
          setQuote(null)
          setQuoteError(
            error instanceof Error ? error.message : '스왑 견적을 받지 못했습니다.',
          )
        }
      } finally {
        if (id === requestId.current) setQuoting(false)
      }
    }, 420)

    return () => {
      window.clearTimeout(timer)
      requestId.current += 1
    }
  }, [connection, network, inputAsset, outputAsset, sameToken, baseUnits, insufficient, slippageBps])

  const flip = () => {
    setFlips((count) => count + 1)
    setInputKey(outputAsset?.key ?? 'SOL')
    setOutputKey(inputAsset?.key ?? 'SOL')
    setAmount('')
    setQuote(null)
  }

  const setMax = () => {
    if (!inputAsset) return
    if (inputAsset.isSol) {
      const max = inputAsset.amount > 10_000_000n ? inputAsset.amount - 10_000_000n : 0n
      setAmount(fromBaseUnits(max, 9))
    } else {
      setAmount(fromBaseUnits(inputAsset.amount, inputAsset.decimals))
    }
  }

  const preparePreview = useCallback(async () => {
    if (!connection || !quote || preparing || inFlightRef.current) return
    const signer = keypair ?? signerRef.current ?? (await requestAuth('swap'))
    if (!signer) return
    signerRef.current = signer
    const activeOwner = signer.publicKey.toBase58()
    const generation = ++previewGeneration.current
    inFlightRef.current = true
    setPreparing(true)
    setSendError(null)
    try {
      const built = await fetchSwapTransaction(quote, activeOwner)
      const prepared = await prepareSwap({ connection, keypair: signer, built, quote })
      if (generation !== previewGeneration.current) return
      preparedRef.current = prepared
      preparedNetworkRef.current = network
      preparedConnectionRef.current = connection
      setPreview(prepared.preview)
    } catch (error) {
      if (generation === previewGeneration.current) {
        discardPrepared()
        setSendError(error instanceof Error ? error.message : '스왑 시뮬레이션 미리보기를 만들지 못했습니다.')
      }
    } finally {
      setPreparing(false)
      inFlightRef.current = false
    }
  }, [connection, keypair, quote, preparing, network, requestAuth])

  const execute = useCallback(async () => {
    if (!connection || !quote || sending || inFlightRef.current) return
    const signer = keypair ?? signerRef.current ?? (await requestAuth('swap'))
    if (!signer) return
    signerRef.current = signer
    const prepared = preparedRef.current
    const activeOwner = signer.publicKey.toBase58()
    if (
      !prepared ||
      !preview ||
      prepared.owner !== activeOwner ||
      preparedNetworkRef.current !== network ||
      preparedConnectionRef.current !== connection
    ) {
      discardPrepared()
      setSendError('미리보기와 현재 지갑·네트워크·견적이 달라졌습니다. 다시 시뮬레이션해 주세요.')
      return
    }
    inFlightRef.current = true
    setSending(true)
    setSendError(null)
    setStep('sending')
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
              kind: 'swap',
              symbol: `${inputAsset?.symbol ?? '토큰'} → ${outputAsset?.symbol ?? '토큰'}`,
              amount: baseUnits.toString(),
            }
            savePendingTransaction(record)
            persistedSignature = record.signature
            signedRef.current = true
            setPendingTx(record)
            setSignature(record.signature)
            setResolution('pending')
            setStep('tracking')
          },
          onTerminal: () => clearPendingTransaction(activeOwner, network, persistedSignature),
        }
        try {
          const sig = await signPreparedSwap({ connection, keypair: signer, prepared, quote, hooks })
          discardPrepared()
          setSignature(sig)
          setResolution('confirmed')
          setPendingTx(null)
          setStep('done')
          try {
            onDone()
          } catch {
            // A refresh/navigation issue cannot turn a confirmed swap into a retry prompt.
          }
        } catch (error) {
          const message = String((error as Error)?.message ?? '')
          if (error instanceof TxOutcomeError) {
            setSignature(error.signature)
            setResolution(error.outcome)
            try {
              setPendingTx(readPendingTransaction(activeOwner, network))
            } catch (storageError) {
              setSendError(storageError instanceof Error ? storageError.message : message)
            }
            setSendError(message)
            setStep('tracking')
          } else if (signedRef.current) {
            setResolution('unknown')
            try {
              setPendingTx(readPendingTransaction(activeOwner, network))
            } catch (storageError) {
              setSendError(storageError instanceof Error ? storageError.message : message)
            }
            setSendError(message || '서명 이후 오류가 발생했습니다. 같은 스왑을 다시 시작하지 마세요.')
            setStep('tracking')
          } else {
            discardPrepared()
            setSendError(error instanceof SwapGuardError ? message : message || '스왑에 실패했습니다.')
            setStep('confirm')
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
        setSendError('다른 탭에서 전송 또는 스왑을 진행 중입니다. 완료 여부를 확인한 뒤 다시 시도하세요.')
        setStep('confirm')
      }
    } catch (error) {
      discardPrepared()
      setSendError(error instanceof Error ? error.message : '스왑을 위한 안전 잠금을 확인하지 못했습니다.')
      setStep('confirm')
    } finally {
      setSending(false)
      inFlightRef.current = false
    }
  }, [connection, keypair, quote, sending, onDone, network, checkPending, inputAsset, outputAsset, baseUnits, preview, requestAuth])

  const canQuote = Boolean(
    quote && !quoting && baseUnits > 0n && !insufficient && !sameToken && network === 'mainnet' && !pendingTx,
  )
  const impactHigh = (quote?.priceImpactPct ?? 0) >= 3

  const tokenPanel = (kind: 'in' | 'out') => {
    const active = kind === 'in' ? inputAsset : outputAsset
    return (
      <div className="no-scrollbar mt-2 max-h-[228px] overflow-y-auto rounded-[18px] bg-surface p-1.5">
        {universe.map((asset) => {
          const selected = asset.key === active?.key
          const disabled =
            kind === 'in' ? asset.mint === outputAsset?.mint : asset.mint === inputAsset?.mint
          return (
            <button
              key={`${kind}-${asset.key}`}
              disabled={disabled}
              onClick={() => {
                if (kind === 'in') setInputKey(asset.key)
                else setOutputKey(asset.key)
                setPicker(null)
                setAmount('')
              }}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-[14px] px-2.5 py-2 text-left',
                disabled ? 'opacity-35' : 'active:bg-card',
              )}
            >
              <TokenIcon symbol={asset.isSol ? 'SOL' : asset.symbol} icon={asset.icon} size={28} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-ink">
                  {asset.isSol ? 'SOL' : asset.symbol}
                </div>
                <div className="truncate text-[10.5px] text-muted">
                  {asset.isSol ? 'Solana' : asset.name}
                </div>
              </div>
              <span className="tnum text-[11.5px] text-muted">
                {formatAmount(asset.amount, asset.decimals, 4)}
              </span>
              {selected && <Check size={14} className="text-ink" />}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="animate-fade flex flex-1 flex-col">
      <div
        className="flex items-center justify-between px-5"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 18px)' }}
      >
        <h1 className="text-[22px] font-bold tracking-[-0.035em] text-ink">스왑</h1>
        <div className="flex items-center gap-1 rounded-full bg-surface p-0.5">
          {SLIPPAGE_OPTIONS.map((option) => (
            <button
              key={option.bps}
              onClick={() => setSlippageBps(option.bps)}
              className={cx(
                'rounded-full px-2.5 py-1 text-[11px] transition-colors',
                slippageBps === option.bps
                  ? 'bg-card font-semibold text-ink shadow-[0_1px_2px_rgba(13,14,18,0.06)]'
                  : 'font-medium text-muted',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 px-5">
        {network !== 'mainnet' && (
          <div className="mb-3 rounded-[14px] bg-surface px-3.5 py-2.5 text-[11.5px] leading-snug text-muted">
            스왑은 Solana Mainnet에서만 동작합니다. 설정에서 Mainnet으로 바꿔 주세요.
          </div>
        )}

        {pendingTx && (
          <div className="mb-3 flex items-center gap-3 rounded-[14px] bg-dangerSoft px-3.5 py-2.5">
            <div className="min-w-0 flex-1 text-[11.5px] leading-snug text-danger">
              이전 전송의 결과가 아직 확인되지 않았습니다. 중복 방지를 위해 새 스왑을 막았습니다.
            </div>
            <button
              onClick={() => {
                setStep('tracking')
                void checkPending(pendingTx)
              }}
              className="shrink-0 text-[11.5px] font-semibold text-danger"
            >
              상태 확인
            </button>
          </div>
        )}

        <div className="rounded-[22px] bg-card p-4 shadow-[0_1px_2px_rgba(13,14,18,0.04)] ring-1 ring-line">
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-medium text-muted">보내는 토큰</span>
            <button
              onClick={setMax}
              className="rounded-full bg-surface px-2 py-[3px] text-[10px] font-semibold text-ink active:bg-press"
            >
              MAX
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              value={amount}
              onChange={(event) => {
                const next = event.target.value.replace(/,/g, '')
                if (!/^[0-9]*\.?[0-9]*$/.test(next)) return
                const [, frac = ''] = next.split('.')
                if (frac.length > inDecimals) return
                setAmount(next)
              }}
              inputMode="decimal"
              placeholder="0"
              id="swap-amount"
              className="tnum min-w-0 flex-1 bg-transparent text-[30px] font-bold tracking-[-0.035em] text-ink outline-none placeholder:text-faint2"
            />
            <button
              onClick={() => setPicker(picker === 'in' ? null : 'in')}
              className="press flex shrink-0 items-center gap-1.5 rounded-full bg-surface py-1 pl-1 pr-2.5"
            >
              <TokenIcon
                symbol={inputAsset?.isSol ? 'SOL' : inputAsset?.symbol ?? 'SOL'}
                icon={inputAsset?.icon}
                size={24}
              />
              <span className="text-[13.5px] font-semibold text-ink">
                {inputAsset?.isSol ? 'SOL' : inputAsset?.symbol}
              </span>
              <ChevronDown size={13} className="text-faint" />
            </button>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted">
            <span className="tnum">{inputValueUsd !== null ? formatUsd(inputValueUsd) : ''}</span>
            <button onClick={() => setAmount(String(balanceUi))} className="tnum active:opacity-60">
              잔액 {formatAmount(inputAsset?.amount ?? 0n, inDecimals, 4)}
            </button>
          </div>
          {picker === 'in' && tokenPanel('in')}
        </div>

        <div className="relative z-10 -my-3 flex justify-center">
          <button
            onClick={flip}
            aria-label="방향 바꾸기"
            className="press flex h-9 w-9 items-center justify-center rounded-full bg-card text-ink shadow-[0_2px_10px_rgba(13,14,18,0.10)] ring-1 ring-line"
          >
            <ArrowDownUp
              size={16}
              className="transition-transform duration-500 ease-[cubic-bezier(0.34,1.42,0.64,1)]"
              style={{ transform: `rotate(${flips * 180}deg)` }}
            />
          </button>
        </div>

        <div className="rounded-[22px] bg-card p-4 shadow-[0_1px_2px_rgba(13,14,18,0.04)] ring-1 ring-line">
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-medium text-muted">받는 토큰</span>
            {outAmount !== null && (
              <span className="text-[10.5px] text-faint tnum">
                ≈ {formatUsd(outAmount * (outputAsset?.priceUsd ?? 0) || null)}
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <div
              className={cx(
                'tnum min-w-0 flex-1 truncate text-[30px] font-bold tracking-[-0.035em]',
                shownOut === null ? 'text-faint2' : 'text-ink',
              )}
            >
              {shownOut === null ? (
                quoting ? (
                  <Loader2 size={22} className="animate-spin-slow text-muted" />
                ) : (
                  '0'
                )
              ) : (
                <span
                  className={cx(
                    'inline-flex items-baseline gap-1.5 transition-opacity duration-200',
                    quoting && 'opacity-45',
                  )}
                >
                  <AnimatedNumber
                    value={shownOut}
                    format={outText}
                    snapKey={outputAsset?.key}
                  />
                  {quoting && <Loader2 size={14} className="animate-spin-slow text-muted" />}
                </span>
              )}
            </div>
            <button
              onClick={() => setPicker(picker === 'out' ? null : 'out')}
              className="press flex shrink-0 items-center gap-1.5 rounded-full bg-surface py-1 pl-1 pr-2.5"
            >
              <TokenIcon
                symbol={outputAsset?.isSol ? 'SOL' : outputAsset?.symbol ?? 'USDC'}
                icon={outputAsset?.icon}
                size={24}
              />
              <span className="text-[13.5px] font-semibold text-ink">
                {outputAsset?.isSol ? 'SOL' : outputAsset?.symbol}
              </span>
              <ChevronDown size={13} className="text-faint" />
            </button>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted">
            <span className="tnum">
              {rate !== null ? formatPrice(rate) : outputAsset?.priceUsd ? formatPrice(outputAsset.priceUsd) : ''}
            </span>
            <span className="tnum">
              잔액 {formatAmount(outputAsset?.amount ?? 0n, outDecimals, 4)}
            </span>
          </div>
          {picker === 'out' && tokenPanel('out')}
        </div>

        <div className="mt-4 space-y-2 px-1">
          {quote && (
            <>
              <div className="flex items-center justify-between text-[11.5px]">
                <span className="text-muted">가격 영향</span>
                <span className={cx('tnum font-medium', impactHigh ? 'text-danger' : 'text-ink')}>
                  {quote.priceImpactPct < 0.01 ? '<0.01' : quote.priceImpactPct.toFixed(2)}%
                </span>
              </div>
              <div className="flex items-center justify-between text-[11.5px]">
                <span className="text-muted">최소 수령</span>
                <span className="tnum font-medium text-ink">
                  {minReceived !== null
                    ? `${formatAmount(BigInt(quote.otherAmountThreshold), outDecimals, 6)} ${
                        outputAsset?.isSol ? 'SOL' : outputAsset?.symbol
                      }`
                    : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11.5px]">
                <span className="text-muted">슬리피지</span>
                <span className="tnum font-medium text-ink">
                  {(quote.slippageBps / 100).toFixed(2)}%
                </span>
              </div>
              {quote.route.length > 0 && (
                <div className="flex items-center justify-between text-[11.5px]">
                  <span className="text-muted">경로</span>
                  <span className="max-w-[60%] truncate text-right font-medium text-ink">
                    {quote.route.join(' · ')}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {quoteError && (
          <div className="mt-3 flex items-start gap-2 rounded-[14px] bg-surface px-3.5 py-2.5 text-[11.5px] leading-snug text-muted">
            <Info size={13} className="mt-[1px] shrink-0" />
            <span>{quoteError}</span>
          </div>
        )}

        {insufficient && baseUnits > 0n && (
          <div className="mt-3 rounded-[14px] bg-dangerSoft px-3.5 py-2.5 text-[11.5px] text-danger">
            잔액이 부족합니다. 수수료로 약 0.01 SOL을 남겨 두세요.
          </div>
        )}

        <div className="mt-5">
          {!keypair ? (
            <Button full variant="secondary" onClick={() => void requestAuth('swap')} id="swap-auth">
              PIN 확인하고 계속
            </Button>
          ) : (
            <Button
              full
              disabled={!canQuote}
              loading={quoting}
              onClick={() => setStep('confirm')}
              id="swap-review"
            >
              {pendingTx
                ? '이전 전송 상태를 먼저 확인하세요'
                : sameToken
                  ? '서로 다른 토큰을 고르세요'
                  : quoting
                    ? '견적 받는 중'
                    : '스왑'}
            </Button>
          )}
        </div>

        <p className="mt-3 px-1 pb-6 text-[10.5px] leading-[1.65] text-faint">
          Jupiter 애그리게이터가 최적 경로를 찾고, 서명은 이 기기에서만 이루어집니다. 서명 전에
          트랜잭션을 네트워크에서 시뮬레이션해 잔액 변화가 이 견적과 같은지 확인하며, 다르면
          서명하지 않습니다. 가격 영향이 큰 거래는 손실이 될 수 있습니다.
        </p>
      </div>

      <Sheet
        open={step === 'confirm'}
        onClose={() => {
          if (!sending) {
            discardPrepared()
            setStep('form')
          }
        }}
        title="스왑 확인"
        footer={
          <div className="space-y-2">
            <Button
              full
              onClick={() => void (preview ? execute() : preparePreview())}
              loading={sending || preparing}
              disabled={preparing || (!preview && !quote)}
              id="swap-confirm"
            >
              {preparing ? '시뮬레이션 중…' : preview ? '미리보기대로 서명하고 스왑' : '시뮬레이션 미리보기'}
            </Button>
            <Button full variant="secondary" disabled={sending || preparing} onClick={() => { discardPrepared(); setStep('form') }}>
              이전
            </Button>
          </div>
        }
      >
        <div className="flex flex-col items-center pt-2">
          <div className="flex items-center gap-2">
            <TokenIcon
              symbol={inputAsset?.isSol ? 'SOL' : inputAsset?.symbol ?? 'SOL'}
              icon={inputAsset?.icon}
              size={44}
            />
            <span className="tnum text-[19px] font-bold text-ink">
              {formatAmount(baseUnits, inDecimals, 6)}
            </span>
            <span className="text-[15px] font-semibold text-muted">
              {inputAsset?.isSol ? 'SOL' : inputAsset?.symbol}
            </span>
          </div>
          <ArrowDownUp size={16} className="my-2.5 text-faint" />
          <div className="flex items-center gap-2">
            <TokenIcon
              symbol={outputAsset?.isSol ? 'SOL' : outputAsset?.symbol ?? 'USDC'}
              icon={outputAsset?.icon}
              size={44}
            />
            <span className="tnum text-[19px] font-bold text-ink">
              {outAmount !== null ? formatAmount(BigInt(quote!.outAmount), outDecimals, 6) : '—'}
            </span>
            <span className="text-[15px] font-semibold text-muted">
              {outputAsset?.isSol ? 'SOL' : outputAsset?.symbol}
            </span>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted">최소 수령</span>
            <span className="tnum text-ink">
              {quote ? formatAmount(BigInt(quote.otherAmountThreshold), outDecimals, 6) : '—'}{' '}
              {outputAsset?.isSol ? 'SOL' : outputAsset?.symbol}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted">가격 영향</span>
            <span className={cx('tnum', impactHigh ? 'text-danger' : 'text-ink')}>
              {quote ? `${quote.priceImpactPct.toFixed(2)}%` : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted">슬리피지</span>
            <span className="tnum text-ink">{(slippageBps / 100).toFixed(2)}%</span>
          </div>
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted">네트워크</span>
            <span className="text-ink">Solana Mainnet</span>
          </div>
        </div>

        {preparing && (
          <div className="mt-4 flex items-center gap-2 rounded-[14px] bg-surface px-3.5 py-3 text-[11.5px] text-muted">
            <Loader2 size={14} className="animate-spin-slow" />
            서명할 트랜잭션을 시뮬레이션하고 있습니다. 결과가 불완전하면 서명하지 않습니다.
          </div>
        )}

        {preview && (
          <section className="mt-5 rounded-[16px] bg-surface p-3.5">
            <div className="text-[12px] font-semibold text-ink">서명 전 시뮬레이션</div>
            <div className="mt-2 break-all font-mono text-[9.5px] leading-relaxed text-muted">
              받는 지갑 · {preview.recipient}
            </div>
            <div className="mt-3 flex items-center justify-between text-[11.5px]">
              <span className="text-muted">트랜잭션 수수료</span>
              <span className="tnum font-medium text-ink">{formatAmount(BigInt(preview.feeLamports), 9, 6)} SOL</span>
            </div>
            <div className="mt-3 space-y-2.5">
              {preview.nativeChanges.map((change) => (
                <div key={`swap-sol-${change.address}`} className="flex items-start justify-between gap-3 text-[11.5px]">
                  <span className="text-muted">지갑 SOL 변화</span>
                  <span className="tnum text-right font-medium text-ink">
                    {signedAmount(change.deltaLamports, 9)} SOL
                    <span className="block text-[10px] font-normal text-faint">
                      {formatAmount(BigInt(change.beforeLamports), 9, 6)} → {formatAmount(BigInt(change.afterLamports), 9, 6)}
                    </span>
                  </span>
                </div>
              ))}
              {preview.tokenChanges.map((change) => {
                const token = universe.find((asset) => asset.mint === change.mint)
                const label = token?.symbol ?? change.mint.slice(0, 5)
                return (
                  <div key={`swap-token-${change.owner}-${change.mint}`} className="flex items-start justify-between gap-3 text-[11.5px]">
                    <span className="text-muted">{label} 변화</span>
                    <span className="tnum text-right font-medium text-ink">
                      {signedAmount(change.deltaAmount, change.decimals)} {label}
                      <span className="block text-[10px] font-normal text-faint">
                        {formatAmount(BigInt(change.beforeAmount), change.decimals, 6)} → {formatAmount(BigInt(change.afterAmount), change.decimals, 6)}
                      </span>
                    </span>
                  </div>
                )
              })}
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
              슬롯 {preview.slot}에서 얻은 미리보기입니다. 시뮬레이션 결과와 미리보기 메시지가 일치할 때만 서명합니다.
            </p>
          </section>
        )}

        {impactHigh && (
          <div className="mt-4 rounded-[14px] bg-dangerSoft px-3.5 py-2.5 text-[11.5px] leading-snug text-danger">
            가격 영향이 {(quote?.priceImpactPct ?? 0).toFixed(2)}%입니다. 유동성이 얕은 구간이라
            손실이 클 수 있습니다.
          </div>
        )}

        {sendError && (
          <div className="mt-4 rounded-[14px] bg-dangerSoft px-3.5 py-2.5 text-[11.5px] leading-snug text-danger">
            {sendError}
          </div>
        )}
      </Sheet>

      <Sheet
        open={step === 'sending'}
        onClose={() => undefined}
        title="스왑 진행 중"
      >
        <div className="flex flex-col items-center py-10">
          <Loader2 size={26} className="animate-spin-slow text-ink" />
          <p className="mt-4 text-[13px] text-muted">트랜잭션을 보내고 컨펌을 기다립니다.</p>
        </div>
      </Sheet>

      <Sheet
        open={step === 'tracking'}
        onClose={() => setStep('form')}
        title="스왑 전송 상태"
        footer={
          <div className="space-y-2">
            <Button
              full
              onClick={() => void checkPending()}
              loading={checking}
              disabled={!pendingTx || !connection}
            >
              서명 상태 다시 확인
            </Button>
            <Button full variant="secondary" onClick={() => setStep('form')}>
              닫기
            </Button>
          </div>
        }
      >
        <div className="flex flex-col items-center py-5 text-center">
          <Loader2 size={25} className={cx('text-ink', checking && 'animate-spin-slow')} />
          <div className="mt-4 text-[18px] font-bold text-ink">
            {resolution === 'confirmed'
              ? '스왑 성공 확인'
              : resolution === 'pending'
              ? '네트워크 확인 중'
              : resolution === 'failed'
                ? '스왑 실패 확인'
                : resolution === 'expired'
                  ? '블록해시 만료 · 결과 미확정'
                  : '스왑 결과 불명확'}
          </div>
          <p className="mt-2 max-w-[290px] text-[12.5px] leading-relaxed text-muted">
            {resolution === 'confirmed'
              ? '네트워크에서 이 서명의 성공을 확인했습니다.'
              : resolution === 'failed'
              ? '네트워크가 이 서명의 실패를 확인했습니다. 새 스왑은 닫은 뒤 직접 다시 시작할 수 있습니다.'
              : resolution === 'expired'
                ? '블록해시 유효기간은 지났지만 과거 포함 여부가 확인되지 않았습니다. 중복 방지를 위해 새 스왑은 차단됩니다.'
                : resolution === 'pending'
                  ? '동일한 서명의 확정을 기다리고 있습니다. 같은 스왑을 다시 시작하지 마세요.'
                  : '네트워크에서 이 서명의 결과를 확인할 수 없습니다. 연결 복구 후 같은 서명을 다시 조회하세요.'}
          </p>
          {sendError && (
            <div className="mt-4 w-full rounded-[14px] bg-dangerSoft px-3.5 py-2.5 text-left text-[11.5px] leading-snug text-danger">
              {sendError}
            </div>
          )}
          {signature && (
            <a
              href={explorerTx(signature, network)}
              target="_blank"
              rel="noreferrer"
              className="mt-5 flex items-center gap-1.5 rounded-full bg-surface px-3.5 py-2 text-[12px] font-medium text-ink"
            >
              Solscan에서 확인 <ExternalLink size={12} />
            </a>
          )}
        </div>
      </Sheet>

      <Sheet open={step === 'done'} onClose={() => setStep('form')} title={undefined}>
        <div className="flex flex-col items-center py-6">
          <SuccessMark />
          <div className="mt-5 text-[19px] font-bold tracking-[-0.03em] text-ink">스왑 완료</div>
          <div className="mt-2 text-[13px] text-muted">
            {outAmount !== null
              ? `${formatAmount(BigInt(quote!.outAmount), outDecimals, 6)} ${
                  outputAsset?.isSol ? 'SOL' : outputAsset?.symbol
                }`
              : ''}
          </div>
          {signature && (
            <a
              href={explorerTx(signature, network)}
              target="_blank"
              rel="noreferrer"
              className="mt-5 flex items-center gap-1.5 rounded-full bg-surface px-3.5 py-2 text-[12px] font-medium text-ink"
            >
              Solscan에서 보기 <ExternalLink size={12} />
            </a>
          )}
          <button
            onClick={() => {
              setStep('form')
              setAmount('')
              setQuote(null)
              setSignature(null)
              setOutputKey(USDC_MINT)
            }}
            className="mt-4 text-[12.5px] font-semibold text-muted"
          >
            확인
          </button>
          {outputAsset?.amount === 0n && (
            <button onClick={onOpenReceive} className="mt-2 text-[11.5px] text-faint">
              받기 화면 열기
            </button>
          )}
        </div>
      </Sheet>
    </div>
  )
}
