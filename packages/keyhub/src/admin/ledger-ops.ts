/** Ledger operations shared by the admin tools, the management page, and the relay status route. */
import { randomBytes, X509Certificate } from 'node:crypto'
import { normalizeFingerprint } from '../access-code.ts'
import type { QuotaPeriod } from './money.ts'
import { formatYuan, MICROS_PER_YUAN, periodStart, PRICE_UNITS_PER_YUAN } from './money.ts'
import type { QuotaStanding } from './quota.ts'
import { quotaStanding } from './quota.ts'
import type { DepartmentRecord, EmployeeRecord, KeyhubStore, LedgerAdmission, Quota, QuotaScope, UsageFilter } from './store.ts'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * Create a random DeepSeek `user_id` without personal data.
 * @returns `emp_` followed by 16 base32 characters.
 */
export function newUserId(): string {
  return `emp_${[...randomBytes(16)].map(byte => BASE32[byte % 32]).join('')}`
}

/**
 * SHA-256 fingerprint of a PEM certificate, as access codes carry it.
 * @param pem - the relay certificate.
 * @returns lowercase hex without separators.
 */
export function certificateFingerprint(pem: string | Buffer): string {
  return normalizeFingerprint(new X509Certificate(pem).fingerprint256)
}

/**
 * Where a subject stands against its quota, on the ledger's calendar.
 * @param store - the ledger.
 * @param scope - employee or department.
 * @param id - user id or department id.
 * @param quota - the subject's quota.
 * @param now - the instant.
 * @returns allowance and spending of the current window.
 */
export function standingOf(store: KeyhubStore, scope: QuotaScope, id: string, quota: Quota, now: number): QuotaStanding {
  return quotaStanding(store, scope, id, quota, now, store.timeZone())
}

/**
 * Add a top-up to the current window of a subject's quota, on the ledger's calendar.
 * @param store - the ledger.
 * @param scope - employee or department.
 * @param id - user id or department id.
 * @param amountMicros - positive amount.
 * @param note - free text shown to admins.
 * @param now - record time.
 * @throws Error when the subject has no quota.
 */
export function topUp(store: KeyhubStore, scope: QuotaScope, id: string, amountMicros: number, note: string | undefined, now: number): void {
  const subject = scope === 'employee' ? store.employee(id) : store.department(id)
  if (subject === undefined) throw new Error(`${scope === 'employee' ? '员工' : '部门'} ${id} 不存在`)
  if (subject.quota === undefined) throw new Error(`${scope === 'employee' ? '员工' : '部门'} ${id} 未设置额度，无需追加`)
  store.addTopUp(scope, id, amountMicros, periodStart(subject.quota.period, now, store.timeZone()), note, now)
}

/** A quota with its current window, in micro-yuan. */
export interface QuotaView {
  readonly period: QuotaPeriod
  /** The quota without top-ups. */
  readonly quotaMicros: number
  /** Quota plus top-ups of the current window. */
  readonly allowanceMicros: number
  readonly spentMicros: number
  /** Allowance left, never below zero. */
  readonly remainingMicros: number
}

/**
 * Project a quota for display.
 * @param store - the ledger.
 * @param scope - employee or department.
 * @param id - user id or department id.
 * @param quota - the subject's quota, if any.
 * @param now - the instant.
 * @returns the view, or `undefined` when the subject has no quota.
 */
export function quotaView(store: KeyhubStore, scope: QuotaScope, id: string, quota: Quota | undefined, now: number): QuotaView | undefined {
  if (quota === undefined) return undefined
  const standing = standingOf(store, scope, id, quota, now)
  return {
    period: quota.period,
    quotaMicros: quota.micros,
    allowanceMicros: standing.allowanceMicros,
    spentMicros: standing.spentMicros,
    remainingMicros: Math.max(0, standing.allowanceMicros - standing.spentMicros),
  }
}

/** A department as the management page lists it. */
export interface DepartmentView extends Omit<DepartmentRecord, 'quota'> {
  readonly quota: QuotaView | undefined
  readonly monthSpentMicros: number
  readonly employees: number
}

/** An employee as the management page lists it. */
export interface EmployeeView extends Omit<EmployeeRecord, 'quota' | 'tokenSha256'> {
  readonly quota: QuotaView | undefined
  readonly monthSpentMicros: number
  readonly monthRequests: number
}

/** One current model price, in 元 per million tokens. */
export interface PriceView {
  readonly model: string
  readonly inputCacheHit: number
  readonly inputCacheMiss: number
  readonly output: number
}

/** Everything the management page shows about the ledger. */
export interface LedgerOverview {
  readonly timeZone: string
  readonly departments: readonly DepartmentView[]
  readonly employees: readonly EmployeeView[]
  readonly prices: readonly PriceView[]
}

/**
 * Collect the ledger state the management page shows.
 * @param store - the ledger.
 * @param now - the instant.
 * @returns departments, employees, and prices with their quota standings and this month's spending.
 */
