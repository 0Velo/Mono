import { useState } from 'react'
import { Check, ChevronRight, Copy, RefreshCw, Settings2 } from 'lucide-react'
import { Sparkline, SolMark, TokenIcon } from '../components/ui'
import { TxRow, type TokenSymbolMap } from '../components/TxRow'
import { showToast } from '../components/Toast'
import {
  formatAmount,
  formatKrw,
  formatPrice,
  formatUsd,
  shortAddress,
  cx,
} from '../lib/format'
import type { Portfolio } from '../lib/tokens'
import type { HistoryItem } from '../lib/tx'
import type { NetworkId } from '../lib/rpc'

interface HomeProps {
  address: string
  network: NetworkId
  portfolio: Portfolio | null
  loading: boolean
  error: string | null
  recent: HistoryItem[]
  tokenSymbols: TokenSymbolMap
  onRefresh: () => void
  onSend: (mint: string | null) => void
  onReceive: () => void
  onActivity: () => void
  onSettings: () => void
  onNetworkChange: (network: NetworkId) => void
}

export function Home({
  address,
  network,
  portfolio,
  loading,
  error,
  recent,
  tokenSymbols,
  onRefresh,
  onSend,
  onReceive,
  onActivity,
  onSettings,
  onNetworkChange,
}: HomeProps) {
  const [showAllTokens, setShowAllTokens] = useState(false)
  const [currency, setCurrency] = useState<'usd' | 'krw'>('usd')
  const [copied, setCopied] = useState(false)

  const tokens = portfolio?.tokens ?? []
  // Unnamed spam tokens stay behind "더 보기" so the list stays readable.
  const named = tokens.filter((token) => !token.name.toLowerCase().startsWith('unknown'))
  const unnamed = tokens.filter((token) => token.name.toLowerCase().startsWith('unknown'))
  const ordered = [...named, ...unnamed]
  const visibleTokens = showAllTokens ? ordered : named.slice(0, 5)
  const hiddenTokens = ordered.length - visibleTokens.length

  const totalUsd = portfolio?.totalUsd ?? null
  const krw = totalUsd !== null && portfolio ? totalUsd * portfolio.usdKrw : null
  const solUi = portfolio ? Number(portfolio.solLamports) / 1e9 : null
  const solValue =
    portfolio && portfolio.solPriceUsd !== null && solUi !== null
      ? solUi * portfolio.solPriceUsd
      : null
  const change = portfolio?.solChange24h ?? null
  const positive = change !== null && change >= 0

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      showToast('주소를 복사했습니다')
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      showToast('복사할 수 없습니다')
    }
  }

  const heroValue =
    currency === 'usd' ? formatUsd(totalUsd) : formatKrw(krw)

  return (
    <div className="animate-fade flex flex-1 flex-col">
      <div
        className="flex items-center justify-between px-5"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 14px)' }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[15px] font-semibold tracking-[-0.025em] text-ink">
            내 지갑
          </span>
          <button
            onClick={copyAddress}
            className="flex shrink-0 items-center gap-1 rounded-full bg-surface px-2 py-[5px] text-[11.5px] font-medium text-muted active:bg-[#EAEDF1]"
            aria-label="주소 복사"
          >
            {copied ? <Check size={11} strokeWidth={2.6} className="text-mint" /> : null}
            <span className="tnum">{shortAddress(address, 4)}</span>
          </button>
        </div>

        <div className="flex shrink-0 items-center">
          <button
            onClick={() => onNetworkChange(network === 'mainnet' ? 'devnet' : 'mainnet')}
            className="flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[11.5px] font-medium text-muted active:opacity-60"
            aria-label="네트워크 전환"
          >
            <span
              className={cx(
                'h-[5px] w-[5px] rounded-full',
                network === 'mainnet' ? 'bg-mint' : 'bg-[#F5A524]',
              )}
            />
            {network === 'mainnet' ? 'Mainnet' : 'Devnet'}
          </button>
          <button
            onClick={onSettings}
            aria-label="설정"
            className="-mr-2 flex h-9 w-9 items-center justify-center rounded-full text-ink active:opacity-60"
          >
            <Settings2 size={19} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <div className="px-5 pt-11">
        <div className="text-[12.5px] font-medium text-muted">총 자산</div>
        <button
          onClick={() => setCurrency((value) => (value === 'usd' ? 'krw' : 'usd'))}
          className="mt-2 block max-w-full text-left"
          aria-label="표시 통화 전환"
        >
          <span className="tnum block text-[42px] font-bold leading-[1.06] tracking-[-0.04em] text-ink">
            {heroValue}
          </span>
        </button>

        <div className="mt-2.5 flex items-center gap-2 text-[12.5px]">
          <span className="tnum font-medium text-muted">
            {solUi !== null ? `${formatAmount(BigInt(portfolio!.solLamports), 9, 4)} SOL` : '—'}
          </span>
          {change !== null && (
            <>
              <span className={cx('tnum font-semibold', positive ? 'text-mint' : 'text-danger')}>
                {positive ? '+' : ''}
                {change.toFixed(2)}%
              </span>
              <span className="text-[11px] text-[#A9AFB9]">24시간</span>
            </>
          )}
          {portfolio?.solPriceUsd !== null && portfolio && (
            <span className="tnum text-[11.5px] text-[#A9AFB9]">
              SOL {formatPrice(portfolio.solPriceUsd)}
            </span>
          )}
        </div>

        <div className="mt-4 h-[46px]">
          {portfolio?.solSparkline && portfolio.solSparkline.length > 1 ? (
            <Sparkline
              data={portfolio.solSparkline}
              height={46}
              color={positive ? '#16A34A' : '#0D0E12'}
            />
          ) : null}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-2.5 px-5">
        <button
          onClick={() => onSend(null)}
          className="h-[54px] rounded-full bg-ink text-[15.5px] font-semibold tracking-[-0.02em] text-white active:bg-[#1D1F27]"
        >
          보내기
        </button>
        <button
          onClick={onReceive}
          className="h-[54px] rounded-full bg-surface2 text-[15.5px] font-semibold tracking-[-0.02em] text-ink active:bg-[#E9ECF0]"
        >
          받기
        </button>
      </div>

      {error && !portfolio && (
        <div className="mx-5 mt-7 rounded-[18px] bg-surface px-4 py-4">
          <div className="text-[13.5px] font-semibold text-ink">네트워크에 연결하지 못했습니다</div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
            공용 RPC가 요청을 거부했을 수 있습니다. 잠시 후 다시 시도하거나 설정에서 개인 RPC
            (Helius · QuickNode)를 입력해 주세요.
          </p>
          <div className="mt-3 flex items-center gap-4">
            <button
              onClick={onRefresh}
              className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink active:opacity-60"
            >
              <RefreshCw size={13} /> 다시 시도
            </button>
            <button
              onClick={onSettings}
              className="text-[12.5px] font-semibold text-muted active:opacity-60"
            >
              RPC 설정
            </button>
          </div>
        </div>
      )}

      <div className="mt-9 flex items-end justify-between px-5">
        <h2 className="text-[12.5px] font-medium text-muted">자산</h2>
        <button
          onClick={onRefresh}
          aria-label="새로고침"
          className="flex items-center gap-1 pb-0.5 text-[11.5px] font-medium text-muted active:opacity-60"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin-slow' : ''} />
          {loading ? '불러오는 중' : '새로고침'}
        </button>
      </div>

      <div className="mt-1.5 px-5">
        <button
          onClick={() => onSend('SOL')}
          className="flex w-full items-center gap-3.5 py-3.5 text-left active:opacity-70"
        >
          <SolMark size={40} />
          <div className="min-w-0 flex-1">
            <div className="text-[14.5px] font-semibold tracking-[-0.02em] text-ink">Solana</div>
            <div className="mt-0.5 text-[11.5px] text-muted tnum">
              {portfolio ? formatPrice(portfolio.solPriceUsd) : '—'}
            </div>
          </div>
          <div className="text-right">
            <div className="tnum text-[14.5px] font-semibold tracking-[-0.02em] text-ink">
              {solUi !== null ? formatAmount(BigInt(portfolio!.solLamports), 9, 4) : '—'} SOL
            </div>
            <div className="mt-0.5 text-[11.5px] text-muted tnum">{formatUsd(solValue)}</div>
          </div>
        </button>

        {visibleTokens.map((token) => (
          <button
            key={token.mint}
            onClick={() => onSend(token.mint)}
            className="flex w-full items-center gap-3.5 py-3.5 text-left active:opacity-70"
          >
            <TokenIcon symbol={token.symbol} icon={token.icon} size={40} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14.5px] font-semibold tracking-[-0.02em] text-ink">
                {token.symbol}
              </div>
              <div className="mt-0.5 h-[15px] truncate text-[11.5px] text-muted">
                {token.priceUsd !== null
                  ? formatPrice(token.priceUsd)
                  : token.name && token.name !== token.symbol
                    ? token.name
                    : ''}
              </div>
            </div>
            <div className="text-right">
              <div className="tnum text-[14.5px] font-semibold tracking-[-0.02em] text-ink">
                {formatAmount(token.amount, token.decimals, 4)}
              </div>
              <div className="mt-0.5 text-[11.5px] text-muted tnum">{formatUsd(token.valueUsd)}</div>
            </div>
          </button>
        ))}

        {hiddenTokens > 0 && (
          <button
            onClick={() => setShowAllTokens(true)}
            className="py-2 text-[12.5px] font-medium text-muted active:opacity-60"
          >
            토큰 {hiddenTokens}개 더 보기
          </button>
        )}

        {portfolio && portfolio.tokens.length === 0 && (
          <div className="mt-1 py-2 text-[12px] leading-relaxed text-muted">
            {portfolio.tokensUnavailable
              ? '이 RPC에서는 토큰 목록을 조회할 수 없습니다. 설정에서 개인 RPC를 입력해 보세요.'
              : '아직 보유한 SPL 토큰이 없습니다.'}
          </div>
        )}

        {!portfolio && loading && (
          <div className="space-y-5 py-3">
            {[0, 1].map((row) => (
              <div key={row} className="flex items-center gap-3.5">
                <div className="skeleton h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-3 w-20 rounded" />
                  <div className="skeleton h-2.5 w-12 rounded" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-8 flex items-center justify-between px-5">
        <h2 className="text-[12.5px] font-medium text-muted">최근 활동</h2>
        <button
          onClick={onActivity}
          className="flex items-center gap-0.5 pb-0.5 text-[11.5px] font-medium text-muted active:opacity-60"
        >
          전체 보기 <ChevronRight size={12} />
        </button>
      </div>

      <div className="mt-1">
        {recent.slice(0, 3).map((item, index) => (
          <TxRow
            key={item.signature}
            item={item}
            tokenSymbols={tokenSymbols}
            network={network}
            showBorder={index > 0}
          />
        ))}
        {recent.length === 0 && (
          <div className="px-5 py-2 text-[12px] leading-relaxed text-muted">
            {network === 'devnet'
              ? '이 Devnet 지갑에는 아직 거래가 없습니다.'
              : '아직 거래 내역이 없습니다.'}
          </div>
        )}
      </div>

      <div className="mt-8 px-5 pb-2 text-[11px] leading-[1.7] text-[#A9AFB9]">
        {network === 'devnet'
          ? 'Devnet은 테스트용 네트워크입니다. 실제 자산이 아닙니다.'
          : '잔액과 가격은 공개 RPC · 시세 API에서 실시간으로 가져옵니다.'}
      </div>
    </div>
  )
}
