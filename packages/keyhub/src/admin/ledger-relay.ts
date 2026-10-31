/** The relay wired to the ledger: admission, checks, file ownership, status, and usage recording. */
import { PLUGIN_VERSION } from '../version.ts'
import { employeeStatus } from './ledger-ops.ts'
import { requestCostMicros } from './money.ts'
import { checkQuotas, checkRequest } from './quota.ts'
import type { Relay, UsageRecord } from './relay.ts'
import { createRelay } from './relay.ts'
import type { KeyhubStore, LedgerAdmission } from './store.ts'

/** Settings and host facilities of a ledger relay. */
export interface LedgerRelayOptions {
  readonly timeZone: string
  readonly defaultMaxConcurrency: number
  readonly upstreamBaseURL: string
  readonly upstreamReadTimeoutMs: number
  readonly maxRequestBytes: number
  /**
   * Resolve a department key.
   * @param ref - credential reference name.
   * @returns the key, or `undefined` when none is configured.
   */
  resolveKey(ref: string): Promise<string | undefined>
  /**
   * Report a contained failure.
   * @param message - diagnostic text without secrets.
   */
  warn(message: string): void
}

/** A ledger relay with its in-flight re-check. */
export interface LedgerRelay {
  readonly relay: Relay<LedgerAdmission>
  /** Abort in-flight requests whose employee was disabled, expired, got a new token, or changed department. */
  recheck(now?: number): void
}

/**
 * Cost of one completed request at its completion time.
 * @param store - the ledger.
 * @param record - the request's usage record.
 * @returns micro-yuan; zero when the response reported no usage.
 */
function costOf(store: KeyhubStore, record: UsageRecord): number {
  if (record.observed === undefined || record.model === undefined) return 0
  const price = store.priceAt(record.model, Date.parse(record.at))
  return price === undefined ? 0 : requestCostMicros(record.observed.usage, price)
}

/**
 * Create the relay over a ledger.
 * @param ledger - the open ledger; the caller owns closing it after the relay stops.
 * @param options - settings and host facilities.
 * @returns the relay and its re-check.
 */
export function createLedgerRelay(ledger: KeyhubStore, options: LedgerRelayOptions): LedgerRelay {
  const relay = createRelay<LedgerAdmission>({
    admit: token => ledger.admit(token),
    check: (admission, request, pending) => checkRequest(ledger, { admission, ...request, pending, now: Date.now() }, {
      timeZone: options.timeZone, defaultMaxConcurrency: options.defaultMaxConcurrency,
    }),
    checkUpload: (admission, pending) => checkQuotas(ledger, admission, pending, Date.now(), options.timeZone),
    resolveKey: options.resolveKey,
    status: admission => employeeStatus(ledger, admission, Date.now(), options.defaultMaxConcurrency, PLUGIN_VERSION),
    files: {
      record: (fileId, admission) => { ledger.recordFile(fileId, admission.employee.userId, admission.department.id, Date.now()) },
      owns: (fileId, admission) => ledger.fileOwns(fileId, admission.employee.userId, admission.department.id),
      forget: (fileId) => { ledger.forgetFile(fileId) },
    },
    upstreamBaseURL: options.upstreamBaseURL,
    upstreamReadTimeoutMs: options.upstreamReadTimeoutMs,
    maxRequestBytes: options.maxRequestBytes,
    recordUsage(record) {
      try {
        ledger.recordUsage({
          at: Date.parse(record.at),
          userId: record.userId,
          departmentId: record.departmentId,
          model: record.model,
          status: record.status,
          outcome: record.outcome,
          usage: record.observed?.usage,
          estimated: record.observed?.estimated ?? false,
          costMicros: costOf(ledger, record),
          clientAddress: record.clientAddress,
        })
      } catch (error) {
        options.warn(`keyhub: recording usage of ${record.userId} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    warn: options.warn,
  })
  return {
    relay,
    recheck(now = Date.now()) {
      relay.interrupt(({ employee, department }) => {
        const current = ledger.readmit(employee.userId, now)
        return current !== undefined && current.employee.tokenSha256 === employee.tokenSha256 && current.department.id === department.id
      })
    },
  }
}