export function overview(store: KeyhubStore, now: number): LedgerOverview {
  const timeZone = store.timeZone()
  const month = periodStart('month', now, timeZone)!
  const byEmployee = new Map(store.spending('employee', month, now + 1).map(row => [row.id, row]))
  const byDepartment = new Map(store.spending('department', month, now + 1).map(row => [row.id, row]))
  const employees = store.employees()
  return {
    timeZone,
    departments: store.departments().map(department => ({
      id: department.id,
      name: department.name,
      keyRef: department.keyRef,
      enabled: department.enabled,
      quota: quotaView(store, 'department', department.id, department.quota, now),
      monthSpentMicros: byDepartment.get(department.id)?.costMicros ?? 0,
      employees: employees.filter(employee => employee.departmentId === department.id).length,
    })),
    employees: employees.map(employee => ({
      userId: employee.userId,
      name: employee.name,
      departmentId: employee.departmentId,
      enabled: employee.enabled,
      models: employee.models,
      maxConcurrency: employee.maxConcurrency,
      quota: quotaView(store, 'employee', employee.userId, employee.quota, now),
      monthSpentMicros: byEmployee.get(employee.userId)?.costMicros ?? 0,
      monthRequests: byEmployee.get(employee.userId)?.requests ?? 0,
    })),
    prices: store.prices(now).map(({ model, price }) => ({
      model,
      inputCacheHit: price.inputCacheHit / PRICE_UNITS_PER_YUAN,
      inputCacheMiss: price.inputCacheMiss / PRICE_UNITS_PER_YUAN,
      output: price.output / PRICE_UNITS_PER_YUAN,
    })),
  }
}

/** What the relay answers an employee on `GET /keyhub/v1/status`. */
export interface EmployeeStatus {
  readonly employee: string
  readonly userId: string
  readonly department: string
  /** Models the employee may use now: allowed and priced. */
  readonly models: readonly string[]
  readonly maxConcurrency: number
  readonly quota: { readonly employee: QuotaView | undefined, readonly department: QuotaView | undefined }
  /** Version of the plugin serving the relay. */
  readonly relayVersion: string
}

/**
 * Describe an admitted employee's standing.
 * @param store - the ledger.
 * @param admission - the employee and department.
 * @param now - the instant.
 * @param defaultMaxConcurrency - limit of employees without their own.
 * @param relayVersion - the serving plugin version.
 * @returns the status body.
 */
export function employeeStatus(store: KeyhubStore, admission: LedgerAdmission, now: number, defaultMaxConcurrency: number, relayVersion: string): EmployeeStatus {
  const { employee, department } = admission
  const priced = store.prices(now).map(entry => entry.model)
  return {
    employee: employee.name,
    userId: employee.userId,
    department: department.name,
    models: employee.models === undefined ? priced : priced.filter(model => employee.models!.includes(model)),
    maxConcurrency: employee.maxConcurrency ?? defaultMaxConcurrency,
    quota: {
      employee: quotaView(store, 'employee', employee.userId, employee.quota, now),
      department: quotaView(store, 'department', department.id, department.quota, now),
    },
    relayVersion,
  }
}

const CSV_COLUMNS = ['时间', '员工', 'user_id', '部门', '模型', 'HTTP 状态', '结果', '输入（未命中）', '输入（缓存命中）', '输入（缓存写入）', '输出', '输出为估算', '金额（元）', '来源地址']

function csvField(value: string | number): string {
  const text = String(value)
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * Export usage rows as CSV for spreadsheets: UTF-8 with a byte order mark, times on the ledger's calendar.
 * @param store - the ledger.
 * @param filter - time range and optional employee or department.
 * @returns the CSV text.
 */
export function usageCsv(store: KeyhubStore, filter: UsageFilter): string {
  const timeZone = store.timeZone()
  const time = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  const employees = new Map(store.employees().map(employee => [employee.userId, employee.name]))
  const departments = new Map(store.departments().map(department => [department.id, department.name]))
  const lines = [CSV_COLUMNS.map(csvField).join(',')]
  for (const row of store.usageRows(filter)) {
    lines.push([
      time.format(row.at), employees.get(row.userId) ?? '', row.userId, departments.get(row.departmentId) ?? row.departmentId,
      row.model ?? '', row.status ?? '', row.outcome, row.inputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.outputTokens,
      row.estimated ? '是' : '否', (row.costMicros / MICROS_PER_YUAN).toFixed(6), row.clientAddress ?? '',
    ].map(csvField).join(','))
  }
  return `﻿${lines.join('\r\n')}\r\n`
}

/**
 * Summarize a quota for a terminal report.
 * @param view - the quota view, if any.
 * @returns text such as `month: 已用 ¥1.00 / ¥100.00`.
 */
export function describeQuota(view: QuotaView | undefined): string {
  return view === undefined ? '不限额' : `${view.period}: 已用 ${formatYuan(view.spentMicros)} / ${formatYuan(view.allowanceMicros)}`
}
