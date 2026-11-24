import { useCallback, useEffect, useRef, useState } from 'react'
import type { Connection } from '@solana/web3.js'
import { fetchPortfolio, type Portfolio } from '../lib/tokens'
import { fetchHistory, type HistoryItem } from '../lib/tx'
import type { NetworkId } from '../lib/rpc'

export function usePortfolio(
  connection: Connection | null,
  address: string | null,
  network: NetworkId,
) {
  const [data, setData] = useState<Portfolio | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!connection || !address) return
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const result = await fetchPortfolio(connection, address, network)
      if (id === requestId.current && mounted.current) setData(result)
    } catch (err: any) {
      if (id === requestId.current && mounted.current) {
        setError(err?.message || '잔액을 불러오지 못했습니다.')
      }
    } finally {
      if (id === requestId.current && mounted.current) setLoading(false)
    }
  }, [connection, address, network])

  useEffect(() => {
    setData(null)
    void refresh()
  }, [refresh])

  return { data, loading, error, refresh }
}

export function useHistory(
  connection: Connection | null,
  address: string | null,
  network: NetworkId,
  enabled: boolean,
) {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    if (!connection || !address || !enabled) return
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const result = await fetchHistory(connection, address, 20)
      if (id === requestId.current) setItems(result)
    } catch (err: any) {
      if (id === requestId.current) setError(err?.message || '거래내역을 불러오지 못했습니다.')
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [connection, address, network, enabled])

  useEffect(() => {
    setItems([])
    void refresh()
  }, [refresh])

  return { items, loading, error, refresh }
}
