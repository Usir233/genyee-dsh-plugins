/** Money units, prices, request cost, and quota periods of the admin ledger. */
import type { TokenUsage } from './usage.ts'

/**
 * Amounts are integers in micro-yuan (0.000001 元). Prices are integers in
 * 0.0001 元 per million tokens, so one request's cost is exact before the
 * single rounding to micro-yuan.
 */
export const MICROS_PER_YUAN = 1_000_000
/** Price units per 元 (prices are stored in 0.0001 元 per million tokens). */
export const PRICE_UNITS_PER_YUAN = 10_000

/** Prices of one model, each in 0.0001 元 per million tokens. */
export interface ModelPrice {
  /** Input tokens served from the cache. */
  readonly inputCacheHit: number
  /** Input tokens that missed the cache, including tokens written to it. */
  readonly inputCacheMiss: number
  readonly output: number
}

/** Quota reset cycles; `total` never resets. */
export type QuotaPeriod = 'day' | 'week' | 'month' | 'year' | 'total'

/** Every quota period, in display order. */
export const QUOTA_PERIODS: readonly QuotaPeriod[] = ['day', 'week', 'month', 'year', 'total']

/**
 * Cost of one request.
 * @param usage - token counts the response reported.
 * @param price - the model's price at completion time.
 * @returns cost in micro-yuan, rounded half up.
 */
export function requestCostMicros(usage: TokenUsage, price: ModelPrice): number {
  // tokens × (0.0001 元 / 1e6 tokens) = 1e-10 元 per unit product; 1e4 such units make one micro-yuan.
  const units = usage.cacheReadTokens * price.inputCacheHit
    + (usage.inputTokens + usage.cacheWriteTokens) * price.inputCacheMiss
    + usage.outputTokens * price.output
  return Math.floor((units + 5_000) / 10_000)
}

/**
 * Parse a yuan amount written with at most 6 decimals.
 * @param text - such as `"100"` or `"0.5"`.
 * @returns micro-yuan.
 * @throws Error when the text is not a non-negative decimal with at most 6 fraction digits.
 */
export function parseYuan(text: string): number {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/u.exec(text.trim())
  if (match === null) throw new Error(`金额 "${text}" 格式不正确：应为非负数，最多 6 位小数`)
  const micros = Number(match[1]) * MICROS_PER_YUAN + Number((match[2] ?? '').padEnd(6, '0'))
  if (!Number.isSafeInteger(micros)) throw new Error(`金额 "${text}" 过大`)
  return micros
}

/**
 * Parse a price written in 元 per million tokens with at most 4 decimals.
 * @param text - such as `"2"` or `"0.2"`.
 * @returns price units (0.0001 元 per million tokens).
 */
export function parsePrice(text: string): number {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/u.exec(text.trim())
  if (match === null) throw new Error(`价格 "${text}" 格式不正确：应为非负数，最多 4 位小数（元/百万 token）`)
  return Number(match[1]) * PRICE_UNITS_PER_YUAN + Number((match[2] ?? '').padEnd(4, '0'))
}

/**
 * Format micro-yuan for people.
 * @param micros - amount in micro-yuan.
 * @returns `¥` amount with 2 decimals, or 4 when the amount is below one fen.
 */
export function formatYuan(micros: number): string {
  const yuan = micros / MICROS_PER_YUAN
  return `¥${yuan !== 0 && Math.abs(yuan) < 0.01 ? yuan.toFixed(4) : yuan.toFixed(2)}`
}

/** Calendar fields of one instant in a time zone. */
interface ZonedDate {
  readonly year: number
  /** 1 to 12. */
  readonly month: number
  readonly day: number
  /** 0 = Monday … 6 = Sunday. */
  readonly weekday: number
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
  })
}

function partsOf(at: number, format: Intl.DateTimeFormat): Record<string, string> {
  return Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]))
}

function zonedDate(at: number, format: Intl.DateTimeFormat): ZonedDate {
  const parts = partsOf(at, format)
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday: WEEKDAYS.indexOf(parts.weekday!) }
}

/** Offset of `timeZone` from UTC at `at`, in milliseconds. */
function offsetAt(at: number, format: Intl.DateTimeFormat): number {
  const parts = partsOf(at, format)
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return asUtc - Math.floor(at / 1000) * 1000
}

/** Instant of local midnight of a calendar date in `timeZone`. */
function zonedMidnight(year: number, month: number, day: number, format: Intl.DateTimeFormat): number {
  const naive = Date.UTC(year, month - 1, day)
  let at = naive - offsetAt(naive, format)
  // A second pass settles dates whose offset differs from the naive guess's (DST transitions).
  at = naive - offsetAt(at, format)
  return at
}

/**
 * Start of the quota period that contains `now`.
 * @param period - the reset cycle; `total` has no start.
 * @param now - the instant, in epoch milliseconds.
 * @param timeZone - IANA time zone whose calendar defines the periods; weeks start on Monday.
 * @returns the period start in epoch milliseconds, or `undefined` for `total`.
 */
export function periodStart(period: QuotaPeriod, now: number, timeZone: string): number | undefined {
  if (period === 'total') return undefined
  const format = formatter(timeZone)
  const today = zonedDate(now, format)
  switch (period) {
    case 'day': return zonedMidnight(today.year, today.month, today.day, format)
    case 'week': {
      const monday = new Date(Date.UTC(today.year, today.month - 1, today.day - today.weekday))
      return zonedMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), format)
    }
    case 'month': return zonedMidnight(today.year, today.month, 1, format)
    case 'year': return zonedMidnight(today.year, 1, 1, format)
  }
}

/**
 * Check that a time zone name is usable.
 * @param timeZone - IANA time zone name.
 * @throws RangeError when the runtime does not know the zone.
 */
export function assertTimeZone(timeZone: string): void {
  formatter(timeZone)
}
