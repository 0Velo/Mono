import { useEffect, useMemo, useState } from 'react'
import type { Connection } from '@solana/web3.js'
import { useHistory } from '../hooks/useChainData'
import { fetchTokenAccountAddresses } from '../lib/tokens'
import { makeConnection } from '../lib/connection'
import {
  isIncomingDeposit,
  readSeenDepositSignatures,
  showDepositNotification,
  writeSeenDepositSignatures,
} from '../lib/depositNotifications'
import type { NetworkId } from '../lib/rpc'
import { showToast } from './Toast'

const TOKEN_ACCOUNT_REFRESH_MS = 30_000

export default function DepositMonitor({
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

  useEffect(() => {
    let cancelled = false
    const refreshTokenAddresses = async () => {
      try {
        const addresses = await fetchTokenAccountAddresses(connection, address, network)
        if (!cancelled) setAccountsSnapshot({ owner: address, network, rpc, addresses })
      } catch {
        // Native SOL monitoring continues even when token-account RPC is unavailable.
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
    const previous = readSeenDepositSignatures(scope)
    const detailed = history.items.filter((item) => item.detailed)
    if (previous === null) {
      // Establish a baseline on first use; do not announce old transactions.
      writeSeenDepositSignatures(scope, history.items.map((item) => item.signature))
      return
    }

    const seen = new Set(previous)
    const newlyDetailed = detailed.filter((item) => !seen.has(item.signature))
    for (const item of newlyDetailed) {
      if (isIncomingDeposit(item)) {
        showToast('새 입금이 확인됐습니다')
        void showDepositNotification(item, network)
      }
    }
    writeSeenDepositSignatures(scope, [...previous, ...detailed.map((item) => item.signature)])
  }, [history.items, history.loading, history.ready, address, network])

  return null
}
