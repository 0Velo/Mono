import { useCallback, useEffect, useRef, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import type { Connection } from '@solana/web3.js'
import { fetchPortfolio, type Portfolio } from '../lib/tokens'
import { fetchHistory, type HistoryItem } from '../lib/tx'
import type { NetworkId } from '../lib/rpc'

const PORTFOLIO_POLL_MS = 30_000
const HISTORY_POLL_MS = 20_000

interface Scope<T> {
  connection: Connection | null
  address: string | null
  network: NetworkId
  value: T
}

function matchesScope<T>(scope: Scope<T> | null, connection: Connection | null, address: string | null, network: NetworkId) {
  return Boolean(scope && scope.connection === connection && scope.address === address && scope.network === network)
}

function visibleNow() {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

export function usePortfolio(
  connection: Connection | null,
  address: string | null,
  network: NetworkId,
) {
  const [snapshot, setSnapshot] = useState<Scope<Portfolio> | null>(null)
  const [loadingScope, setLoadingScope] = useState<Scope<null> | null>(null)
  const [errorScope, setErrorScope] = useState<Scope<string> | null>(null)
  const requestId = useRef(0)
  const currentSnapshot = matchesScope(snapshot, connection, address, network) ? snapshot : null

  const refresh = useCallback(async () => {
    if (!connection || !address) return
    const id = ++requestId.current
    setLoadingScope({ connection, address, network, value: null })
    setErrorScope(null)
    try {
      const result = await fetchPortfolio(connection, address, network)
      if (id === requestId.current) setSnapshot({ connection, address, network, value: result })
    } catch (err: any) {
      if (id === requestId.current) {
        setErrorScope({
          connection,
          address,
          network,
          value: err?.message || '잔액을 불러오지 못했습니다.',
        })
      }
    } finally {
      if (id === requestId.current) setLoadingScope(null)
    }
  }, [connection, address, network])

  useEffect(() => {
    if (!connection || !address) return
    void refresh()
    const refreshVisible = () => {
      if (visibleNow()) void refresh()
    }
    const timer = window.setInterval(refreshVisible, PORTFOLIO_POLL_MS)
    document.addEventListener('visibilitychange', refreshVisible)
    window.addEventListener('focus', refreshVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshVisible)
      window.removeEventListener('focus', refreshVisible)
      requestId.current += 1
    }
  }, [connection, address, network, refresh])

  const tokenAddresses = currentSnapshot?.value.tokenAccountAddresses ?? []
  const subscriptionKey = Array.from(new Set([address, ...tokenAddresses].filter(Boolean))).join('|')

  useEffect(() => {
    if (!connection || !address) return
    let cancelled = false
    const ids: number[] = []
    const subscribe = async (target: string) => {
      try {
        const id = await connection.onAccountChange(
          new PublicKey(target),
          () => void refresh(),
          'confirmed',
        )
        if (cancelled) {
          void connection.removeAccountChangeListener(id).catch(() => {})
        } else {
          ids.push(id)
        }
      } catch {
        // Public RPCs may disable WebSocket subscriptions; polling remains active.
      }
    }
    for (const target of subscriptionKey.split('|').filter(Boolean)) void subscribe(target)
    return () => {
      cancelled = true
      for (const id of ids) void connection.removeAccountChangeListener(id).catch(() => {})
    }
  }, [connection, address, network, refresh, subscriptionKey])

  const loading = Boolean(
    loadingScope && matchesScope(loadingScope, connection, address, network),
  )
  const error = errorScope && matchesScope(errorScope, connection, address, network)
    ? errorScope.value
    : null

  return { data: currentSnapshot?.value ?? null, loading, error, refresh }
}

export function useHistory(
  connection: Connection | null,
  address: string | null,
  network: NetworkId,
  enabled: boolean,
  watchedAddresses: string[] = [],
) {
  const [snapshot, setSnapshot] = useState<Scope<HistoryItem[]> | null>(null)
  const [loadingScope, setLoadingScope] = useState<Scope<null> | null>(null)
  const [errorScope, setErrorScope] = useState<Scope<string> | null>(null)
  const requestId = useRef(0)
  const currentSnapshot = matchesScope(snapshot, connection, address, network) ? snapshot : null
  const watchedKey = Array.from(new Set(watchedAddresses.filter(Boolean))).join('|')

  const refresh = useCallback(async () => {
    if (!connection || !address || !enabled) return
    const id = ++requestId.current
    setLoadingScope({ connection, address, network, value: null })
    setErrorScope(null)
    try {
      const result = await fetchHistory(
        connection,
        address,
        20,
        watchedKey ? watchedKey.split('|') : [],
      )
      if (id === requestId.current) setSnapshot({ connection, address, network, value: result })
    } catch (err: any) {
      if (id === requestId.current) {
        setErrorScope({
          connection,
          address,
          network,
          value: err?.message || '거래내역을 불러오지 못했습니다.',
        })
      }
    } finally {
      if (id === requestId.current) setLoadingScope(null)
    }
  }, [connection, address, network, enabled, watchedKey])

  useEffect(() => {
    if (!connection || !address || !enabled) return
    void refresh()
    const refreshVisible = () => {
      if (visibleNow()) void refresh()
    }
    const timer = window.setInterval(refreshVisible, HISTORY_POLL_MS)
    document.addEventListener('visibilitychange', refreshVisible)
    window.addEventListener('focus', refreshVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshVisible)
      window.removeEventListener('focus', refreshVisible)
      requestId.current += 1
    }
  }, [connection, address, network, enabled, watchedKey, refresh])

  const subscriptionsKey = Array.from(new Set([address, ...watchedKey.split('|')].filter(Boolean))).join('|')
  useEffect(() => {
    if (!connection || !address || !enabled) return
    let cancelled = false
    const ids: number[] = []
    const subscribe = async (target: string) => {
      try {
        const id = await connection.onLogs(
          new PublicKey(target),
          () => void refresh(),
          'confirmed',
        )
        if (cancelled) {
          void connection.removeOnLogsListener(id).catch(() => {})
        } else {
          ids.push(id)
        }
      } catch {
        // Use the bounded polling fallback if the RPC has no WebSocket support.
      }
    }
    for (const target of subscriptionsKey.split('|').filter(Boolean)) void subscribe(target)
    return () => {
      cancelled = true
      for (const id of ids) void connection.removeOnLogsListener(id).catch(() => {})
    }
  }, [connection, address, network, enabled, refresh, subscriptionsKey])

  const loading = Boolean(
    loadingScope && matchesScope(loadingScope, connection, address, network),
  )
  const error = errorScope && matchesScope(errorScope, connection, address, network)
    ? errorScope.value
    : null

  return {
    items: currentSnapshot?.value ?? [],
    loading,
    error,
    ready: Boolean(currentSnapshot),
    refresh,
  }
}
