/** Formatting helpers shared across the wallet UI. */

export const LAMPORTS_PER_SOL = 1_000_000_000n

export function toBaseUnits(input: string, decimals: number): bigint {
  const cleaned = input.trim()
  if (!cleaned || cleaned === '.') return 0n
  const [intPart, fracPart = ''] = cleaned.split('.')
  const safeInt = intPart.replace(/[^0-9]/g, '') || '0'
  const safeFrac = fracPart.replace(/[^0-9]/g, '').slice(0, decimals).padEnd(decimals, '0')
  return BigInt(safeInt) * 10n ** BigInt(decimals) + BigInt(safeFrac || '0')
}

export function fromBaseUnits(value: bigint, decimals: number): string {
  const neg = value < 0n
  const abs = neg ? -value : value
  const base = 10n ** BigInt(decimals)
  const int = abs / base
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${int.toString()}${frac ? '.' + frac : ''}`
}

/** Human friendly amount with grouping, capped fraction digits. */
export function formatAmount(value: bigint, decimals: number, maxFrac = 6): string {
  const raw = fromBaseUnits(value, decimals)
  let [int, frac = ''] = raw.split('.')
  const neg = int.startsWith('-')
  if (neg) int = int.slice(1)
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  frac = frac.slice(0, maxFrac).replace(/0+$/, '')
  return `${neg ? '-' : ''}${grouped}${frac ? '.' + frac : ''}`
}

/**
 * Transaction amounts: keeps meaningful digits for dust-sized transfers
 * (0.000005 SOL should not collapse into "0").
 */
export function formatTxAmount(value: bigint, decimals: number): string {
  const raw = fromBaseUnits(value, decimals)
  if (!raw.includes('.')) return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const [int, frac] = raw.split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (int !== '0') return `${grouped}.${frac.slice(0, 4).replace(/0+$/, '')}`.replace(/\.$/, '')
  const significant = frac.slice(0, 9).replace(/0+$/, '')
  return significant ? `0.${significant}` : '0'
}

export function formatUsd(n: number | null | undefined, maxFrac = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n === 0) return maxFrac === 2 ? '$0.00' : '$0'
  if (Math.abs(n) < 0.01) return '<$0.01'
  return (
    '$' +
    n.toLocaleString('en-US', {
      minimumFractionDigits: maxFrac === 2 ? 2 : 0,
      maximumFractionDigits: maxFrac,
    })
  )
}

export function formatKrw(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return '₩' + Math.round(n).toLocaleString('ko-KR')
}

export function shortAddress(address: string, size = 4): string {
  if (!address) return ''
  if (address.length <= size * 2 + 3) return address
  return `${address.slice(0, size)}…${address.slice(-size)}`
}

export function formatPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (n >= 1) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n >= 0.01) return '$' + n.toFixed(4)
  return '$' + n.toFixed(6)
}

export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return ''
  const diff = Date.now() - ts * 1000
  const min = Math.floor(diff / 60000)
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}시간 전`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}일 전`
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}월 ${d.getDate()}일`
}

export function fullDate(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}. ${p(d.getMonth() + 1)}. ${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
