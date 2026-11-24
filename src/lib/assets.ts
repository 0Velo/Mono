/**
 * One list of "things you can hold" for every screen that needs it: the wallet
 * list, the send picker, the swap pair selector and token detail.
 */
import type { Portfolio, TokenHolding } from './tokens'

export interface Asset extends TokenHolding {
  /** Stable key: 'SOL' for the native asset, the mint otherwise. */
  key: string
  isSol?: boolean
}

export const SOL_ASSET_BASE: Omit<Asset, 'amount' | 'priceUsd' | 'valueUsd'> = {
  key: 'SOL',
  isSol: true,
  mint: 'SOL',
  symbol: 'SOL',
  name: 'Solana',
  decimals: 9,
}

export function buildAssets(portfolio: Portfolio | null): Asset[] {
  const sol: Asset = {
    ...SOL_ASSET_BASE,
    amount: portfolio ? BigInt(portfolio.solLamports) : 0n,
    priceUsd: portfolio?.solPriceUsd ?? null,
    valueUsd:
      portfolio && portfolio.solPriceUsd !== null
        ? (Number(portfolio.solLamports) / 1e9) * portfolio.solPriceUsd
        : null,
  }
  return [sol, ...(portfolio?.tokens ?? []).map((token) => ({ ...token, key: token.mint }))]
}

/** Jupiter speaks in mints; native SOL is wrapped SOL there. */
export function jupiterMint(asset: Asset | null): string {
  if (!asset) return ''
  return asset.isSol ? 'So11111111111111111111111111111111111111112' : asset.mint
}

export function assetByMint(assets: Asset[], mint: string | null): Asset | null {
  if (!mint) return assets[0] ?? null
  return assets.find((asset) => asset.key === mint || asset.mint === mint) ?? assets[0] ?? null
}
