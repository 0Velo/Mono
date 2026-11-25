import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, History, Settings2, Wallet } from 'lucide-react'
import { useWallet } from './state/WalletProvider'
import { Home } from './screens/Home'
import { Activity } from './screens/Activity'
import { Settings } from './screens/Settings'
import { SendSheet } from './sheets/SendSheet'
import { ReceiveSheet } from './sheets/ReceiveSheet'
import { BackupSheet } from './sheets/BackupSheet'
import { ResetSheet } from './sheets/ResetSheet'
import { AccountsSheet } from './sheets/AccountsSheet'
import { AddressBookSheet } from './sheets/AddressBookSheet'
import { showToast, ToastHost } from './components/Toast'
import { Spinner } from './components/Spinner'
import { usePortfolio, useHistory } from './hooks/useChainData'
import { makeConnection } from './lib/connection'
import { buildAssets } from './lib/assets'
import type { NetworkId } from './lib/rpc'
import { cx } from './lib/format'
import {
  ACTIVITY_NOTIFICATION_SETTING_EVENT,
  disableActivityNotifications,
  enableActivityNotifications,
  isActivityNotificationsEnabled,
  needsHomeScreenInstall,
  notificationPermission,
  type NotificationPermissionState,
} from './lib/activityNotifications'
import {
  disableRemotePush,
  enableRemotePush,
  getPushUiState,
  prepareRemotePush,
  syncExistingPushAssociation,
  type PushUiState,
} from './lib/pushSubscriptions'

/**
 * Three of the four screens are cheap; swap and token detail carry the Jupiter
 * client and the chart, so they are own chunks that are only fetched the first
 * time someone opens them. Unlocking the wallet never waits on them.
 */
const Swap = lazy(() => import('./screens/Swap'))
const TokenDetailSheet = lazy(() => import('./sheets/TokenDetailSheet'))

type Tab = 'wallet' | 'swap' | 'activity' | 'settings'

type SheetState =
  | { type: 'send'; mint: string | null }
  | { type: 'receive' }
  | { type: 'backup' }
  | { type: 'reset' }
  | { type: 'accounts' }
  | { type: 'addressBook' }
  | { type: 'token'; key: string }
  | null

const TABS: Array<{ key: Tab; label: string; icon: typeof Wallet }> = [
  { key: 'wallet', label: '지갑', icon: Wallet },
  { key: 'swap', label: '스왑', icon: ArrowLeftRight },
  { key: 'activity', label: '활동', icon: History },
  { key: 'settings', label: '설정', icon: Settings2 },
]

function TabFallback() {
  return (
    <div className="flex flex-1 items-center justify-center py-24">
      <Spinner size={22} className="text-muted" />
    </div>
  )
}

interface ActivityAlertState {
  enabled: boolean
  permission: NotificationPermissionState
}

/** 토글의 실제 상태는 저장된 선호 + 브라우저 권한 둘 다에서 나온다. */
function readActivityAlerts(): ActivityAlertState {
  return {
    enabled: isActivityNotificationsEnabled(),
    permission: notificationPermission(),
  }
}

