/**
 * Management-page commands of the admin role, served on {@link ADMIN_ROUTE}. Only the owner of the admin's DSH reaches
 * the route (see `src/rpc-route.ts`); employees reach the relay, never this route.
 */
import type { RpcAnswer, RpcHandler } from '../rpc-route.ts'
import type { BalanceMonitor, BalanceReading } from './balance.ts'
import type { LedgerOverview } from './ledger-ops.ts'
import { newUserId, overview, topUp, usageCsv } from './ledger-ops.ts'
import { parsePrice, parseYuan, QUOTA_PERIODS } from './money.ts'
import type { KeyhubStore, QuotaScope } from './store.ts'

/** Connection API route of the management page. */
export const ADMIN_ROUTE = '/api/genyee-keyhub/admin'

/** Relay facts shown on the service tab. */
export interface ServiceInfo {
  /** Origin employees reach, such as `https://10.0.0.8:8443`. */
  readonly relayURL: string
  /** Certificate fingerprint carried in access codes; absent for plain HTTP. */
  readonly fingerprint: string | undefined
  readonly upstreamBaseURL: string
  readonly timeZone: string
  readonly defaultMaxConcurrency: number
  readonly lowBalanceYuan: number
  readonly version: string
}

/** Facilities of the management RPC. */
export interface AdminRpcDependencies {
  readonly store: KeyhubStore
  readonly service: ServiceInfo
  readonly balance: BalanceMonitor
  /**
   * Whether a department key reference resolves to a value.
   * @param ref - credential reference name.
   * @returns configured state.
   */
  keyConfigured(ref: string): Promise<boolean>
  /**
   * Store a department key in the admin's credentials.
   * @param ref - credential reference name.
   * @param key - the DeepSeek API key.
   */
  storeKey(ref: string, key: string): Promise<void>
  /**
   * Interrupt in-flight requests whose employee lost admission after a ledger write.
   */
  ledgerChanged(): void
  /**
   * Encode an access code for a fresh token.
   * @param token - the employee's new authorization token.
   * @returns the pasteable access code.
   */
  accessCode(token: string): string
  readonly now?: () => number
}

/** A rejected payload; answered as `keyhub/invalid` with the message shown to the admin. */
class InvalidPayload extends Error {}

/** Field readers over an untrusted JSON payload. */
class Payload {
  private readonly fields: Record<string, unknown>
  constructor(value: unknown) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidPayload('请求内容必须是对象')
    this.fields = value as Record<string, unknown>
  }

  string(name: string): string {
    const value = this.fields[name]
    if (typeof value !== 'string' || value.trim().length === 0) throw new InvalidPayload(`缺少字段 ${name}`)
    return value.trim()
  }

  optionalString(name: string): string | undefined {
    const value = this.fields[name]
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string') throw new InvalidPayload(`字段 ${name} 必须是文本`)
    return value.trim()
  }

  optionalBoolean(name: string): boolean | undefined {
    const value = this.fields[name]
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') throw new InvalidPayload(`字段 ${name} 必须是布尔值`)
    return value
  }

  /** `undefined` when absent, `null` when explicitly cleared. */
  nullableStrings(name: string): string[] | null | undefined {
    if (!(name in this.fields)) return undefined
    const value = this.fields[name]
    if (value === null) return null
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new InvalidPayload(`字段 ${name} 必须是文本列表`)
    return [...new Set(value.map(item => item.trim()).filter(item => item.length > 0))]
  }

  /** `undefined` when absent, `null` when explicitly cleared. */
  nullableInteger(name: string): number | null | undefined {
    if (!(name in this.fields)) return undefined
    const value = this.fields[name]
    if (value === null) return null
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new InvalidPayload(`字段 ${name} 必须是正整数`)
    return value
  }

  instant(name: string): number {
    const value = this.fields[name]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new InvalidPayload(`字段 ${name} 必须是时间戳（毫秒）`)
    return value
  }

  scope(): QuotaScope {
    const value = this.fields.scope
    if (value !== 'employee' && value !== 'department') throw new InvalidPayload('scope 必须是 employee 或 department')
    return value
  }
}

/** Department key credential references follow the credential grammar. */
const KEY_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
/** Department ids appear in URLs, logs, and CSV files. */
const DEPARTMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u

/** Everything the management page loads at once. */
export interface ManagementState extends LedgerOverview {
  /** Department id → whether its key reference resolves. */
  readonly keyConfigured: Readonly<Record<string, boolean>>
  readonly service: ServiceInfo
  readonly balance: BalanceReading
}

/**
 * Create the management command handler.
 * @param deps - the ledger and admin facilities.
 * @returns a handler of one decoded command.
 */
