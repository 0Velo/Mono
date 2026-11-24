import { Connection, PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { fetchDexQuotes, fetchMarketSnapshot, fetchSolSparkline, type TokenQuote } from './prices'
import { fromBaseUnits } from './format'
import type { NetworkId } from './rpc'

export interface TokenHolding {
  mint: string
  symbol: string
  name: string
  decimals: number
  amount: bigint
  priceUsd: number | null
  valueUsd: number | null
  icon?: string
}

export interface Portfolio {
  owner: string
  solLamports: bigint
  solPriceUsd: number | null
  solChange24h: number | null
  solSparkline: number[] | null
  usdKrw: number
  tokens: TokenHolding[]
  totalUsd: number | null
  fetchedAt: number
  priceSource: string
  tokensUnavailable: boolean
}

/** Well known mints so common tokens render instantly without extra RPC calls. */
export const KNOWN_TOKENS: Record<string, { symbol: string; name: string; decimals: number }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', name: 'Tether USD', decimals: 6 },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: 'JUP', name: 'Jupiter', decimals: 6 },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: 'BONK', name: 'Bonk', decimals: 5 },
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': { symbol: 'RAY', name: 'Raydium', decimals: 6 },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: 'mSOL', name: 'Marinade staked SOL', decimals: 9 },
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: { symbol: 'bSOL', name: 'BlazeStake SOL', decimals: 9 },
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: { symbol: 'JTO', name: 'Jito', decimals: 9 },
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': { symbol: 'stSOL', name: 'Lido staked SOL', decimals: 9 },
  hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux: { symbol: 'HNT', name: 'Helium', decimals: 8 },
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': { symbol: 'PYUSD', name: 'PayPal USD', decimals: 6 },
}

const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const metadataCache = new Map<string, { symbol?: string; name?: string }>()

function readBorshString(data: Buffer, offset: number): { value: string; next: number } {
  if (offset + 4 > data.length) return { value: '', next: offset }
  const length = data.readUInt32LE(offset)
  const start = offset + 4
  const end = Math.min(start + length, data.length)
  const value = data.slice(start, end).toString('utf8').replace(/\u0000/g, '').trim()
  return { value, next: start + length }
}

/**
 * Reads the Metaplex metadata PDA so imported tokens show their real ticker.
 * Falls back silently — an unknown mint still renders with a shortened address.
 */
export async function fetchOnChainMetadata(
  connection: Connection,
  mint: string,
): Promise<{ symbol?: string; name?: string }> {
  if (metadataCache.has(mint)) return metadataCache.get(mint)!
  let result: { symbol?: string; name?: string } = {}
  try {
    const mintKey = new PublicKey(mint)
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mintKey.toBuffer()],
      METADATA_PROGRAM_ID,
    )
    const account = await connection.getAccountInfo(pda)
    if (account?.data) {
      const data = account.data as Buffer
      // key(1) + update_authority(32) + mint(32)
      let offset = 65
      const name = readBorshString(data, offset)
      offset = name.next
      const symbol = readBorshString(data, offset)
      result = {
        name: name.value || undefined,
        symbol: symbol.value || undefined,
      }
    }
  } catch {
    result = {}
  }
  metadataCache.set(mint, result)
  return result
}

interface RawTokenAccount {
  mint: string
  amount: bigint
  decimals: number
}

async function fetchTokenAccounts(
  connection: Connection,
  owner: PublicKey,
): Promise<{ accounts: RawTokenAccount[]; partial: boolean }> {
  const accounts: RawTokenAccount[] = []
  let partial = false

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const response = await connection.getParsedTokenAccountsByOwner(owner, { programId })
      for (const item of response.value) {
        const parsed = item.account.data
        if (!('parsed' in parsed)) continue
        const info = parsed.parsed?.info
        const amountRaw = info?.tokenAmount?.amount
        const decimals = info?.tokenAmount?.decimals
        if (!info?.mint || amountRaw === undefined || decimals === undefined) continue
        const amount = BigInt(amountRaw)
        if (amount === 0n) continue
        accounts.push({ mint: info.mint, amount, decimals })
      }
    } catch {
      partial = true
    }
  }

  return { accounts, partial }
}

export async function fetchPortfolio(
  connection: Connection,
  ownerAddress: string,
  network: NetworkId,
): Promise<Portfolio> {
  const owner = new PublicKey(ownerAddress)

  const [lamports, tokenData, market, sparkline] = await Promise.all([
    connection.getBalance(owner),
    fetchTokenAccounts(connection, owner),
    fetchMarketSnapshot(),
    fetchSolSparkline().catch(() => null),
  ])

  const mints = Array.from(new Set(tokenData.accounts.map((a) => a.mint)))
  // Devnet mints have no market pairs; skip the DEX lookup entirely.
  const quotes =
    network === 'mainnet'
      ? await fetchDexQuotes(mints).catch(() => ({}) as Record<string, TokenQuote>)
      : ({} as Record<string, TokenQuote>)

  const holdings: TokenHolding[] = await Promise.all(
    tokenData.accounts.map(async (account) => {
      const known = KNOWN_TOKENS[account.mint]
      const quote = quotes[account.mint]
      let symbol: string | undefined = known?.symbol ?? quote?.symbol
      let name: string | undefined = known?.name ?? quote?.name
      if (!symbol) {
        const meta = await fetchOnChainMetadata(connection, account.mint).catch(
          () => ({}) as { symbol?: string; name?: string },
        )
        symbol = meta.symbol
        name = meta.name
      }
      // Some mints carry a name but no symbol; showing the name beats a mint prefix.
      if (!quote?.symbol && !known?.symbol && name && (!symbol || symbol === account.mint.slice(0, 4).toUpperCase())) {
        symbol = name.length > 12 ? name.slice(0, 12) : name
      }
      const priceUsd = quote?.priceUsd ?? null
      const ui = Number(fromBaseUnits(account.amount, account.decimals))
      return {
        mint: account.mint,
        symbol: symbol || account.mint.slice(0, 4).toUpperCase(),
        name: name || 'Unknown token',
        decimals: account.decimals,
        amount: account.amount,
        priceUsd,
        valueUsd: priceUsd !== null ? priceUsd * ui : null,
        icon: quote?.icon,
      }
    }),
  )

  holdings.sort((a, b) => {
    const av = a.valueUsd ?? -1
    const bv = b.valueUsd ?? -1
    if (bv !== av) return bv - av
    return a.symbol.localeCompare(b.symbol)
  })

  const solUi = Number(lamports) / 1_000_000_000
  const solValue = market.solUsd !== null ? solUi * market.solUsd : null
  const tokenTotal = holdings.reduce((sum, token) => sum + (token.valueUsd ?? 0), 0)
  const totalUsd = solValue !== null ? solValue + tokenTotal : null

  const changeFromSeries =
    sparkline && sparkline.length > 1 && sparkline[0] > 0
      ? ((sparkline[sparkline.length - 1] - sparkline[0]) / sparkline[0]) * 100
      : null

  return {
    owner: ownerAddress,
    solLamports: BigInt(lamports),
    solPriceUsd: market.solUsd,
    solChange24h: market.change24h ?? changeFromSeries,
    solSparkline: sparkline,
    usdKrw: market.usdKrw,
    tokens: holdings,
    totalUsd,
    fetchedAt: Date.now(),
    priceSource: market.source,
    tokensUnavailable: tokenData.partial,
  }
}
