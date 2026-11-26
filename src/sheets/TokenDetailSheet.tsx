import { useEffect, useMemo, useState } from 'react'
import type { Connection } from '@solana/web3.js'
import {
  ArrowLeftRight,
  EyeOff,
  Eye,
  Loader2,
  QrCode,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Star,
} from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { Button } from '../components/Button'
import { TokenIcon } from '../components/ui'
import { showToast } from '../components/Toast'
import { cx, formatAmount, formatPrice, formatUsd, shortAddress } from '../lib/format'
import type { Asset } from '../lib/assets'
import type { NetworkId } from '../lib/rpc'
import type { HistoryItem } from '../lib/tx'
import { fetchPriceSeries, type PriceSeries } from '../lib/chart'
import { SECURITY_DISCLAIMER, fetchTokenSecurity, type TokenSecurity } from '../lib/security'
import { isHidden, isWatched, setHidden, toggleWatch, usePrefs } from '../lib/prefs'
import { TxRow, type TokenSymbolMap } from '../components/TxRow'
import { networkDisplayName } from '../lib/rpc'

interface TokenDetailSheetProps {
  open: boolean
  assetKey: string
  assets: Asset[]
  connection: Connection | null
  network: NetworkId
  ownerAddress: string
  portfolioReady: boolean
  historyItems: HistoryItem[]
  historyLoading: boolean
  historyError: string | null
  tokenSymbols: TokenSymbolMap
  onRefreshHistory: () => void
  onClose: () => void
  onSend: (mint: string) => void
  onReceive: () => void
  onSwap: (mint: string) => void
}

/** Area chart with a soft gradient — no axes, no grid labels, one line. */
function PriceChart({
  points,
  height = 148,
  positive,
}: {
  points: number[]
  height?: number
  positive: boolean
}) {
  const geometry = useMemo(() => {
    if (!points || points.length < 2) return null
    const step = Math.max(1, Math.ceil(points.length / 90))
    const series = points.filter((_, index) => index % step === 0)
    if (series.length < 2) return null
    let min = Infinity
    let max = -Infinity
    for (const value of series) {
      if (value < min) min = value
      if (value > max) max = value
    }
    const span = max - min || Math.max(0.0001, max * 0.01)
    const width = 320
    const top = 10
    const bottom = 120
    const coords = series.map((value, index) => {
      const x = (index / (series.length - 1)) * width
      const y = bottom - ((value - min) / span) * (bottom - top)
      return [x, y] as const
    })
    const line = coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
    const area = `${line} L${width} ${bottom} L0 ${bottom} Z`
    const last = coords[coords.length - 1]
    return { line, area, last, min, max }
  }, [points])

  if (!geometry) return null
  const stroke = positive ? '#16A34A' : '#EF4444'
  const gradientId = positive ? 'chart-up' : 'chart-down'

  return (
    <svg
      viewBox="0 0 320 130"
      preserveAspectRatio="none"
      width="100%"
      height={height}
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={geometry.area} fill={`url(#${gradientId})`} />
      <path
        d={geometry.line}
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        className="animate-draw"
      />
      <circle cx={geometry.last[0]} cy={geometry.last[1]} r={3.5} fill={stroke} />
    </svg>
  )
}

