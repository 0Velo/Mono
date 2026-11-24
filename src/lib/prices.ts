/**
 * Keyless public price sources, in fallback order:
 *   1. CoinGecko simple price (SOL in USD + KRW in a single call)
 *   2. Binance ticker (SOLUSDT) + open.er-api.com for USD→KRW
 *   3. DexScreener per-token liquidity pairs
 * Every call is wrapped so a blocked / rate-limited endpoint degrades to "—"
 * instead of breaking the wallet screen.
 */

const FALLBACK_USD_KRW = 1390

async function fetchJson(url: string, timeoutMs = 8000): Promise<any | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface MarketSnapshot {
  solUsd: number | null
  usdKrw: number
  source: string
  change24h: number | null
}

export async function fetchMarketSnapshot(): Promise<MarketSnapshot> {
  const cg = await fetchJson(
    'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,krw&include_24hr_change=true',
  )
  const solUsdCg = Number(cg?.solana?.usd)
  const solKrwCg = Number(cg?.solana?.krw)
  const changeCg = Number(cg?.solana?.usd_24h_change)
  const change24h = Number.isFinite(changeCg) ? changeCg : null
  if (Number.isFinite(solUsdCg) && solUsdCg > 0) {
    const fx =
      Number.isFinite(solKrwCg) && solKrwCg > 0 && solUsdCg > 0 ? solKrwCg / solUsdCg : FALLBACK_USD_KRW
    return { solUsd: solUsdCg, usdKrw: fx, source: 'coingecko', change24h }
  }

  let solUsd: number | null = null
  const binance = await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT')
  const binancePrice = Number(binance?.price)
  if (Number.isFinite(binancePrice) && binancePrice > 0) solUsd = binancePrice

  let usdKrw = FALLBACK_USD_KRW
  const fx = await fetchJson('https://open.er-api.com/v6/latest/USD')
  const krw = Number(fx?.rates?.KRW)
  if (Number.isFinite(krw) && krw > 500) usdKrw = krw

  return { solUsd, usdKrw, source: solUsd ? 'binance' : 'fallback', change24h }
}

let sparkCache: { at: number; data: number[] } | null = null

/**
 * Last 24h of SOL/USD, one point per CoinGecko sample. Cached for five minutes
 * so screen refreshes do not hammer the keyless endpoint. Returns null when no
 * source answers — the UI then simply draws no curve rather than invent one.
 */
export async function fetchSolSparkline(): Promise<number[] | null> {
  if (sparkCache && Date.now() - sparkCache.at < 5 * 60_000) return sparkCache.data

  let series: number[] | null = null
  const cg = await fetchJson(
    'https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=1',
    7000,
  )
  const prices = cg?.prices
  if (Array.isArray(prices) && prices.length > 5) {
    const parsed = prices
      .map((point: any) => Number(point?.[1]))
      .filter((value: number) => Number.isFinite(value))
    if (parsed.length > 5) series = parsed
  }

  if (!series) {
    const klines = await fetchJson(
      'https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1h&limit=24',
      7000,
    )
    if (Array.isArray(klines) && klines.length > 3) {
      const parsed = klines
        .map((candle: any) => Number(candle?.[4]))
        .filter((value: number) => Number.isFinite(value))
      if (parsed.length > 3) series = parsed
    }
  }

  if (series) {
    sparkCache = { at: Date.now(), data: series }
    return series
  }
  return null
}

export interface TokenQuote {
  priceUsd: number | null
  icon?: string
  liquidity?: number
  symbol?: string
  name?: string
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** DexScreener returns price + hosted logo for any token that has a live pair. */
export async function fetchDexQuotes(mints: string[]): Promise<Record<string, TokenQuote>> {
  const result: Record<string, TokenQuote> = {}
  if (mints.length === 0) return result

  const chunks = chunk(mints, 25)
  for (const group of chunks) {
    const data = await fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${group.join(',')}`,
      9000,
    )
    const pairs: any[] = Array.isArray(data?.pairs) ? data.pairs : []
    for (const pair of pairs) {
      const address: string | undefined = pair?.baseToken?.address
      if (!address) continue
      const liquidity = Number(pair?.liquidity?.usd ?? 0)
      const previous = result[address]
      if (previous && (previous.liquidity ?? 0) >= liquidity) continue
      const price = Number(pair?.priceUsd)
      result[address] = {
        priceUsd: Number.isFinite(price) ? price : null,
        icon: typeof pair?.info?.imageUrl === 'string' ? pair.info.imageUrl : undefined,
        liquidity,
        symbol: pair?.baseToken?.symbol,
        name: pair?.baseToken?.name,
      }
    }
  }
  return result
}
