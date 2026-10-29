/**
 * The admin ledger: departments, employees, prices, quota top-ups, and usage, in one SQLite file.
 * Admin tools may write the same file while the relay runs; {@link KeyhubStore.dataVersion} reveals such writes.
 */
import { DatabaseSync } from 'node:sqlite'
import { generateToken } from '../access-code.ts'
import type { Admission, Department, Employee } from './directory.ts'
import { hashToken, USER_ID_PATTERN } from './directory.ts'
import type { ModelPrice, QuotaPeriod } from './money.ts'
import { QUOTA_PERIODS } from './money.ts'
import type { RequestOutcome } from './relay.ts'
import type { TokenUsage } from './usage.ts'

/** Ledger schema generation, stored in `PRAGMA user_version`; it only increases. */
const SCHEMA_VERSION = 2

const SCHEMA_V1 = `
CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  quota_micros INTEGER,
  quota_period TEXT,
  quota_since INTEGER
);
CREATE TABLE employees (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department_id TEXT NOT NULL REFERENCES departments(id),
  token_sha256 TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  quota_micros INTEGER,
  quota_period TEXT,
  quota_since INTEGER,
  models TEXT,
  max_concurrency INTEGER
);
CREATE TABLE prices (
  model TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  input_cache_hit INTEGER NOT NULL,
  input_cache_miss INTEGER NOT NULL,
  output INTEGER NOT NULL,
  PRIMARY KEY (model, effective_from)
);
CREATE TABLE adjustments (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  window_start INTEGER,
  amount_micros INTEGER NOT NULL,
  note TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX adjustments_subject ON adjustments(scope, subject_id);
CREATE TABLE usage (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  model TEXT,
  status INTEGER,
  outcome TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  client_address TEXT
);
CREATE INDEX usage_user_at ON usage(user_id, at);
CREATE INDEX usage_department_at ON usage(department_id, at);
`

