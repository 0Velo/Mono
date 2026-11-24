import { RefreshCw } from 'lucide-react'
import { TxRow, type TokenSymbolMap } from '../components/TxRow'
import { shortAddress } from '../lib/format'
import type { HistoryItem } from '../lib/tx'
import type { NetworkId } from '../lib/rpc'

interface ActivityProps {
  address: string
  network: NetworkId
  items: HistoryItem[]
  loading: boolean
  error: string | null
  tokenSymbols: TokenSymbolMap
  onRefresh: () => void
}

export function Activity({
  address,
  network,
  items,
  loading,
  error,
  tokenSymbols,
  onRefresh,
}: ActivityProps) {
  return (
    <div className="animate-fade flex flex-1 flex-col">
      <div
        className="flex items-end justify-between px-5 pb-4"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 22px)' }}
      >
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-[-0.035em] text-ink">활동</h1>
          <div className="mt-1 text-[11.5px] text-muted tnum">{shortAddress(address, 6)}</div>
        </div>
        <button
          onClick={onRefresh}
          aria-label="새로고침"
          className="press flex h-9 w-9 items-center justify-center rounded-full bg-surface text-ink"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin-slow' : ''} />
        </button>
      </div>

      {error && (
        <div className="mx-5 mb-1 rounded-[14px] bg-dangerSoft px-3.5 py-2.5 text-[12px] leading-snug text-danger">
          {error}
        </div>
      )}

      {items.length === 0 && !loading && (
        <div className="flex flex-1 flex-col items-center justify-center px-10 pb-28 text-center">
          <div className="text-[14px] font-semibold text-ink">아직 거래 내역이 없습니다</div>
          <div className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
            SOL을 받거나 보내면 여기에 기록됩니다.
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="mt-1">
          {items.map((item, index) => (
            <div
              key={item.signature}
              className="animate-rise"
              style={{ animationDelay: `${Math.min(index * 22, 200)}ms` }}
            >
              <TxRow
                item={item}
                tokenSymbols={tokenSymbols}
                network={network}
                showBorder={index > 0}
              />
            </div>
          ))}
        </div>
      )}

      {items.length === 0 && loading && (
        <div className="space-y-5 px-5 py-4">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3.5">
              <div className="skeleton h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-3 w-24 rounded" />
                <div className="skeleton h-2.5 w-16 rounded" />
              </div>
            </div>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <div className="mt-4 px-5 text-[11px] leading-relaxed text-faint">
          항목을 누르면 Solscan에서 확인할 수 있습니다.
        </div>
      )}
    </div>
  )
}
