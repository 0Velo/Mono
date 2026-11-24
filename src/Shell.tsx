import { useMemo, useState } from 'react'
import { History, Settings2, Wallet } from 'lucide-react'
import { useWallet } from './state/WalletProvider'
import { Home } from './screens/Home'
import { Activity } from './screens/Activity'
import { Settings } from './screens/Settings'
import { SendSheet } from './sheets/SendSheet'
import { ReceiveSheet } from './sheets/ReceiveSheet'
import { BackupSheet } from './sheets/BackupSheet'
import { ResetSheet } from './sheets/ResetSheet'
import { ToastHost } from './components/Toast'
import { usePortfolio, useHistory } from './hooks/useChainData'
import { makeConnection } from './lib/connection'
import type { NetworkId } from './lib/rpc'
import { cx } from './lib/format'

type Tab = 'wallet' | 'activity' | 'settings'
type SheetState =
  | { type: 'send'; mint: string | null }
  | { type: 'receive' }
  | { type: 'backup' }
  | { type: 'reset' }
  | null

const TABS: Array<{ key: Tab; label: string; icon: typeof Wallet }> = [
  { key: 'wallet', label: '지갑', icon: Wallet },
  { key: 'activity', label: '활동', icon: History },
  { key: 'settings', label: '설정', icon: Settings2 },
]

export default function Shell() {
  const { meta, keypair, lock, updateMeta, resetWallet } = useWallet()
  const [tab, setTab] = useState<Tab>('wallet')
  const [sheet, setSheet] = useState<SheetState>(null)

  const network: NetworkId = meta?.network ?? 'mainnet'
  const connection = useMemo(
    () => makeConnection(network, meta?.rpc?.[network] ?? ''),
    [network, meta?.rpc?.[network]],
  )

  const portfolio = usePortfolio(connection, meta?.address ?? null, network)
  const history = useHistory(connection, meta?.address ?? null, network, Boolean(meta?.address))

  if (!meta) {
    return (
      <div className="mx-auto flex min-h-full max-w-[430px] flex-col items-center justify-center gap-4 bg-white px-8">
        <p className="text-center text-[13px] leading-relaxed text-muted">
          지갑 메타데이터를 찾을 수 없습니다. 초기화 후 다시 불러와 주세요.
        </p>
        <button
          onClick={resetWallet}
          className="press rounded-full bg-surface px-4 py-2.5 text-[13px] font-semibold text-ink"
        >
          초기화
        </button>
      </div>
    )
  }

  const tokenSymbols = Object.fromEntries(
    (portfolio.data?.tokens ?? []).map((token) => [
      token.mint,
      { symbol: token.symbol, decimals: token.decimals, icon: token.icon },
    ]),
  )

  const selectTab = (next: Tab) => {
    if (next === tab) {
      if (next === 'activity') void history.refresh()
      return
    }
    setTab(next)
    if (next === 'activity') void history.refresh()
  }

  return (
    <div className="relative mx-auto flex min-h-full w-full max-w-[430px] flex-col bg-base">
      <div className="flex flex-1 flex-col pb-[86px]">
        <div key={tab} className="animate-tab flex flex-1 flex-col">
          {tab === 'wallet' && (
            <Home
              address={meta.address}
              network={network}
              portfolio={portfolio.data}
              loading={portfolio.loading}
              error={portfolio.error}
              recent={history.items}
              tokenSymbols={tokenSymbols}
              onRefresh={() => {
                void portfolio.refresh()
                void history.refresh()
              }}
              onSend={(mint) => setSheet({ type: 'send', mint })}
              onReceive={() => setSheet({ type: 'receive' })}
              onActivity={() => selectTab('activity')}
              onSettings={() => selectTab('settings')}
              onNetworkChange={(next) => {
                // The connection is rebuilt for the new network, which already
                // refetches the portfolio and history.
                updateMeta({ network: next })
              }}
            />
          )}
          {tab === 'activity' && (
            <Activity
              address={meta.address}
              network={network}
              items={history.items}
              loading={history.loading}
              error={history.error}
              tokenSymbols={tokenSymbols}
              onRefresh={() => void history.refresh()}
            />
          )}
          {tab === 'settings' && (
            <Settings
              meta={meta}
              onChangeNetwork={(next) => {
                updateMeta({ network: next })
              }}
              onSaveRpc={(target, value) => {
                updateMeta({ rpc: { ...meta.rpc, [target]: value } })
              }}
              onAutoLockChange={(minutes) => updateMeta({ autoLockMinutes: minutes })}
              onBackup={() => setSheet({ type: 'backup' })}
              onReset={() => setSheet({ type: 'reset' })}
              onLock={lock}
            />
          )}
        </div>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-[430px] border-t border-line bg-white/95 backdrop-blur-xl">
        <div className="safe-bottom flex items-stretch px-3">
          {TABS.map((item) => {
            const active = tab === item.key
            return (
              <button
                key={item.key}
                onClick={() => selectTab(item.key)}
                aria-current={active ? 'page' : undefined}
                className="press flex flex-1 flex-col items-center gap-[5px] pb-2 pt-2.5"
              >
                <item.icon
                  size={21}
                  strokeWidth={active ? 2.1 : 1.7}
                  className={cx(
                    'transition-transform duration-200',
                    active ? 'scale-105 text-ink' : 'text-[#B3BAC4]',
                  )}
                />
                <span
                  className={cx(
                    'text-[10.5px] tracking-[-0.01em] transition-colors',
                    active ? 'font-semibold text-ink' : 'font-medium text-[#B3BAC4]',
                  )}
                >
                  {item.label}
                </span>
              </button>
            )
          })}
        </div>
      </nav>

      <SendSheet
        open={sheet?.type === 'send'}
        initialMint={sheet?.type === 'send' ? sheet.mint : null}
        onClose={() => setSheet(null)}
        portfolio={portfolio.data}
        connection={connection}
        keypair={keypair}
        network={network}
        onSent={() => {
          void portfolio.refresh()
          void history.refresh()
        }}
      />
      <ReceiveSheet
        open={sheet?.type === 'receive'}
        onClose={() => setSheet(null)}
        address={meta.address}
        network={network}
      />
      <BackupSheet open={sheet?.type === 'backup'} onClose={() => setSheet(null)} />
      <ResetSheet open={sheet?.type === 'reset'} onClose={() => setSheet(null)} />
      <ToastHost />
    </div>
  )
}