export default function Shell() {
  const { meta, keypair, activeAccount, lock, updateMeta, resetWallet } = useWallet()
  const [tab, setTab] = useState<Tab>('wallet')
  const [sheet, setSheet] = useState<SheetState>(null)
  const [activityAlerts, setActivityAlerts] = useState(() => readActivityAlerts())
  const [pushUiState, setPushUiState] = useState<PushUiState>(getPushUiState)
  const [pushIdentityRef] = useState(() => ({ address: '', network: 'mainnet' as NetworkId, generation: 0 }))
  // Which token the swap screen should start from when opened from detail.
  const [swapSeed, setSwapSeed] = useState<string | null>(null)

  const network: NetworkId = meta?.network ?? 'mainnet'
  const connection = useMemo(
    () => makeConnection(network, meta?.rpc?.[network] ?? ''),
    [network, meta?.rpc?.[network]],
  )

  const portfolio = usePortfolio(connection, meta?.address ?? null, network)
  const watchedAddresses = portfolio.data && portfolio.data.owner === meta?.address
    ? portfolio.data.tokenAccountAddresses
    : []
  const history = useHistory(connection, meta?.address ?? null, network, Boolean(meta?.address), watchedAddresses)
  const assets = useMemo(() => buildAssets(portfolio.data), [portfolio.data])

  pushIdentityRef.address = meta?.address ?? ''
  pushIdentityRef.network = network

  useEffect(() => {
    const sync = () => setActivityAlerts(readActivityAlerts())
    window.addEventListener(ACTIVITY_NOTIFICATION_SETTING_EVENT, sync)
    window.addEventListener('focus', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener(ACTIVITY_NOTIFICATION_SETTING_EVENT, sync)
      window.removeEventListener('focus', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void prepareRemotePush().then(() => {
      if (!cancelled) setPushUiState(getPushUiState())
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const generation = ++pushIdentityRef.generation
    if (!keypair || !meta?.address) {
      setPushUiState(getPushUiState())
      return
    }
    const isCurrent = () =>
      pushIdentityRef.generation === generation &&
      pushIdentityRef.address === meta.address &&
      pushIdentityRef.network === network
    void syncExistingPushAssociation(meta.address, network, keypair, isCurrent).then(() => {
      if (isCurrent()) setPushUiState(getPushUiState())
    })
    return () => {
      if (pushIdentityRef.generation === generation) pushIdentityRef.generation += 1
    }
  }, [keypair, meta?.address, network])

  if (!meta) {
    return (
      <div className="mx-auto flex min-h-full max-w-[430px] flex-col items-center justify-center gap-4 bg-base px-8">
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

  const openSwap = (mint: string | null) => {
    setSwapSeed(mint)
    setSheet(null)
    setTab('swap')
  }

  const toggleActivityAlerts = async () => {
    if (activityAlerts.enabled) {
      disableActivityNotifications()
      setActivityAlerts(readActivityAlerts())
      showToast('입출금 알림을 껐습니다')
      return
    }
    if (needsHomeScreenInstall()) {
      showToast('홈 화면에 추가한 앱에서 알림을 켤 수 있습니다')
      return
    }
    const result = await enableActivityNotifications()
    setActivityAlerts(readActivityAlerts())
    if (result === 'enabled') showToast('입출금 알림을 켰습니다')
    else if (result === 'unsupported') showToast('이 브라우저는 웹 알림을 지원하지 않습니다')
    else showToast('브라우저 알림 권한을 허용해 주세요')
  }

  const toggleRemotePush = async () => {
    if (pushUiState === 'enabled' || pushUiState === 'enabled-unavailable' || pushUiState === 'revoke-failed') {
      setPushUiState('disabled')
      const result = await disableRemotePush()
      setPushUiState(getPushUiState())
      if (result.remoteRevoked && result.localUnsubscribed) showToast('백그라운드 푸시를 해제했습니다')
      else if (!result.localUnsubscribed) showToast('기기 구독 해제에 실패했습니다. 브라우저 설정을 확인해 주세요')
      else showToast('기기 푸시는 중지했지만 서버 해제에 실패했습니다. 원격 푸시가 남을 수 있어 다시 시도해 주세요')
      return
    }
    try {
      const generation = pushIdentityRef.generation
      const isCurrent = () =>
        pushIdentityRef.generation === generation &&
        pushIdentityRef.address === meta.address &&
        pushIdentityRef.network === network
      await enableRemotePush(meta.address, network, keypair, isCurrent)
      setPushUiState(getPushUiState())
      showToast('백그라운드 푸시를 설정했습니다')
    } catch (error) {
      setPushUiState(getPushUiState())
      showToast((error as Error)?.message ?? '백그라운드 푸시를 설정하지 못했습니다')
    }
  }

  const selectTab = (next: Tab) => {
    if (next === tab) {
      if (next === 'activity') void history.refresh()
      if (next === 'wallet') void portfolio.refresh()
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
              accountName={activeAccount?.name ?? meta.name}
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
              onAccounts={() => setSheet({ type: 'accounts' })}
              onToken={(key) => setSheet({ type: 'token', key })}
              onSwap={() => openSwap(null)}
              onNetworkChange={(next) => {
                // The connection is rebuilt for the new network, which already
                // refetches the portfolio and history.
                updateMeta({ network: next })
              }}
            />
          )}

          {tab === 'swap' && (
            <Suspense fallback={<TabFallback />}>
              <Swap
                portfolio={portfolio.data}
                connection={connection}
                keypair={keypair}
                network={network}
                initialMint={swapSeed}
                onDone={() => {
                  void portfolio.refresh()
                  void history.refresh()
                }}
                onOpenReceive={() => setSheet({ type: 'receive' })}
              />
            </Suspense>
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
              onAddressBook={() => setSheet({ type: 'addressBook' })}
              onAccounts={() => setSheet({ type: 'accounts' })}
              activityNotificationsEnabled={activityAlerts.enabled}
              notificationPermission={activityAlerts.permission}
              onToggleActivityNotifications={toggleActivityAlerts}
              pushUiState={pushUiState}
              onToggleRemotePush={toggleRemotePush}
            />
          )}
        </div>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-[430px] border-t border-line bg-card/95 backdrop-blur-xl">
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
                    active ? 'scale-105 text-ink' : 'text-faint2',
                  )}
                />
                <span
                  className={cx(
                    'text-[10.5px] tracking-[-0.01em] transition-colors',
                    active ? 'font-semibold text-ink' : 'font-medium text-faint2',
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
      <AccountsSheet
        open={sheet?.type === 'accounts'}
        onClose={() => setSheet(null)}
      />
      <AddressBookSheet open={sheet?.type === 'addressBook'} onClose={() => setSheet(null)} />

      {sheet?.type === 'token' && (
        <Suspense fallback={null}>
          <TokenDetailSheet
            open
            assetKey={sheet.key}
            assets={assets}
            connection={connection}
            network={network}
            ownerAddress={meta.address}
            portfolioReady={Boolean(portfolio.data)}
            historyItems={history.items}
            historyLoading={history.loading}
            historyError={history.error}
            tokenSymbols={tokenSymbols}
            onRefreshHistory={() => void history.refresh()}
            onClose={() => setSheet(null)}
            onSend={(mint) => setSheet({ type: 'send', mint })}
            onSwap={(mint) => openSwap(mint)}
          />
        </Suspense>
      )}

      <ToastHost />
    </div>
  )
}