/** Generation 2: ledger settings, estimated usage rows, and Files API ownership. */
const SCHEMA_V2 = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
ALTER TABLE usage ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0;
CREATE TABLE files (
  file_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX files_user ON files(user_id);
`

/** Migrations by the generation they produce. */
const MIGRATIONS: ReadonlyArray<readonly [number, string]> = [[1, SCHEMA_V1], [2, SCHEMA_V2]]

/** Time zone recorded before any admin started the relay on this ledger. */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/** Who a quota or top-up applies to. */
export type QuotaScope = 'employee' | 'department'

/** A quota: an amount per period, effective from `since`. */
export interface Quota {
  readonly micros: number
  readonly period: QuotaPeriod
  /** When this quota was set; spending before it does not count. */
  readonly since: number
}

/** A department with its quota. */
export interface DepartmentRecord extends Department {
  readonly quota: Quota | undefined
}

/** An employee with quota and limits. */
export interface EmployeeRecord extends Employee {
  readonly quota: Quota | undefined
  /** Models the employee may use; `undefined` allows every priced model. */
  readonly models: readonly string[] | undefined
  /** Simultaneous requests allowed; `undefined` applies the relay default. */
  readonly maxConcurrency: number | undefined
}

/** An admitted employee with ledger details. */
export interface LedgerAdmission extends Admission {
  readonly employee: EmployeeRecord
  readonly department: DepartmentRecord
}

/** One usage row to append. */
export interface UsageEntry {
  readonly at: number
  readonly userId: string
  readonly departmentId: string
  readonly model: string | undefined
  readonly status: number | undefined
  readonly outcome: RequestOutcome
  readonly usage: TokenUsage | undefined
  /** Whether output tokens were estimated because the stream ended before its final usage. */
  readonly estimated: boolean
  readonly costMicros: number
  readonly clientAddress: string | undefined
}

/** One usage row as stored, for reports and export. */
export interface UsageRow {
  readonly at: number
  readonly userId: string
  readonly departmentId: string
  readonly model: string | undefined
  readonly status: number | undefined
  readonly outcome: string
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly estimated: boolean
  readonly costMicros: number
  readonly clientAddress: string | undefined
}

/** Filter of {@link KeyhubStore.usageRows}. */
export interface UsageFilter {
  /** Inclusive start, epoch milliseconds. */
  readonly from: number
  /** Exclusive end, epoch milliseconds. */
  readonly to: number
  readonly userId?: string
  readonly departmentId?: string
}

/** Per-subject spending totals over a range. */
export interface SpendingRow {
  readonly id: string
  readonly requests: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly costMicros: number
}

type Row = Record<string, unknown>

function str(row: Row, key: string): string { return row[key] as string }
function num(row: Row, key: string): number { return row[key] as number }
function optNum(row: Row, key: string): number | undefined { return row[key] === null ? undefined : row[key] as number }

function quotaOf(row: Row): Quota | undefined {
  if (row.quota_micros === null) return undefined
  return { micros: num(row, 'quota_micros'), period: str(row, 'quota_period') as QuotaPeriod, since: num(row, 'quota_since') }
}

function departmentOf(row: Row): DepartmentRecord {
  return { id: str(row, 'id'), name: str(row, 'name'), keyRef: str(row, 'key_ref'), enabled: num(row, 'enabled') === 1, quota: quotaOf(row) }
}

function employeeOf(row: Row): EmployeeRecord {
  return {
    userId: str(row, 'user_id'),
    name: str(row, 'name'),
    departmentId: str(row, 'department_id'),
    tokenSha256: str(row, 'token_sha256'),
    enabled: num(row, 'enabled') === 1,
    quota: quotaOf(row),
    models: row.models === null ? undefined : JSON.parse(str(row, 'models')) as string[],
    maxConcurrency: optNum(row, 'max_concurrency'),
  }
}

function assertPeriod(period: string): asserts period is QuotaPeriod {
  if (!(QUOTA_PERIODS as readonly string[]).includes(period)) throw new Error(`额度周期 "${period}" 无效：应为 ${QUOTA_PERIODS.join('、')} 之一`)
}

/** The admin ledger in one SQLite file. */
export class KeyhubStore {
  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Open or create the ledger.
   * @param file - SQLite file path.
   * @returns the open store.
   * @throws Error when the file was written by a newer plugin version.
   */
  static open(file: string): KeyhubStore {
    const db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const version = num(db.prepare('PRAGMA user_version').get() as Row, 'user_version')
    if (version > SCHEMA_VERSION) {
      db.close()
      throw new Error(`keyhub: ${file} uses ledger schema ${version}; this plugin version reads up to ${SCHEMA_VERSION}`)
    }
    if (version < SCHEMA_VERSION) {
      try { KeyhubStore.migrate(db) }
      catch (error) {
        db.close()
        throw error
      }
    }
    return new KeyhubStore(db)
  }

  /**
   * Bring the schema to {@link SCHEMA_VERSION} in one write transaction.
   * The generation is re-read under the write lock, so a concurrent opener that migrated first is not migrated again.
   */
  private static migrate(db: DatabaseSync): void {
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = num(db.prepare('PRAGMA user_version').get() as Row, 'user_version')
      for (const [produces, sql] of MIGRATIONS) if (produces > current) db.exec(sql)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void { this.db.close() }

  /**
   * The calendar of quota periods, written by the admin relay at startup.
   * @returns the IANA time zone, {@link DEFAULT_TIME_ZONE} before the relay first ran.
   */
  timeZone(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'time_zone'").get() as Row | undefined
    return row === undefined ? DEFAULT_TIME_ZONE : str(row, 'value')
  }

  /**
   * Record the calendar of quota periods; admin tools and the management page read it from here.
   * @param timeZone - IANA time zone the relay uses.
   */
  setTimeZone(timeZone: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('time_zone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(timeZone)
  }

  /**
   * Change counter of writes made through other connections.
   * @returns a value that changes when another connection commits.
   */
  dataVersion(): number {
    return num(this.db.prepare('PRAGMA data_version').get() as Row, 'data_version')
  }

  /**
   * Admit one authorization token.
   * @param token - the presented token.
   * @returns the employee and department, or `undefined` when the token is unknown or either is disabled.
   */
  admit(token: string): LedgerAdmission | undefined {
    const row = this.db.prepare('SELECT * FROM employees WHERE token_sha256 = ?').get(hashToken(token)) as Row | undefined
    if (row === undefined) return undefined
    const employee = employeeOf(row)
    const department = this.department(employee.departmentId)
    if (!employee.enabled || department === undefined || !department.enabled) return undefined
    return { employee, department }
  }

  /**
   * Re-read an employee and department for an in-flight request.
   * @param userId - the employee.
   * @returns the current admission, or `undefined` when either is gone or disabled.
   */
  readmit(userId: string): LedgerAdmission | undefined {
    const employee = this.employee(userId)
    if (employee === undefined || !employee.enabled) return undefined
    const department = this.department(employee.departmentId)
    return department === undefined || !department.enabled ? undefined : { employee, department }
  }

  department(id: string): DepartmentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM departments WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : departmentOf(row)
  }

  departments(): DepartmentRecord[] {
    return (this.db.prepare('SELECT * FROM departments ORDER BY id').all() as Row[]).map(departmentOf)
  }

  employee(userId: string): EmployeeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM employees WHERE user_id = ?').get(userId) as Row | undefined
    return row === undefined ? undefined : employeeOf(row)
  }

  employees(): EmployeeRecord[] {
    return (this.db.prepare('SELECT * FROM employees ORDER BY department_id, name').all() as Row[]).map(employeeOf)
  }

  /**
   * Create or rename a department.
   * @param department - id, display name, key reference, and enabled flag.
   */
  putDepartment(department: Department): void {
    if (department.id.trim().length === 0 || department.name.trim().length === 0) throw new Error('部门 id 和名称不能为空')
    this.db.prepare(`INSERT INTO departments (id, name, key_ref, enabled) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, key_ref = excluded.key_ref, enabled = excluded.enabled`)
      .run(department.id, department.name, department.keyRef, department.enabled ? 1 : 0)
  }

  /**
   * Add an employee with a fresh token.
   * @param employee - the new entry's user id, name, and department.
   * @returns the plaintext token, which the ledger does not keep.
   */
  addEmployee(employee: { userId: string, name: string, departmentId: string }): string {
    if (this.department(employee.departmentId) === undefined) throw new Error(`部门 "${employee.departmentId}" 不存在`)
    if (!USER_ID_PATTERN.test(employee.userId)) throw new Error(`userId "${employee.userId}" 只能包含字母、数字、- 和 _`)
    const token = generateToken()
    this.db.prepare('INSERT INTO employees (user_id, name, department_id, token_sha256) VALUES (?, ?, ?, ?)')
      .run(employee.userId, employee.name, employee.departmentId, hashToken(token))
    return token
  }

  /**
   * Replace an employee's token; the old token stops working immediately.
   * @param userId - the employee.
   * @returns the new plaintext token.
   */
  resetToken(userId: string): string {
    const token = generateToken()
    this.requireChange(this.db.prepare('UPDATE employees SET token_sha256 = ? WHERE user_id = ?').run(hashToken(token), userId), `员工 ${userId}`)
    return token
  }

  /**
   * Update employee fields.
   * @param userId - the employee.
   * @param patch - fields to change; `models: null` and `maxConcurrency: null` clear the limit.
   */
  updateEmployee(userId: string, patch: { name?: string, departmentId?: string, enabled?: boolean, models?: readonly string[] | null, maxConcurrency?: number | null }): void {
    const current = this.employee(userId)
    if (current === undefined) throw new Error(`员工 ${userId} 不存在`)
    if (patch.departmentId !== undefined && this.department(patch.departmentId) === undefined) throw new Error(`部门 "${patch.departmentId}" 不存在`)
    if (patch.maxConcurrency != null && (!Number.isSafeInteger(patch.maxConcurrency) || patch.maxConcurrency < 1)) throw new Error('并发上限必须是正整数')
    const models = patch.models === undefined ? current.models : patch.models ?? undefined
    const maxConcurrency = patch.maxConcurrency === undefined ? current.maxConcurrency : patch.maxConcurrency ?? undefined
    this.db.prepare('UPDATE employees SET name = ?, department_id = ?, enabled = ?, models = ?, max_concurrency = ? WHERE user_id = ?').run(
      patch.name ?? current.name,
      patch.departmentId ?? current.departmentId,
      (patch.enabled ?? current.enabled) ? 1 : 0,
      models === undefined ? null : JSON.stringify(models),
      maxConcurrency ?? null,
      userId,
    )
  }

  /**
   * Set or clear a quota.
   * Changing only the amount keeps the counting start, so spending and top-ups of the current window still count;
   * setting a first quota or changing the period counts from `now`.
   * @param scope - employee or department.
   * @param id - user id or department id.
   * @param quota - amount and period, or `undefined` to remove the limit.
   * @param now - when the change takes effect.
   */
  setQuota(scope: QuotaScope, id: string, quota: { micros: number, period: string } | undefined, now: number): void {
    if (quota !== undefined) {
      assertPeriod(quota.period)
      if (!Number.isSafeInteger(quota.micros) || quota.micros < 0) throw new Error('额度必须是非负金额')
    }
    const subject = `${scope === 'employee' ? '员工' : '部门'} ${id}`
    const current = scope === 'employee' ? this.employee(id) : this.department(id)
    if (current === undefined) throw new Error(`${subject} 不存在`)
    const since = quota === undefined ? null : current.quota?.period === quota.period ? current.quota.since : now
    const table = scope === 'employee' ? 'employees' : 'departments'
    const key = scope === 'employee' ? 'user_id' : 'id'
    this.requireChange(this.db.prepare(`UPDATE ${table} SET quota_micros = ?, quota_period = ?, quota_since = ? WHERE ${key} = ?`)
      .run(quota?.micros ?? null, quota?.period ?? null, since, id), subject)
  }

  /**
   * Add a top-up to the current window of a quota.
   * @param scope - employee or department.
   * @param id - user id or department id.
   * @param amountMicros - positive amount added to the allowance.
   * @param windowStart - start of the window the top-up belongs to; `undefined` for a `total` quota.
   * @param note - free text shown to admins.
   * @param now - record time.
   */
  addTopUp(scope: QuotaScope, id: string, amountMicros: number, windowStart: number | undefined, note: string | undefined, now: number): void {
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) throw new Error('追加金额必须大于 0')
    this.db.prepare('INSERT INTO adjustments (scope, subject_id, window_start, amount_micros, note, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(scope, id, windowStart ?? null, amountMicros, note ?? null, now)
  }

  /**
   * Sum of top-ups for one window.
   * @param scope - employee or department.
   * @param id - user id or department id.
   * @param windowStart - the window start; `undefined` sums `total`-quota top-ups made since `since`.
   * @param since - when the current quota was set.
   * @returns micro-yuan.
   */
  topUps(scope: QuotaScope, id: string, windowStart: number | undefined, since: number): number {
    const row = windowStart === undefined
      ? this.db.prepare('SELECT COALESCE(SUM(amount_micros), 0) AS total FROM adjustments WHERE scope = ? AND subject_id = ? AND window_start IS NULL AND at >= ?').get(scope, id, since)
      : this.db.prepare('SELECT COALESCE(SUM(amount_micros), 0) AS total FROM adjustments WHERE scope = ? AND subject_id = ? AND window_start = ? AND at >= ?').get(scope, id, windowStart, since)
    return num(row as Row, 'total')
  }

  /**
   * Spending of one employee or department since an instant.
   * @param scope - employee or department.
   * @param id - user id or department id.
   * @param from - inclusive start, epoch milliseconds.
   * @returns micro-yuan.
   */
  spentSince(scope: QuotaScope, id: string, from: number): number {
    const column = scope === 'employee' ? 'user_id' : 'department_id'
    return num(this.db.prepare(`SELECT COALESCE(SUM(cost_micros), 0) AS total FROM usage WHERE ${column} = ? AND at >= ?`).get(id, from) as Row, 'total')
  }

  /**
   * Record a model price, effective from `now`.
   * @param model - wire model id.
   * @param price - prices in 0.0001 元 per million tokens.
   * @param now - effective time.
   */
  setPrice(model: string, price: ModelPrice, now: number): void {
    for (const value of [price.inputCacheHit, price.inputCacheMiss, price.output]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('价格必须是非负数')
    }
    this.db.prepare('INSERT OR REPLACE INTO prices (model, effective_from, input_cache_hit, input_cache_miss, output) VALUES (?, ?, ?, ?, ?)')
      .run(model, now, price.inputCacheHit, price.inputCacheMiss, price.output)
  }

  /**
   * Remove every price of a model; recorded usage keeps the cost computed when it completed.
   * @param model - wire model id.
   * @throws Error when the model has no price.
   */
  removePrice(model: string): void {
    this.requireChange(this.db.prepare('DELETE FROM prices WHERE model = ?').run(model), `模型 ${model} 的价格`)
  }

  /**
   * The price in effect for a model at an instant.
   * @param model - wire model id.
   * @param at - the instant.
   * @returns the price, or `undefined` when none was set by then.
   */
  priceAt(model: string, at: number): ModelPrice | undefined {
    const row = this.db.prepare('SELECT * FROM prices WHERE model = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1').get(model, at) as Row | undefined
    return row === undefined ? undefined : { inputCacheHit: num(row, 'input_cache_hit'), inputCacheMiss: num(row, 'input_cache_miss'), output: num(row, 'output') }
  }

  /**
   * Current prices of every priced model.
   * @param now - the instant.
   * @returns model ids with their prices.
   */
  prices(now: number): Array<{ model: string, price: ModelPrice }> {
    const models = (this.db.prepare('SELECT DISTINCT model FROM prices ORDER BY model').all() as Row[]).map(row => str(row, 'model'))
    return models.flatMap((model) => {
      const price = this.priceAt(model, now)
      return price === undefined ? [] : [{ model, price }]
    })
  }

  /**
   * Append one usage row.
   * @param entry - the completed request.
   */
  recordUsage(entry: UsageEntry): void {
    const usage = entry.usage
    this.db.prepare(`INSERT INTO usage (at, user_id, department_id, model, status, outcome, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, estimated, cost_micros, client_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.at, entry.userId, entry.departmentId, entry.model ?? null, entry.status ?? null, entry.outcome,
      usage?.inputTokens ?? 0, usage?.cacheReadTokens ?? 0, usage?.cacheWriteTokens ?? 0, usage?.outputTokens ?? 0,
      entry.estimated ? 1 : 0, entry.costMicros, entry.clientAddress ?? null,
    )
  }

  /**
   * Usage rows in a range, oldest first.
   * @param filter - time range and optional employee or department.
   * @returns the matching rows.
   */
  usageRows(filter: UsageFilter): UsageRow[] {
    const clauses = ['at >= ?', 'at < ?']
    const params: Array<string | number> = [filter.from, filter.to]
    if (filter.userId !== undefined) {
      clauses.push('user_id = ?')
      params.push(filter.userId)
    }
    if (filter.departmentId !== undefined) {
      clauses.push('department_id = ?')
      params.push(filter.departmentId)
    }
    return (this.db.prepare(`SELECT * FROM usage WHERE ${clauses.join(' AND ')} ORDER BY at, id`).all(...params) as Row[]).map(row => ({
      at: num(row, 'at'),
      userId: str(row, 'user_id'),
      departmentId: str(row, 'department_id'),
      model: row.model === null ? undefined : str(row, 'model'),
      status: optNum(row, 'status'),
      outcome: str(row, 'outcome'),
      inputTokens: num(row, 'input_tokens'),
      cacheReadTokens: num(row, 'cache_read_tokens'),
      cacheWriteTokens: num(row, 'cache_write_tokens'),
      outputTokens: num(row, 'output_tokens'),
      estimated: num(row, 'estimated') === 1,
      costMicros: num(row, 'cost_micros'),
      clientAddress: row.client_address === null ? undefined : str(row, 'client_address'),
    }))
  }

  /**
   * Record the employee who uploaded a file through the relay.
   * @param fileId - DeepSeek file id.
   * @param userId - the uploading employee.
   * @param departmentId - the department whose key holds the file.
   * @param now - upload time.
   */
  recordFile(fileId: string, userId: string, departmentId: string, now: number): void {
    this.db.prepare('INSERT OR REPLACE INTO files (file_id, user_id, department_id, at) VALUES (?, ?, ?, ?)').run(fileId, userId, departmentId, now)
  }

  /**
   * The employee who uploaded a file.
   * @param fileId - DeepSeek file id.
   * @returns the uploader's user id, or `undefined` for a file the relay did not upload.
   */
  fileOwner(fileId: string): string | undefined {
    const row = this.db.prepare('SELECT user_id FROM files WHERE file_id = ?').get(fileId) as Row | undefined
    return row === undefined ? undefined : str(row, 'user_id')
  }

  /**
   * Forget a deleted file.
   * @param fileId - DeepSeek file id.
   */
  forgetFile(fileId: string): void {
    this.db.prepare('DELETE FROM files WHERE file_id = ?').run(fileId)
  }

  /**
   * Spending totals grouped by employee or department.
   * @param scope - grouping.
   * @param from - inclusive start, epoch milliseconds.
   * @param to - exclusive end, epoch milliseconds.
   * @returns one row per subject with any request in the range.
   */
  spending(scope: QuotaScope, from: number, to: number): SpendingRow[] {
    const column = scope === 'employee' ? 'user_id' : 'department_id'
    return (this.db.prepare(`SELECT ${column} AS id, COUNT(*) AS requests, SUM(input_tokens) AS input_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_micros) AS cost_micros
      FROM usage WHERE at >= ? AND at < ? GROUP BY ${column} ORDER BY cost_micros DESC`).all(from, to) as Row[]).map(row => ({
      id: str(row, 'id'),
      requests: num(row, 'requests'),
      inputTokens: num(row, 'input_tokens'),
      cacheReadTokens: num(row, 'cache_read_tokens'),
      cacheWriteTokens: num(row, 'cache_write_tokens'),
      outputTokens: num(row, 'output_tokens'),
      costMicros: num(row, 'cost_micros'),
    }))
  }

  private requireChange(result: { changes: number | bigint }, subject: string): void {
    if (Number(result.changes) === 0) throw new Error(`${subject} 不存在`)
  }
}
