import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Connection, Keypair } from '@solana/web3.js'
import { ArrowDownUp, Check, ChevronDown, ExternalLink, Info, Loader2 } from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { Button } from '../components/Button'
import { TokenIcon } from '../components/ui'
import { showToast } from '../components/Toast'
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
import { executeSwap } from '../lib/swapExecute'
import { SwapGuardError } from '../lib/swapGuard'

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
  const [step, setStep] = useState<'form' | 'confirm' | 'sending' | 'done'>('form')
  const [sending, setSending] = useState(false)
  const [signature, setSignature] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const requestId = useRef(0)

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

  /* ------------------------------------------------------------- quoting */

  useEffect(() => {
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

  const execute = useCallback(async () => {
    if (!connection || !keypair || !quote || sending) return
    setSending(true)
    setSendError(null)
    setStep('sending')
    try {
      const built = await fetchSwapTransaction(quote, keypair.publicKey.toBase58())
      // Guard → simulate → sign → send happens in one place (lib/swapExecute).
      // Nothing is signed unless the transaction pays with this key, needs only
      // this signature, calls only swap programs, and the simulated balance
      // changes match this quote.
      const sig = await executeSwap({ connection, keypair, built, quote })
      setSignature(sig)
      setStep('done')
      onDone()
    } catch (error) {
      const message = String((error as Error)?.message ?? '')
      setSendError(
        error instanceof SwapGuardError
          ? message
          : /reject|denied|User rejected/i.test(message)
            ? '서명이 취소되었습니다.'
            : message || '스왑에 실패했습니다.',
      )
      setStep('confirm')
    } finally {
      setSending(false)
    }
  }, [connection, keypair, quote, sending, onDone])

  const canQuote = Boolean(
    quote && !quoting && baseUnits > 0n && !insufficient && !sameToken && network === 'mainnet',
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
            <ArrowDownUp size={16} />
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
                outAmount === null ? 'text-faint2' : 'text-ink',
              )}
            >
              {quoting ? (
                <Loader2 size={22} className="animate-spin-slow text-muted" />
              ) : outAmount === null ? (
                '0'
              ) : (
                formatAmount(BigInt(quote!.outAmount), outDecimals, 6)
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
            <Button full variant="secondary" onClick={() => showToast('지갑이 잠겨 있습니다')}>
              잠금 해제가 필요합니다
            </Button>
          ) : (
            <Button
              full
              disabled={!canQuote}
              loading={quoting}
              onClick={() => setStep('confirm')}
              id="swap-review"
            >
              {sameToken ? '서로 다른 토큰을 고르세요' : quoting ? '견적 받는 중' : '스왑'}
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
          if (!sending) setStep('form')
        }}
        title="스왑 확인"
        footer={
          <div className="space-y-2">
            <Button full onClick={() => void execute()} loading={sending} id="swap-confirm">
              서명하고 스왑
            </Button>
            <Button full variant="secondary" disabled={sending} onClick={() => setStep('form')}>
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

      <Sheet open={step === 'done'} onClose={() => setStep('form')} title={undefined}>
        <div className="flex flex-col items-center py-6">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-mintSoft text-mint">
            <Check size={28} strokeWidth={2.6} />
          </div>
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
