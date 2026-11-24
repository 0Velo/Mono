import { ArrowDownLeft } from 'lucide-react'
import { TokenIcon } from './ui'
import { cx, formatTxAmount, relativeTime, shortAddress } from '../lib/format'
import { KNOWN_TOKENS } from '../lib/tokens'
import type { HistoryItem } from '../lib/tx'
import { explorerTx, type NetworkId } from '../lib/rpc'

export interface TokenSymbolMap {
  [mint: string]: { symbol: string; decimals: number; icon?: string }
}

export function txSummary(item: HistoryItem, tokenSymbols: TokenSymbolMap) {
  const token = item.tokenDeltas[0]
  const solOnly = !token && item.solDelta === 0
  const unknown = !item.detailed || solOnly
  const tokenMeta = token ? tokenSymbols[token.mint] : undefined
  const known = token ? KNOWN_TOKENS[token.mint] : undefined
  const symbol = tokenMeta?.symbol ?? known?.symbol ?? (token ? token.mint.slice(0, 4) : '')
  const incoming = token ? BigInt(token.amount) > 0n : item.solDelta > 0
  const raw = token ? BigInt(token.amount) : BigInt(item.solDelta)
  const abs = raw < 0n ? -raw : raw
  return {
    token,
    tokenMeta,
    symbol,
    incoming,
    ticker: token ? symbol || 'TOKEN' : 'SOL',
    abs,
    decimals: token?.decimals ?? 9,
    unknown,
  }
}

export function TxRow({
  item,
  tokenSymbols,
  network,
  showBorder,
}: {
  item: HistoryItem
  tokenSymbols: TokenSymbolMap
  network: NetworkId
  showBorder?: boolean
}) {
  const { token, tokenMeta, symbol, incoming, ticker, abs, decimals, unknown } = txSummary(
    item,
    tokenSymbols,
  )

  return (
    <button
      onClick={() => window.open(explorerTx(item.signature, network), '_blank', 'noopener')}
      className={cx(
        'press flex w-full items-center gap-3.5 px-5 py-[13px] text-left active:bg-[#FAFBFC]',
        showBorder && 'border-t border-line',
      )}
    >
      {token ? (
        <TokenIcon symbol={symbol || 'TKN'} icon={tokenMeta?.icon} size={40} />
      ) : incoming ? (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-mintSoft text-mint">
          <ArrowDownLeft size={18} strokeWidth={2} />
        </div>
      ) : (
        <TokenIcon symbol="SOL" size={40} />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[14.5px] font-semibold tracking-[-0.02em] text-ink">
          {item.failed
            ? '실패한 거래'
            : unknown
              ? '거래'
              : incoming
                ? `${ticker} 받음`
                : `${ticker} 보냄`}
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-muted">
          <span>{relativeTime(item.blockTime)}</span>
          <span className="text-[#D6DAE0]">·</span>
          <span className="tnum">{shortAddress(item.signature, 4)}</span>
        </div>
      </div>
      <div className="text-right">
        <div
          className={cx(
            'tnum text-[14px] font-semibold tracking-[-0.02em]',
            item.failed ? 'text-[#BFC5CD] line-through' : incoming ? 'text-mint' : 'text-ink',
          )}
        >
          {unknown ? '—' : `${incoming ? '+' : '−'}${formatTxAmount(abs, decimals)} ${ticker}`}
        </div>
        <div className="mt-0.5 text-[11px] text-muted">{item.failed ? '실패' : '확인됨'}</div>
      </div>
    </button>
  )
}
