/** Pre-flight checks of one request: model allowlist, price, concurrency, and two-level money quotas. */
import type { QuotaPeriod } from './money.ts'
import { formatYuan, periodStart } from './money.ts'
import type { KeyhubStore, LedgerAdmission, Quota, QuotaScope } from './store.ts'

/** Why a request is refused, as answered to the employee. */
export interface Refusal {
  /** HTTP status; the DSH adapter maps 402 to a quota failure and retries 429. */
  readonly status: 400 | 402 | 403 | 429
  readonly type: 'invalid_request_error' | 'permission_error' | 'rate_limit_error' | 'billing_error'
  readonly message: string
}

/** Where one subject stands against its quota. */
export interface QuotaStanding {
  readonly scope: QuotaScope
  readonly id: string
  readonly period: QuotaPeriod
  /** Quota plus top-ups of the current window, in micro-yuan. */
  readonly allowanceMicros: number
  /** Spending counted against the window, in micro-yuan. */
  readonly spentMicros: number
  /** Start of the counted window: the later of the period start and the quota's `since`. */
  readonly countedFrom: number
  /** Calendar window start, `undefined` for `total`. */
  readonly windowStart: number | undefined
}

const PERIOD_LABELS: Record<QuotaPeriod, string> = { day: '今日', week: '本周', month: '本月', year: '本年', total: '总' }

/**
 * Compute where a subject stands against its quota.
 * @param store - the ledger.
 * @param scope - employee or department.
 * @param id - user id or department id.
 * @param quota - the subject's quota.
 * @param now - the instant.
 * @param timeZone - calendar of the periods.
 * @returns allowance and spending of the current window.
 */
export function quotaStanding(store: KeyhubStore, scope: QuotaScope, id: string, quota: Quota, now: number, timeZone: string): QuotaStanding {
  const windowStart = periodStart(quota.period, now, timeZone)
  const countedFrom = Math.max(windowStart ?? quota.since, quota.since)
  return {
    scope, id, period: quota.period, windowStart, countedFrom,
    allowanceMicros: quota.micros + store.topUps(scope, id, windowStart, quota.since),
    spentMicros: store.spentSince(scope, id, countedFrom),
  }
}

/** Inputs of one pre-flight check. */
export interface RequestCheck {
  readonly admission: LedgerAdmission
  /** `model` of the request body, if any. */
  readonly model: string | undefined
  /** The employee's requests already in flight, excluding this one. */
  readonly inFlight: number
  readonly now: number
}

/** Ledger-wide check settings. */
export interface CheckSettings {
  readonly timeZone: string
  /** Concurrency limit of employees without their own. */
  readonly defaultMaxConcurrency: number
}

/**
 * Decide whether a request may go to DeepSeek.
 * @param store - the ledger.
 * @param request - who sends what.
 * @param settings - time zone and default limits.
 * @returns the refusal, or `undefined` to forward the request.
 */
export function checkRequest(store: KeyhubStore, request: RequestCheck, settings: CheckSettings): Refusal | undefined {
  const { employee, department } = request.admission
  if (request.model === undefined) return { status: 400, type: 'invalid_request_error', message: '请求缺少 model 字段' }
  if (employee.models !== undefined && !employee.models.includes(request.model)) {
    return { status: 403, type: 'permission_error', message: `你没有使用模型 ${request.model} 的权限，请联系管理员` }
  }
  if (store.priceAt(request.model, request.now) === undefined) {
    return { status: 400, type: 'invalid_request_error', message: `管理员尚未设置模型 ${request.model} 的价格，暂不能使用，请联系管理员` }
  }
  const maxConcurrency = employee.maxConcurrency ?? settings.defaultMaxConcurrency
  if (request.inFlight >= maxConcurrency) {
    return { status: 429, type: 'rate_limit_error', message: `你同时进行的请求已达上限 ${maxConcurrency} 个，请稍后再试` }
  }
  const subjects: Array<[QuotaScope, string, Quota | undefined, string]> = [
    ['employee', employee.userId, employee.quota, '你的'],
    ['department', department.id, department.quota, `部门“${department.name}”的`],
  ]
  for (const [scope, id, quota, owner] of subjects) {
    if (quota === undefined) continue
    const standing = quotaStanding(store, scope, id, quota, request.now, settings.timeZone)
    if (standing.spentMicros >= standing.allowanceMicros) {
      return {
        status: 402,
        type: 'billing_error',
        message: `${owner}${PERIOD_LABELS[quota.period]}额度已用完（已用 ${formatYuan(standing.spentMicros)}，额度 ${formatYuan(standing.allowanceMicros)}），请联系管理员`,
      }
    }
  }
  return undefined
}
