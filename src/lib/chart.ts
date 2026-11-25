/**
 * Price history for the token chart.
 *
 * Sources, in order, all keyless:
 *   1. CoinGecko market chart (SOL by id, SPL tokens by contract address)
 *   2. Binance klines for SOL/USDT when CoinGecko is rate-limited
 *
 * Everything is wrapped: a blocked endpoint returns null and the chart simply
 * does not draw, rather than inventing a curve.
 */

export interface PriceSeries {
  points: number[]
  source: 'coingecko' | 'binance'
  /** Change over the window, in percent, when it can be derived. */
  changePct: number | null
}

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const cache = new Map<string, { at: number; value: PriceSeries | null }>()
const TTL = 3 * 60_000

async function fetchJson(url: string, timeoutMs = 8000): Promise<any | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function fromPrices(raw: unknown): PriceSeries | null {
  if (!Array.isArray(raw)) return null
  const points = raw
    .map((entry: any) => Number(entry?.[1]))
    .filter((value: number) => Number.isFinite(value) && value > 0)
  if (points.length < 4) return null
  const first = points[0]
  const last = points[points.length - 1]
  const changePct = first > 0 ? ((last - first) / first) * 100 : null
  return { points, source: 'coingecko', changePct }
}

/** `mint` is null for native SOL. */
export async function fetchPriceSeries(
  mint: string | null,
  days: 1 | 7 = 1,
  options: { force?: boolean } = {},
): Promise<PriceSeries | null> {
  const id = `${mint ?? 'SOL'}:${days}`
  const hit = cache.get(id)
  if (!options.force && hit && Date.now() - hit.at < TTL) return hit.value

  let series: PriceSeries | null = null

  if (!mint || mint === SOL_MINT || mint === 'SOL') {
    series = fromPrices(
      (await fetchJson(
        `https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=${days}`,
      ))?.prices,
    )
    if (!series) {
      const interval = days === 1 ? '1h' : '4h'
      const limit = days === 1 ? 24 : 42
      const klines = await fetchJson(
        `https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=${interval}&limit=${limit}`,
      )
      if (Array.isArray(klines) && klines.length > 3) {
        const points = klines
          .map((candle: any) => Number(candle?.[4]))
          .filter((value: number) => Number.isFinite(value) && value > 0)
        if (points.length > 3) {
          const changePct = ((points[points.length - 1] - points[0]) / points[0]) * 100
          series = { points, source: 'binance', changePct }
        }
      }
    }
  } else {
    series = fromPrices(
      (await fetchJson(
        `https://api.coingecko.com/api/v3/coins/solana/contract/${mint}/market_chart?vs_currency=usd&days=${days}`,
      ))?.prices,
    )
  }

  cache.set(id, { at: Date.now(), value: series })
  return series
}
