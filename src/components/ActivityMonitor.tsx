import { useEffect, useMemo, useRef, useState } from 'react'
import type { Connection } from '@solana/web3.js'
import { useHistory } from '../hooks/useChainData'
import { fetchTokenAccountAddresses } from '../lib/tokens'
import { makeConnection } from '../lib/connection'
import {
  activityToastMessage,
  readSeenSignatures,
  selectNewActivity,
  showActivityNotification,
  writeSeenSignatures,
} from '../lib/activityNotifications'
import type { NetworkId } from '../lib/rpc'
import { showToast } from './Toast'

const TOKEN_ACCOUNT_REFRESH_MS = 30_000

/**
 * 입출금 알림을 만드는 감시자. 화면에는 아무것도 그리지 않고, 거래내역 조회
 * 결과에서 "처음 보는 서명"만 골라 OS 알림과 토스트로 알린다.
 *
 * 중복 방지: 알림을 띄우기 전에 본 서명 목록을 먼저 저장한다. 저장이 먼저라
 * 같은 항목이 다시 렌더되어도 두 번 알리지 못한다.
 */
export default function ActivityMonitor({
  address,
  network,
  rpc,
}: {
  address: string
  network: NetworkId
  rpc: string
}) {
  const connection = useMemo<Connection>(() => makeConnection(network, rpc), [network, rpc])
  const [accountsSnapshot, setAccountsSnapshot] = useState<{
    owner: string
    network: NetworkId
    rpc: string
    addresses: string[]
  } | null>(null)
  const watchedAddresses = accountsSnapshot?.owner === address &&
    accountsSnapshot.network === network && accountsSnapshot.rpc === rpc
    ? accountsSnapshot.addresses
    : []
  const history = useHistory(connection, address, network, true, watchedAddresses)
  // 같은 스냅샷을 두 번 처리하지 않도록 마지막으로 처리한 항목을 기억한다.
  const processed = useRef<{ scope: string; items: unknown } | null>(null)

  useEffect(() => {
    let cancelled = false
    const refreshTokenAddresses = async () => {
      try {
        const addresses = await fetchTokenAccountAddresses(connection, address, network)
        if (!cancelled) setAccountsSnapshot({ owner: address, network, rpc, addresses })
      } catch {
        // 토큰 계정 RPC가 막혀도 네이티브 SOL 감시는 계속된다.
      }
    }
    void refreshTokenAddresses()
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') void refreshTokenAddresses()
    }
    const timer = window.setInterval(refreshVisible, TOKEN_ACCOUNT_REFRESH_MS)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [connection, address, network])

  useEffect(() => {
    if (!history.ready || history.loading) return
    const scope = `${network}:${address}`
    if (processed.current?.scope === scope && processed.current.items === history.items) return

    const previous = readSeenSignatures(scope)
    const selection = selectNewActivity(previous, history.items)
    if (selection.baseline) {
      // 첫 실행: 지금 보이는 거래는 기준선으로만 기록하고 알리지 않는다.
      writeSeenSignatures(scope, selection.seen)
      processed.current = { scope, items: history.items }
      return
    }
    if (selection.events.length === 0) {
      processed.current = { scope, items: history.items }
      return
    }

    // 알림보다 기록이 먼저다. 여기서 실패해도 다음 조회가 기준선을 다시 만든다.
    writeSeenSignatures(scope, selection.seen)
    processed.current = { scope, items: history.items }
    for (const event of selection.events) {
      showToast(activityToastMessage(event.kind))
      void showActivityNotification(event, network)
    }
  }, [history.items, history.loading, history.ready, address, network])

  return null
}
