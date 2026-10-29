/** Periodic DeepSeek account balance queries; all department keys share one account and one balance. */

/** One currency's balance as DeepSeek reports it. */
export interface BalanceInfo {
  readonly currency: string
  /** Total balance in that currency. */
  readonly total: number
  readonly granted: number
  readonly toppedUp: number
}

/** The latest balance query. */
export type BalanceReading =
  | { readonly state: 'unknown' }
  | { readonly state: 'ok', readonly at: number, readonly available: boolean, readonly balances: readonly BalanceInfo[], readonly low: boolean }
  | { readonly state: 'failed', readonly at: number, readonly message: string }

/** Facilities of one balance monitor. */
export interface BalanceMonitorOptions {
  /** DeepSeek balance endpoint. */
  readonly url: string
  /**
   * Resolve the key to query with.
   * @returns an enabled department's key, or `undefined` when no department has one.
   */
  key(): Promise<string | undefined>
  /** Balance in CNY below which the reading is low. */
  readonly lowBalanceYuan: number
  /**
   * Report a low or failed reading.
   * @param message - diagnostic text without secrets.
   */
  warn(message: string): void
  readonly fetch?: typeof fetch
}

/** Upper bound of one balance query. */
const QUERY_TIMEOUT_MS = 15_000

function parseAmount(value: unknown): number {
  const amount = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(amount)) throw new Error(`unexpected balance amount ${JSON.stringify(value)}`)
  return amount
}

/**
 * Parse a `GET /user/balance` answer.
 * @param body - the JSON answer.
 * @returns availability and per-currency balances.
 * @throws Error when the answer lacks the documented fields.
 */
export function parseBalance(body: unknown): { available: boolean, balances: BalanceInfo[] } {
  if (typeof body !== 'object' || body === null) throw new Error('the balance answer is not a JSON object')
  const fields = body as Record<string, unknown>
  if (typeof fields.is_available !== 'boolean' || !Array.isArray(fields.balance_infos)) throw new Error('the balance answer lacks is_available or balance_infos')
  return {
    available: fields.is_available,
    balances: fields.balance_infos.map((info: unknown) => {
      const entry = (typeof info === 'object' && info !== null ? info : {}) as Record<string, unknown>
      if (typeof entry.currency !== 'string') throw new Error('a balance entry lacks its currency')
      return {
        currency: entry.currency,
        total: parseAmount(entry.total_balance),
        granted: parseAmount(entry.granted_balance),
        toppedUp: parseAmount(entry.topped_up_balance),
      }
    }),
  }
}

/** Queries the account balance on demand and keeps the latest reading. */
export class BalanceMonitor {
  private reading: BalanceReading = { state: 'unknown' }
  private running: Promise<BalanceReading> | undefined

  constructor(private readonly options: BalanceMonitorOptions) {}

  /** @returns the latest reading. */
  latest(): BalanceReading { return this.reading }

  /**
   * Query the balance now; concurrent calls share one query.
   * @returns the new reading.
   */
  refresh(): Promise<BalanceReading> {
    this.running ??= this.query().finally(() => { this.running = undefined })
    return this.running
  }

  private async query(): Promise<BalanceReading> {
    const at = Date.now()
    try {
      const key = await this.options.key()
      if (key === undefined) throw new Error('没有已配置 Key 的启用部门')
      const response = await (this.options.fetch ?? fetch)(this.options.url, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`DeepSeek 余额接口返回 HTTP ${response.status}`)
      const { available, balances } = parseBalance(await response.json())
      const cny = balances.find(entry => entry.currency === 'CNY')
      const low = !available || (cny !== undefined && cny.total < this.options.lowBalanceYuan)
      if (low) this.options.warn(`keyhub: DeepSeek account balance is low or unavailable (${balances.map(entry => `${entry.total} ${entry.currency}`).join(', ') || 'no balance'})`)
      this.reading = { state: 'ok', at, available, balances, low }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.warn(`keyhub: querying the DeepSeek account balance failed: ${message}`)
      this.reading = { state: 'failed', at, message }
    }
    return this.reading
  }
}
