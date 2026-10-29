/** Values the plugin's RPC channels answer, as the browser receives them (see `src/admin/rpc.ts` and `src/employee/rpc.ts`). */

export type QuotaPeriod = 'day' | 'week' | 'month' | 'year' | 'total'
export type QuotaScope = 'employee' | 'department'

/** Amounts are micro-yuan. */
export interface QuotaView {
  readonly period: QuotaPeriod
  readonly quotaMicros: number
  readonly allowanceMicros: number
  readonly spentMicros: number
  readonly remainingMicros: number
}

export interface DepartmentView {
  readonly id: string
  readonly name: string
  readonly keyRef: string
  readonly enabled: boolean
  readonly quota: QuotaView | undefined
  readonly monthSpentMicros: number
  readonly employees: number
}

export interface EmployeeView {
  readonly userId: string
  readonly name: string
  readonly departmentId: string
  readonly enabled: boolean
  readonly models: readonly string[] | undefined
  readonly maxConcurrency: number | undefined
  readonly quota: QuotaView | undefined
  readonly monthSpentMicros: number
  readonly monthRequests: number
}

/** Prices in 元 per million tokens. */
export interface PriceView {
  readonly model: string
  readonly inputCacheHit: number
  readonly inputCacheMiss: number
  readonly output: number
}

export interface BalanceInfo {
  readonly currency: string
  readonly total: number
  readonly granted: number
  readonly toppedUp: number
}

export type BalanceReading =
  | { readonly state: 'unknown' }
  | { readonly state: 'ok', readonly at: number, readonly available: boolean, readonly balances: readonly BalanceInfo[], readonly low: boolean }
  | { readonly state: 'failed', readonly at: number, readonly message: string }

export interface ServiceInfo {
  readonly relayURL: string
  readonly fingerprint: string | undefined
  readonly upstreamBaseURL: string
  readonly timeZone: string
  readonly defaultMaxConcurrency: number
  readonly lowBalanceYuan: number
  readonly version: string
}

/** The admin channel's `state` answer. */
export interface ManagementState {
  readonly timeZone: string
  readonly departments: readonly DepartmentView[]
  readonly employees: readonly EmployeeView[]
  readonly prices: readonly PriceView[]
  readonly keyConfigured: Readonly<Record<string, boolean>>
  readonly service: ServiceInfo
  readonly balance: BalanceReading
}

/** The admin channel's answer to issuing an access code. */
export interface IssuedCode {
  readonly userId: string
  readonly accessCode: string
  readonly state: ManagementState
}

export interface SpendingRow {
  readonly id: string
  readonly requests: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly costMicros: number
}

export interface UsageSummary {
  readonly employees: readonly SpendingRow[]
  readonly departments: readonly SpendingRow[]
}

/** The relay's status body for one employee. */
export interface EmployeeStatus {
  readonly employee: string
  readonly userId: string
  readonly department: string
  readonly models: readonly string[]
  readonly maxConcurrency: number
  readonly quota: { readonly employee?: QuotaView, readonly department?: QuotaView }
  readonly relayVersion: string
}

/** The employee channel's `status` answer. */
export interface EmployeeConnection {
  readonly accessCodeRef: string
  readonly configured: boolean
  readonly relayURL: string | undefined
  readonly connected: boolean
  readonly status: EmployeeStatus | undefined
  readonly message: string | undefined
}
