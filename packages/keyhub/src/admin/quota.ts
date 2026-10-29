/** Pre-flight checks of one request: model allowlist, price, concurrency, and two-level money quotas. */
import type { ModelPrice, QuotaPeriod } from './money.ts'
import { formatYuan, periodStart, requestCostMicros } from './money.ts'
import type { KeyhubStore, LedgerAdmission, Quota, QuotaScope } from './store.ts'

/**
 * Why a request is refused, as answered to the employee.
 * The DSH client replaces the message of 401, 402, and 403 answers with its own generic text ("API key invalid",
 * "quota exhausted"), so refusals the employee must read are 400 `invalid_request_error`, which DSH shows verbatim
 * and does not retry; `code` names the reason for other clients. Only the concurrency limit is 429, which DSH retries.
 */
export interface Refusal {
  readonly status: 400 | 429
  readonly type: 'invalid_request_error' | 'rate_limit_error'
  /** Machine-readable reason, such as `keyhub_quota_exhausted`. */
  readonly code: string
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

/** Requests already in flight that a new request competes with. */
export interface PendingRequests {
  /** The employee's Messages requests in flight. */
  readonly count: number
  /** Cost reserved by the employee's requests in flight, in micro-yuan. */
  readonly employeeMicros: number
  /** Cost reserved by the department's requests in flight, in micro-yuan. */
  readonly departmentMicros: number
}

/** Inputs of one pre-flight check. */
export interface RequestCheck {
  readonly admission: LedgerAdmission
  /** `model` of the request body, if any. */
  readonly model: string | undefined
  /** `max_tokens` of the request body, if any. */
  readonly maxTokens: number | undefined
  /** Byte length of the forwarded request body. */
  readonly bodyBytes: number
  readonly pending: PendingRequests
  readonly now: number
}

/** Outcome of a pre-flight check. */
export type CheckResult =
  | { readonly ok: true, /** Cost to reserve while the request runs, in micro-yuan. */ readonly reserveMicros: number }
  | { readonly ok: false, readonly refusal: Refusal }

/** Bytes of a JSON request body per input token assumed when reserving; low, so the reservation errs high. */
const RESERVE_BYTES_PER_TOKEN = 2
/** Output tokens assumed when a request names no `max_tokens`. */
const RESERVE_DEFAULT_OUTPUT_TOKENS = 32_000

/**
 * Cost to reserve for a request in flight, before its usage is known.
 * Input is priced as cache misses and output at its `max_tokens`, so the reservation bounds the actual cost from above.
 * @param price - the model's current price.
 * @param bodyBytes - byte length of the request body.
 * @param maxTokens - the request's `max_tokens`, if any.
 * @returns micro-yuan.
 */
export function reservationMicros(price: ModelPrice, bodyBytes: number, maxTokens: number | undefined): number {
  return requestCostMicros({
    inputTokens: Math.ceil(bodyBytes / RESERVE_BYTES_PER_TOKEN),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: maxTokens ?? RESERVE_DEFAULT_OUTPUT_TOKENS,
  }, price)
}

/** Ledger-wide check settings. */
export interface CheckSettings {
  readonly timeZone: string
  /** Concurrency limit of employees without their own. */
  readonly defaultMaxConcurrency: number
}

/**
 * Check both quota levels of an admitted employee.
 * Spending plus the reservations of requests already in flight must stay below each allowance; the new request's own
 * cost is not counted, so the last admitted request may overrun by at most its own cost.
 * @param store - the ledger.
 * @param admission - the employee and department.
 * @param pending - reservations of requests in flight.
 * @param now - the instant.
 * @param timeZone - calendar of the periods.
 * @returns the refusal, or `undefined` when both levels have room.
 */
export function checkQuotas(
  store: KeyhubStore, admission: LedgerAdmission, pending: Pick<PendingRequests, 'employeeMicros' | 'departmentMicros'>, now: number, timeZone: string,
): Refusal | undefined {
  const { employee, department } = admission
  const subjects: Array<[QuotaScope, string, Quota | undefined, string, number]> = [
    ['employee', employee.userId, employee.quota, '你的', pending.employeeMicros],
    ['department', department.id, department.quota, `部门“${department.name}”的`, pending.departmentMicros],
  ]
  for (const [scope, id, quota, owner, reserved] of subjects) {
    if (quota === undefined) continue
    const standing = quotaStanding(store, scope, id, quota, now, timeZone)
    if (standing.spentMicros + reserved >= standing.allowanceMicros) {
      const exhausted = standing.spentMicros >= standing.allowanceMicros
      return {
        status: 400,
        type: 'invalid_request_error',
        code: 'keyhub_quota_exhausted',
        message: exhausted
          ? `${owner}${PERIOD_LABELS[quota.period]}额度已用完（已用 ${formatYuan(standing.spentMicros)}，额度 ${formatYuan(standing.allowanceMicros)}），请联系管理员`
          : `${owner}${PERIOD_LABELS[quota.period]}剩余额度已被进行中的请求占满（已用 ${formatYuan(standing.spentMicros)}，额度 ${formatYuan(standing.allowanceMicros)}），请等待其完成后再试`,
      }
    }
  }
  return undefined
}

/**
 * Decide whether a Messages request may go to DeepSeek.
 * @param store - the ledger.
 * @param request - who sends what, and what is already in flight.
 * @param settings - time zone and default limits.
 * @returns the reservation to hold while the request runs, or the refusal.
 */
export function checkRequest(store: KeyhubStore, request: RequestCheck, settings: CheckSettings): CheckResult {
  const refuse = (refusal: Refusal): CheckResult => ({ ok: false, refusal })
  const { employee } = request.admission
  if (request.model === undefined) return refuse({ status: 400, type: 'invalid_request_error', code: 'keyhub_model_missing', message: '请求缺少 model 字段' })
  if (employee.models !== undefined && !employee.models.includes(request.model)) {
    return refuse({ status: 400, type: 'invalid_request_error', code: 'keyhub_model_not_allowed', message: `你没有使用模型 ${request.model} 的权限，请联系管理员` })
  }
  const price = store.priceAt(request.model, request.now)
  if (price === undefined) {
    return refuse({ status: 400, type: 'invalid_request_error', code: 'keyhub_model_unpriced', message: `管理员尚未设置模型 ${request.model} 的价格，暂不能使用，请联系管理员` })
  }
  const maxConcurrency = employee.maxConcurrency ?? settings.defaultMaxConcurrency
  if (request.pending.count >= maxConcurrency) {
    return refuse({ status: 429, type: 'rate_limit_error', code: 'keyhub_concurrency_limit', message: `你同时进行的请求已达上限 ${maxConcurrency} 个，请稍后再试` })
  }
  const refusal = checkQuotas(store, request.admission, request.pending, request.now, settings.timeZone)
  if (refusal !== undefined) return refuse(refusal)
  return { ok: true, reserveMicros: reservationMicros(price, request.bodyBytes, request.maxTokens) }
}