export function createAdminRpc(deps: AdminRpcDependencies): RpcHandler {
  const now = deps.now ?? Date.now
  const { store } = deps

  const state = async (): Promise<ManagementState> => {
    const ledger = overview(store, now())
    const keyConfigured: Record<string, boolean> = {}
    for (const department of ledger.departments) keyConfigured[department.id] = await deps.keyConfigured(department.keyRef)
    return { ...ledger, keyConfigured, service: deps.service, balance: deps.balance.latest() }
  }

  /** Run a ledger write, then let the relay re-check in-flight requests. */
  const write = <T>(run: () => T): T => {
    const result = run()
    deps.ledgerChanged()
    return result
  }

  const endpoints: Record<string, (payload: Payload) => Promise<unknown>> = {
    async state() { return state() },

    async 'balance.refresh'() { return deps.balance.refresh() },

    async 'department.save'(payload) {
      const id = payload.string('id')
      if (!DEPARTMENT_ID_PATTERN.test(id)) throw new InvalidPayload('部门 id 只能包含字母、数字、- 和 _，最长 64 个字符')
      const current = store.department(id)
      const keyRef = payload.optionalString('keyRef') ?? current?.keyRef ?? `GENYEE_DEEPSEEK_KEY_${id.toUpperCase().replaceAll('-', '_')}`
      if (!KEY_REF_PATTERN.test(keyRef)) throw new InvalidPayload('Key 引用名只能包含字母、数字和下划线，且不能以数字开头')
      write(() => {
        store.putDepartment({
          id,
          name: payload.optionalString('name') ?? current?.name ?? id,
          keyRef,
          enabled: payload.optionalBoolean('enabled') ?? current?.enabled ?? true,
        })
      })
      // The balance query uses an enabled department's key, which this change may have added or removed.
      deps.balance.refresh().catch(() => { /* BalanceMonitor reports its own failures. */ })
      return state()
    },

    async 'department.setKey'(payload) {
      const department = store.department(payload.string('id'))
      if (department === undefined) throw new InvalidPayload('部门不存在')
      await deps.storeKey(department.keyRef, payload.string('key'))
      deps.balance.refresh().catch(() => { /* BalanceMonitor reports its own failures. */ })
      return state()
    },

    async 'employee.add'(payload) {
      const userId = newUserId()
      const token = write(() => store.addEmployee({ userId, name: payload.string('name'), departmentId: payload.string('departmentId') }))
      return { userId, accessCode: deps.accessCode(token), state: await state() }
    },

    async 'employee.update'(payload) {
      const userId = payload.string('userId')
      write(() => {
        store.updateEmployee(userId, {
          ...payload.optionalString('name') === undefined ? {} : { name: payload.optionalString('name')! },
          ...payload.optionalString('departmentId') === undefined ? {} : { departmentId: payload.optionalString('departmentId')! },
          ...payload.optionalBoolean('enabled') === undefined ? {} : { enabled: payload.optionalBoolean('enabled')! },
          ...payload.nullableStrings('models') === undefined ? {} : { models: payload.nullableStrings('models')! },
          ...payload.nullableInteger('maxConcurrency') === undefined ? {} : { maxConcurrency: payload.nullableInteger('maxConcurrency')! },
        })
      })
      return state()
    },

    async 'employee.resetToken'(payload) {
      const userId = payload.string('userId')
      const token = write(() => store.resetToken(userId))
      return { userId, accessCode: deps.accessCode(token), state: await state() }
    },

    async 'quota.set'(payload) {
      const scope = payload.scope()
      const id = payload.string('id')
      const amount = payload.optionalString('amount')
      let quota: { micros: number, period: string } | undefined
      if (amount !== undefined) {
        const period = payload.string('period')
        if (!(QUOTA_PERIODS as readonly string[]).includes(period)) throw new InvalidPayload('额度周期无效')
        quota = { micros: parseYuan(amount), period }
      }
      write(() => { store.setQuota(scope, id, quota, now()) })
      return state()
    },

    async 'quota.topUp'(payload) {
      const scope = payload.scope()
      write(() => { topUp(store, scope, payload.string('id'), parseYuan(payload.string('amount')), payload.optionalString('note'), now()) })
      return state()
    },

    async 'price.set'(payload) {
      const model = payload.string('model')
      write(() => {
        store.setPrice(model, {
          inputCacheHit: parsePrice(payload.string('hit')),
          inputCacheMiss: parsePrice(payload.string('miss')),
          output: parsePrice(payload.string('output')),
        }, now())
      })
      return state()
    },

    async 'price.remove'(payload) {
      const model = payload.string('model')
      write(() => { store.removePrice(model) })
      return state()
    },

    async 'usage.summary'(payload) {
      const from = payload.instant('from')
      const to = payload.instant('to')
      if (to <= from) throw new InvalidPayload('结束时间必须晚于开始时间')
      return { employees: store.spending('employee', from, to), departments: store.spending('department', from, to) }
    },

    async 'usage.csv'(payload) {
      const from = payload.instant('from')
      const to = payload.instant('to')
      if (to <= from) throw new InvalidPayload('结束时间必须晚于开始时间')
      const userId = payload.optionalString('userId')
      const departmentId = payload.optionalString('departmentId')
      return {
        csv: usageCsv(store, { from, to, ...userId === undefined ? {} : { userId }, ...departmentId === undefined ? {} : { departmentId } }),
      }
    },
  }

  return async (endpoint, raw): Promise<RpcAnswer> => {
    const run = Object.hasOwn(endpoints, endpoint) ? endpoints[endpoint] : undefined
    if (run === undefined) return { ok: false, error: { code: 'keyhub/unknown-endpoint', message: `未知操作 ${endpoint}`, details: {} } }
    try {
      return { ok: true, value: await run(new Payload(raw ?? {})) }
    } catch (error) {
      // Ledger, parsing, and payload errors carry messages written for the admin.
      return { ok: false, error: { code: error instanceof InvalidPayload ? 'keyhub/invalid' : 'keyhub/failed', message: error instanceof Error ? error.message : String(error), details: {} } }
    }
  }
}