export default function TokenDetailSheet({
  open,
  assetKey,
  assets,
  connection,
  network,
  ownerAddress,
  portfolioReady,
  historyItems,
  historyLoading,
  historyError,
  tokenSymbols,
  onRefreshHistory,
  onClose,
  onSend,
  onReceive,
  onSwap,
}: TokenDetailSheetProps) {
  const asset = assets.find((item) => item.key === assetKey) ?? assets[0] ?? null
  const prefs = usePrefs()
  const [range, setRange] = useState<1 | 7>(1)
  const [chartRefresh, setChartRefresh] = useState(0)
  const [series, setSeries] = useState<PriceSeries | null>(null)
  const [chartLoading, setChartLoading] = useState(false)
  const [security, setSecurity] = useState<TokenSecurity | null>(null)
  const [securityLoading, setSecurityLoading] = useState(false)
  const [securityError, setSecurityError] = useState<string | null>(null)

  const mint = asset && !asset.isSol ? asset.mint : null

  useEffect(() => {
    if (!open || !asset) return
    setSeries(null)
    setRange(1)
  }, [open, asset?.key])

  useEffect(() => {
    if (!open || !asset) return
    let cancelled = false
    setChartLoading(true)
    void fetchPriceSeries(mint, range, { force: true })
      .then((result) => {
        if (!cancelled) setSeries(result)
      })
      .finally(() => {
        if (!cancelled) setChartLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, mint, range, asset?.key, ownerAddress, chartRefresh])

  useEffect(() => {
    if (!open) return
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') setChartRefresh((value) => value + 1)
    }
    const timer = window.setInterval(refreshVisible, 60_000)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [open])

  useEffect(() => {
    if (!open || !mint || !connection) {
      setSecurity(null)
      return
    }
    let cancelled = false
    setSecurityLoading(true)
    setSecurityError(null)
    void fetchTokenSecurity(connection, mint)
      .then((result) => {
        if (!cancelled) setSecurity(result)
      })
      .catch((error) => {
        if (!cancelled) setSecurityError((error as Error)?.message ?? '보안 정보를 읽지 못했습니다.')
      })
      .finally(() => {
        if (!cancelled) setSecurityLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, mint, connection])

  if (!asset) return null

  const price = asset.priceUsd
  const change = series?.changePct ?? null
  const positive = (change ?? 0) >= 0
  const watched = prefs.watch.includes(asset.mint)
  const hidden = prefs.hidden.includes(asset.mint)

  const mintAuthorityGone = security ? security.mintAuthority === null : null
  const freezeAuthorityGone = security ? security.freezeAuthority === null : null
  const riskyExtensions = security?.extensions ?? []

  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex items-start justify-between pb-1">
        <div className="flex items-center gap-3">
          <TokenIcon symbol={asset.isSol ? 'SOL' : asset.symbol} icon={asset.icon} size={48} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[18px] font-bold tracking-[-0.03em] text-ink">
                {asset.isSol ? 'Solana' : asset.symbol}
              </span>
              {!asset.isSol && (
                <span className="rounded-full bg-surface px-1.5 py-[2px] text-[9.5px] font-semibold text-muted">
                  {security?.standard === 'token-2022' ? 'Token-2022' : 'SPL'}
                </span>
              )}
            </div>
            <div className="mt-0.5 max-w-[190px] truncate text-[11.5px] text-muted">
              {asset.isSol ? 'SOL' : asset.name}
            </div>
          </div>
        </div>
        <button
          onClick={() => {
            const next = toggleWatch(asset.mint)
            showToast(next ? '관심 목록에 추가했습니다' : '관심 목록에서 뺐습니다')
          }}
          aria-label={watched ? '관심 목록에서 빼기' : '관심 목록에 추가'}
          aria-pressed={watched}
          className={cx(
            'press flex h-9 w-9 items-center justify-center rounded-full',
            watched ? 'bg-mintSoft text-mint' : 'bg-surface text-muted',
          )}
        >
          <Star size={16} fill={watched ? 'currentColor' : 'none'} strokeWidth={2} />
        </button>
      </div>

      <div className="mt-5">
        <div className="flex items-end gap-2">
          <span className="tnum text-[30px] font-bold leading-none tracking-[-0.035em] text-ink">
            {formatPrice(price)}
          </span>
          {change !== null && (
            <span className={cx('tnum text-[13px] font-semibold', positive ? 'text-mint' : 'text-danger')}>
              {positive ? '+' : ''}
              {change.toFixed(2)}%
            </span>
          )}
        </div>
        <div className="mt-1 text-[11.5px] text-muted tnum">
          {portfolioReady
            ? <>보유 {formatAmount(asset.amount, asset.decimals, 6)} {asset.isSol ? 'SOL' : asset.symbol} · {formatUsd(asset.valueUsd)}</>
            : '보유 — · —'}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-full bg-surface p-0.5">
          {([
            { value: 1 as const, label: '1일' },
            { value: 7 as const, label: '7일' },
          ]).map((option) => (
            <button
              key={option.value}
              onClick={() => setRange(option.value)}
              className={cx(
                'rounded-full px-3 py-1 text-[11px] transition-colors',
                range === option.value
                  ? 'bg-card font-semibold text-ink shadow-[0_1px_2px_rgba(13,14,18,0.06)]'
                  : 'font-medium text-muted',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        {chartLoading && <Loader2 size={13} className="animate-spin-slow text-faint" />}
      </div>

      <div className="mt-2 h-[148px]">
        {series && series.points.length > 1 ? (
          <PriceChart points={series.points} positive={positive} />
        ) : chartLoading ? (
          <div className="skeleton h-full w-full rounded-[16px]" aria-hidden="true" />
        ) : (
          <div className="flex h-full items-center justify-center rounded-[16px] bg-surface px-4 text-center text-[11.5px] leading-relaxed text-muted">
            이 토큰의 가격 차트를 제공하는 공개 소스가 없습니다.
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between text-[10.5px] text-faint">
        <span>{series?.source === 'binance' ? 'Binance' : series ? 'CoinGecko' : ''}</span>
        <span>{range === 1 ? '최근 24시간' : '최근 7일'}</span>
      </div>

      {asset.isSol && (
        <section className="mt-5">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-[13px] font-semibold text-ink">최근 지갑 거래</h3>
            <button
              onClick={onRefreshHistory}
              disabled={historyLoading}
              aria-label="거래내역 새로고침"
              className="press flex h-7 w-7 items-center justify-center rounded-full bg-surface text-muted disabled:opacity-50"
            >
              <RefreshCw size={13} className={cx(historyLoading && 'animate-spin-slow')} />
            </button>
          </div>
          {historyError && (
            <div className="mt-2 rounded-[14px] bg-surface px-3.5 py-2.5 text-[11px] leading-relaxed text-muted">
              {historyError} RPC가 거래내역을 제한할 수 있습니다.
            </div>
          )}
          {historyLoading && historyItems.length === 0 ? (
            <div className="flex items-center justify-center py-6 text-muted" aria-label="거래내역 불러오는 중">
              <Loader2 size={17} className="animate-spin-slow" />
            </div>
          ) : historyItems.length > 0 ? (
            <div className="-mx-6 mt-2">
              {historyItems.slice(0, 5).map((item, index) => (
                <TxRow
                  key={item.signature}
                  item={item}
                  tokenSymbols={tokenSymbols}
                  network={network}
                  showBorder={index > 0}
                />
              ))}
            </div>
          ) : historyError ? null : (
            <p className="mt-2 rounded-[14px] bg-surface px-3.5 py-3 text-center text-[11.5px] text-muted">
              아직 표시할 거래내역이 없습니다.
            </p>
          )}
        </section>
      )}

      {!asset.isSol && (
        <section className="mt-5 rounded-[18px] bg-surface p-4">
          <div className="flex items-center gap-1.5">
            {securityLoading ? (
              <Loader2 size={13} className="animate-spin-slow text-muted" />
            ) : securityError ? (
              <ShieldAlert size={14} className="text-muted" />
            ) : mintAuthorityGone && freezeAuthorityGone ? (
              <ShieldCheck size={14} className="text-mint" />
            ) : (
              <ShieldAlert size={14} className="text-warn" />
            )}
            <span className="text-[12.5px] font-semibold text-ink">보안 체크</span>
          </div>

          {securityError ? (
            <p className="mt-2 text-[11.5px] leading-relaxed text-muted">{securityError}</p>
          ) : security && (
            <>
              <div className="mt-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-muted">민트 권한 (추가 발행)</span>
                  <span
                    className={cx(
                      'text-[12px] font-semibold',
                      mintAuthorityGone ? 'text-mint' : 'text-warn',
                    )}
                  >
                    {mintAuthorityGone ? '폐기됨' : '남아 있음'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-muted">동결 권한</span>
                  <span
                    className={cx(
                      'text-[12px] font-semibold',
                      freezeAuthorityGone ? 'text-mint' : 'text-warn',
                    )}
                  >
                    {freezeAuthorityGone ? '폐기됨' : '남아 있음'}
                  </span>
                </div>
                {!mintAuthorityGone && security.mintAuthority && (
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-faint">권한자</span>
                    <span className="font-mono text-[10.5px] text-muted">
                      {shortAddress(security.mintAuthority, 5)}
                    </span>
                  </div>
                )}
                {riskyExtensions.length > 0 && (
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-[12px] text-muted">확장 기능</span>
                    <span className="max-w-[62%] text-right text-[11.5px] font-medium text-ink">
                      {riskyExtensions.join(', ')}
                    </span>
                  </div>
                )}
                {security.decimals !== null && (
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-faint">소수점 · 프로그램</span>
                    <span className="text-[10.5px] text-muted">
                      {security.decimals} · {shortAddress(security.program, 4)}
                    </span>
                  </div>
                )}
              </div>
            </>
          )}

          <p className="mt-3 border-t border-line2 pt-2.5 text-[10.5px] leading-[1.6] text-faint">
            {SECURITY_DISCLAIMER}
          </p>
        </section>
      )}

      {!asset.isSol && (
        <button
          onClick={() => {
            setHidden(asset.mint, !isHidden(asset.mint))
            showToast(hidden ? '목록에 다시 표시합니다' : '지갑 목록에서 숨겼습니다')
          }}
          className="mt-3 flex w-full items-center justify-between rounded-[16px] bg-surface px-4 py-3 text-left active:bg-press"
        >
          <span className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
            {hidden ? <Eye size={14} /> : <EyeOff size={14} />}
            {hidden ? '지갑 목록에 다시 표시' : '지갑 목록에서 숨기기'}
          </span>
          <span className="text-[11px] text-faint">{hidden ? '숨김' : '표시 중'}</span>
        </button>
      )}

      <div className="mt-5 grid grid-cols-3 gap-2 pb-[calc(env(safe-area-inset-bottom)+6px)]" data-token-actions>
        <Button
          className="px-2 text-[13.5px]"
          onClick={() => onSend(asset.isSol ? 'SOL' : asset.mint)}
          id="token-send"
        >
          <span className="flex items-center gap-1.5">
            <Send size={14} /> 보내기
          </span>
        </Button>
        <Button
          variant="secondary"
          className="px-2 text-[13.5px]"
          onClick={onReceive}
          id="token-receive"
        >
          <span className="flex items-center gap-1.5">
            <QrCode size={14} /> 받기
          </span>
        </Button>
        <Button
          variant="secondary"
          className="px-2 text-[13.5px]"
          onClick={() => onSwap(asset.isSol ? 'SOL' : asset.mint)}
          id="token-swap"
        >
          <span className="flex items-center gap-1.5">
            <ArrowLeftRight size={14} /> 스왑
          </span>
        </Button>
      </div>

      <p className="mt-3 text-[10px] text-faint">
        {networkDisplayName(network)} · {isWatched(asset.mint) ? '관심 목록에 있음' : '관심 목록에 없음'}
      </p>
    </Sheet>
  )
}
