/**
 * Jupiter swap — quote and transaction building.
 *
 * Keyless public endpoints only. Jupiter has moved its hosted API around, so
 * the module keeps an ordered list of base URLs and remembers whichever one
 * answered; a 4xx from the first never blocks the second. Nothing here signs:
 * the caller signs the returned versioned transaction with the in-memory
 * keypair, so the secret never leaves the page.
 */

export const WSOL_MINT = 'So11111111111111111111111111111111111111112'
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

/** Ordered fallbacks: the lite host first, the legacy v6 host second. */
const BASES = ['https://lite-api.jup.ag/swap/v1', 'https://quote-api.jup.ag/v6']

let preferredBase: string | null = null

export interface SwapQuote {
  raw: any
  base: string
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  otherAmountThreshold: string
  /** Percent, as a number (0.12 means 0.12%). */
  priceImpactPct: number
  slippageBps: number
  route: string[]
}

export interface QuoteParams {
  inputMint: string
  outputMint: string
  /** Base units of the input mint, as a decimal string. */
  amount: string
  slippageBps: number
}

function orderedBases(): string[] {
  if (!preferredBase) return BASES
  return [preferredBase, ...BASES.filter((base) => base !== preferredBase)]
}

async function requestJson(url: string, init?: RequestInit, timeoutMs = 12000): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    })
    const text = await response.text()
    let body: any = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!response.ok) {
      const detail =
        body?.errorMessage ?? body?.error ?? body?.message ?? `HTTP ${response.status}`
      throw new Error(String(detail))
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchSwapQuote(params: QuoteParams): Promise<SwapQuote> {
  const search = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: String(params.slippageBps),
    restrictIntermediateTokens: 'true',
  })

  let lastError: unknown = null
  for (const base of orderedBases()) {
    try {
      const body = await requestJson(`${base}/quote?${search.toString()}`)
      if (!body?.outAmount) throw new Error('견적을 받지 못했습니다.')
      preferredBase = base
      const impact = Number(body.priceImpactPct)
      const route: string[] = Array.isArray(body.routePlan)
        ? body.routePlan
            .map((step: any) => step?.swapInfo?.label)
            .filter((label: unknown): label is string => typeof label === 'string')
        : []
      return {
        raw: body,
        base,
        inputMint: String(body.inputMint ?? params.inputMint),
        outputMint: String(body.outputMint ?? params.outputMint),
        inAmount: String(body.inAmount ?? params.amount),
        outAmount: String(body.outAmount),
        otherAmountThreshold: String(body.otherAmountThreshold ?? body.outAmount),
        priceImpactPct: Number.isFinite(impact) ? Math.abs(impact) : 0,
        slippageBps: Number(body.slippageBps ?? params.slippageBps),
        route: Array.from(new Set(route)).slice(0, 3),
      }
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `스왑 견적을 받지 못했습니다. ${
      lastError instanceof Error && lastError.message ? `(${lastError.message})` : ''
    }`,
  )
}

export interface SwapTransaction {
  /** base64 serialized VersionedTransaction */
  transaction: string
  lastValidBlockHeight: number | null
}

export async function fetchSwapTransaction(
  quote: SwapQuote,
  userPublicKey: string,
): Promise<SwapTransaction> {
  const body = {
    userPublicKey,
    quoteResponse: quote.raw,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  }

  let lastError: unknown = null
  for (const base of orderedBases()) {
    try {
      const response = await requestJson(`${base}/swap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response?.swapTransaction) throw new Error('스왑 트랜잭션을 받지 못했습니다.')
      preferredBase = base
      return {
        transaction: String(response.swapTransaction),
        lastValidBlockHeight: Number.isFinite(Number(response.lastValidBlockHeight))
          ? Number(response.lastValidBlockHeight)
          : null,
      }
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `스왑 트랜잭션을 만들지 못했습니다. ${
      lastError instanceof Error && lastError.message ? `(${lastError.message})` : ''
    }`,
  )
}

/** Base64 → bytes without relying on Buffer being in scope. */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export type SwapSpeed = 'fast' | 'normal'

export const SPEED_LABEL: Record<SwapSpeed, string> = {
  fast: '빠르게',
  normal: '보통',
}
