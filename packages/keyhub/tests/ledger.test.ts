import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeAccessCode, encodeAccessCode, encodeRelayUpdate, generateToken } from '../src/access-code.ts'
import { BalanceMonitor, parseBalance } from '../src/admin/balance.ts'
import { assertConcreteHost } from '../src/admin/index.ts'
import { quotaView, topUp, usageCsv } from '../src/admin/ledger-ops.ts'
import { parsePrice, parseYuan, periodStart, zonedDayStart } from '../src/admin/money.ts'
import type { RpcAnswer } from '../src/rpc-route.ts'
import { createAdminRpc } from '../src/admin/rpc.ts'
import { DEFAULT_TIME_ZONE, KeyhubStore } from '../src/admin/store.ts'
import { createEmployeeRpc } from '../src/employee/rpc.ts'
import { rpcRoute } from '../src/rpc-route.ts'

let dir: string
let store: KeyhubStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keyhub-ledger-'))
  store = KeyhubStore.open(join(dir, 'ledger.db'))
  store.putDepartment({ id: 'rd', name: '研发部', keyRef: 'KEY_RD', enabled: true })
  store.addEmployee({ userId: 'emp_bob', name: 'Bob', departmentId: 'rd' })
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function value(answer: RpcAnswer): any {
  if (!answer.ok) throw new Error(`${answer.error.code}: ${answer.error.message}`)
  return answer.value
}

describe('ledger schema', () => {
  it('migrates a generation-1 ledger in place and keeps its rows', () => {
    const file = join(dir, 'v1.db')
    const v1 = new DatabaseSync(file)
    v1.exec(`CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_ref TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, quota_micros INTEGER, quota_period TEXT, quota_since INTEGER);
      CREATE TABLE employees (user_id TEXT PRIMARY KEY, name TEXT NOT NULL, department_id TEXT NOT NULL REFERENCES departments(id), token_sha256 TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, quota_micros INTEGER, quota_period TEXT, quota_since INTEGER, models TEXT, max_concurrency INTEGER);
      CREATE TABLE prices (model TEXT NOT NULL, effective_from INTEGER NOT NULL, input_cache_hit INTEGER NOT NULL, input_cache_miss INTEGER NOT NULL, output INTEGER NOT NULL, PRIMARY KEY (model, effective_from));
      CREATE TABLE adjustments (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, subject_id TEXT NOT NULL, window_start INTEGER, amount_micros INTEGER NOT NULL, note TEXT, at INTEGER NOT NULL);
      CREATE TABLE usage (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT NOT NULL, department_id TEXT NOT NULL, model TEXT, status INTEGER, outcome TEXT NOT NULL, input_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_micros INTEGER NOT NULL, client_address TEXT);
      INSERT INTO departments (id, name, key_ref) VALUES ('ops', '运维部', 'KEY_OPS');
      INSERT INTO usage (at, user_id, department_id, outcome, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_micros) VALUES (5, 'emp_x', 'ops', 'completed', 1, 0, 0, 1, 9);
      PRAGMA user_version = 1;`)
    v1.close()
    const migrated = KeyhubStore.open(file)
    try {
      expect(migrated.department('ops')?.name).toBe('运维部')
      expect(migrated.usageRows({ from: 0, to: 10 })).toMatchObject([{ userId: 'emp_x', costMicros: 9, estimated: false }])
      expect(migrated.timeZone()).toBe(DEFAULT_TIME_ZONE)
      migrated.recordFile('file_1', 'emp_x', 'ops', 1)
      expect(migrated.fileOwner('file_1')).toBe('emp_x')
    } finally {
      migrated.close()
    }
  })

  it('refuses a ledger written by a newer plugin version', () => {
    const file = join(dir, 'future.db')
    const future = new DatabaseSync(file)
    future.exec('PRAGMA user_version = 99')
    future.close()
    expect(() => KeyhubStore.open(file)).toThrow(/schema 99/u)
  })

  it('opens the same new file from two connections without migrating twice', () => {
    const file = join(dir, 'shared.db')
    const first = KeyhubStore.open(file)
    const second = KeyhubStore.open(file)
    first.close()
    second.close()
  })
})

describe('quotas', () => {
  it('keeps spending and top-ups when only the amount changes', () => {
    const now = Date.UTC(2026, 9, 15)
    store.setQuota('employee', 'emp_bob', { micros: parseYuan('100'), period: 'month' }, now - 1000)
    store.recordUsage({ at: now - 500, userId: 'emp_bob', departmentId: 'rd', model: 'm', status: 200, outcome: 'completed', usage: undefined, estimated: false, costMicros: parseYuan('30'), clientAddress: undefined })
    topUp(store, 'employee', 'emp_bob', parseYuan('5'), undefined, now - 400)
    store.setQuota('employee', 'emp_bob', { micros: parseYuan('120'), period: 'month' }, now)
    expect(quotaView(store, 'employee', 'emp_bob', store.employee('emp_bob')!.quota, now)).toMatchObject({
      quotaMicros: parseYuan('120'), allowanceMicros: parseYuan('125'), spentMicros: parseYuan('30'), remainingMicros: parseYuan('95'),
    })
    store.setQuota('employee', 'emp_bob', { micros: parseYuan('120'), period: 'week' }, now)
    expect(quotaView(store, 'employee', 'emp_bob', store.employee('emp_bob')!.quota, now)).toMatchObject({ allowanceMicros: parseYuan('120'), spentMicros: 0 })
  })

  it('files top-ups in the window of the ledger time zone', () => {
    store.setTimeZone('America/New_York')
    store.setQuota('department', 'rd', { micros: 0, period: 'day' }, 0)
    // 2026-10-15 03:00 UTC is still 14 October in New York.
    const now = Date.UTC(2026, 9, 15, 3)
    topUp(store, 'department', 'rd', parseYuan('1'), '加急', now)
    expect(store.topUps('department', 'rd', periodStart('day', now, 'America/New_York'), 0)).toBe(parseYuan('1'))
    expect(() => { topUp(store, 'employee', 'emp_bob', parseYuan('1'), undefined, now) }).toThrow(/未设置额度/u)
  })
})

describe('usage export', () => {
  it('writes CSV with names, the ledger calendar, and estimated flags', () => {
    store.recordUsage({ at: Date.UTC(2026, 9, 1, 2, 3, 4), userId: 'emp_bob', departmentId: 'rd', model: 'deepseek-flash', status: 200, outcome: 'interrupted', usage: { inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 3 }, estimated: true, costMicros: 1234, clientAddress: '10.0.0.9' })
    const csv = usageCsv(store, { from: 0, to: Number.MAX_SAFE_INTEGER })
    expect(csv.startsWith('﻿时间,员工,user_id')).toBe(true)
    expect(csv).toContain('2026-10-01 10:03:04,Bob,emp_bob,研发部,deepseek-flash,200,interrupted,1,2,0,3,是,0.001234,10.0.0.9\r\n')
    expect(usageCsv(store, { from: 0, to: Number.MAX_SAFE_INTEGER, userId: 'emp_other' }).split('\r\n')).toHaveLength(2)
  })

  it('finds calendar midnights east of UTC+12', () => {
    expect(zonedDayStart(2026, 10, 1, 'Pacific/Kiritimati')).toBe(Date.UTC(2026, 8, 30, 10))
  })
})

describe('assertConcreteHost', () => {
  const local = ['127.0.0.1', '10.0.0.8', '::1', 'fe80::1']
  it('accepts an address of this machine in any spelling', () => {
    expect(() => { assertConcreteHost('10.0.0.8', local) }).not.toThrow()
    expect(() => { assertConcreteHost('0:0:0:0:0:0:0:1', local) }).not.toThrow()
  })
  it('rejects every wildcard spelling and foreign addresses', () => {
    for (const host of ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0']) expect(() => { assertConcreteHost(host, local) }).toThrow(/wildcard/u)
    expect(() => { assertConcreteHost('10.0.0.9', local) }).toThrow(/not an address of this machine/u)
    expect(() => { assertConcreteHost('relay.local', local) }).toThrow(/IP address literal/u)
  })
})

describe('admin RPC', () => {
  const stored: Record<string, string> = {}
  let changes = 0
  const balance = new BalanceMonitor({ url: 'http://unused', key: async () => undefined, lowBalanceYuan: 50, warn: () => {} })
  const rpc = () => createAdminRpc({
    store,
    balance,
    service: { relayURL: 'https://10.0.0.8:8443', fingerprint: 'a'.repeat(64), upstreamBaseURL: 'https://api.deepseek.com/anthropic', timeZone: 'Asia/Shanghai', defaultMaxConcurrency: 8, lowBalanceYuan: 50, version: '0.0.0' },
    keyConfigured: async ref => ref in stored,
    async storeKey(ref, key) { stored[ref] = key },
    ledgerChanged() { changes++ },
    accessCode: token => encodeAccessCode({ relayURL: 'https://10.0.0.8:8443', fingerprint: 'a'.repeat(64), token }),
    now: () => Date.UTC(2026, 9, 15),
  })

  it('manages departments, keys, employees, quotas, and prices', async () => {
    const call = rpc()
    const created = value(await call('department.save', { id: 'sales', name: '销售部' }))
    expect(created.departments.find((entry: { id: string }) => entry.id === 'sales')).toMatchObject({ keyRef: 'GENYEE_DEEPSEEK_KEY_SALES', enabled: true })
    expect(created.keyConfigured.sales).toBe(false)
    const keyed = value(await call('department.setKey', { id: 'sales', key: 'sk-test' }))
    expect(stored.GENYEE_DEEPSEEK_KEY_SALES).toBe('sk-test')
    expect(keyed.keyConfigured.sales).toBe(true)

    const added = value(await call('employee.add', { name: '张三', departmentId: 'sales' }))
    const code = decodeAccessCode(added.accessCode)
    expect(code).toMatchObject({ relayURL: 'https://10.0.0.8:8443', fingerprint: 'a'.repeat(64) })
    expect(store.admit(code.token)?.employee.name).toBe('张三')
    const reset = value(await call('employee.resetToken', { userId: added.userId }))
    expect(store.admit(code.token)).toBeUndefined()
    expect(store.admit(decodeAccessCode(reset.accessCode).token)?.employee.userId).toBe(added.userId)

    value(await call('employee.update', { userId: added.userId, name: '张三丰', enabled: false, models: ['deepseek-flash'], maxConcurrency: 3, expiresAt: 1_800_000_000_000 }))
    expect(store.employee(added.userId)).toMatchObject({ name: '张三丰', enabled: false, models: ['deepseek-flash'], maxConcurrency: 3, expiresAt: 1_800_000_000_000 })
    value(await call('employee.update', { userId: added.userId, models: null, maxConcurrency: null, expiresAt: null }))
    expect(store.employee(added.userId)).toMatchObject({ models: undefined, maxConcurrency: undefined, expiresAt: undefined })

    const quota = value(await call('quota.set', { scope: 'department', id: 'sales', amount: '500', period: 'month' }))
    expect(quota.departments.find((entry: { id: string }) => entry.id === 'sales').quota).toMatchObject({ period: 'month', allowanceMicros: parseYuan('500') })
    value(await call('quota.topUp', { scope: 'department', id: 'sales', amount: '20.5', note: '加急' }))
    const priced = value(await call('price.set', { model: 'deepseek-flash', hit: '0.2', miss: '2', output: '3' }))
    expect(priced.prices).toEqual([{ model: 'deepseek-flash', inputCacheHit: 0.2, inputCacheMiss: 2, output: 3 }])
    expect(priced.service.relayUpdateCode).toMatch(/^gkhu1\./u)
    expect(priced.departments.find((entry: { id: string }) => entry.id === 'sales').quota.allowanceMicros).toBe(parseYuan('520.5'))
    value(await call('price.set', { model: 'typo-model', hit: '1', miss: '1', output: '1' }))
    expect(value(await call('price.remove', { model: 'typo-model' })).prices.map((entry: { model: string }) => entry.model)).toEqual(['deepseek-flash'])
    const withDefaults = value(await call('price.defaults', {}))
    expect(withDefaults.prices.map((entry: { model: string }) => entry.model)).toContain('deepseek-v4-pro')
    expect(await call('price.remove', { model: 'typo-model' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('不存在') } })
    expect(changes).toBeGreaterThanOrEqual(6)
  })

  it('answers invalid payloads with messages for the admin', async () => {
    const call = rpc()
    expect(await call('department.save', { id: '销售' })).toMatchObject({ ok: false, error: { code: 'keyhub/invalid' } })
    expect(await call('quota.set', { scope: 'team', id: 'rd' })).toMatchObject({ ok: false, error: { code: 'keyhub/invalid' } })
    expect(await call('price.set', { model: 'm', hit: '-1', miss: '1', output: '1' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('格式不正确') } })
    expect(await call('employee.add', { name: 'X', departmentId: 'none' })).toMatchObject({ ok: false, error: { message: '部门 "none" 不存在' } })
    expect(await call('nope', {})).toMatchObject({ ok: false, error: { code: 'keyhub/unknown-endpoint' } })
    expect(await call('constructor', {})).toMatchObject({ ok: false, error: { code: 'keyhub/unknown-endpoint' } })
  })

  it('summarizes and exports usage for a range, and tracks client IPs', async () => {
    const now = Date.UTC(2026, 9, 15)
    store.recordUsage({ at: now - 5000, userId: 'emp_bob', departmentId: 'rd', model: 'm', status: 200, outcome: 'completed', usage: undefined, estimated: false, costMicros: 3, clientAddress: '10.0.0.11' })
    store.recordUsage({ at: now - 1000, userId: 'emp_bob', departmentId: 'rd', model: 'm', status: 200, outcome: 'completed', usage: undefined, estimated: false, costMicros: 4, clientAddress: '10.0.0.12' })
    const summary = value(await rpc()('usage.summary', { from: 0, to: now }))
    expect(summary.employees).toMatchObject([{ id: 'emp_bob', requests: 2, costMicros: 7 }])
    const state = value(await rpc()('state', {}))
    expect(state.employees.find((entry: { userId: string }) => entry.userId === 'emp_bob')).toMatchObject({
      lastClientAddress: '10.0.0.12',
      recentClientAddresses: ['10.0.0.12', '10.0.0.11'],
    })
    const exported = value(await rpc()('usage.csv', { from: 0, to: now, departmentId: 'rd' }))
    expect(exported.csv).toContain('emp_bob')
    expect(await rpc()('usage.csv', { from: 1000, to: 0 })).toMatchObject({ ok: false })
  })
})

describe('employee RPC', () => {
  const token = generateToken()
  const code = encodeAccessCode({ relayURL: 'https://10.0.0.8:8443', fingerprint: 'b'.repeat(64), token })

  it('validates and stores the access code, applies relay update codes, and reports status', async () => {
    let saved: string | undefined
    const rpc = createEmployeeRpc({
      accessCodeRef: 'GENYEE_KEYHUB_ACCESS_CODE',
      readRaw: async () => saved,
      async save(text) { saved = text },
      async clear() { saved = undefined },
      relayStatus: async () => ({ ok: true, status: { employee: 'Bob' } }),
    })
    expect(value(await rpc('status', {}))).toMatchObject({ configured: false, connected: false })
    expect(await rpc('accessCode.save', { code: 'not-a-code' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('gkh1.') } })
    const updateCode = encodeRelayUpdate({ relayURL: 'https://10.0.0.99:8443', fingerprint: 'c'.repeat(64) })
    expect(await rpc('accessCode.save', { code: updateCode })).toMatchObject({ ok: false, error: { message: expect.stringContaining('尚未保存个人接入码') } })
    expect(value(await rpc('accessCode.save', { code: `  ${code}\n` }))).toMatchObject({ configured: true, connected: true, relayURL: 'https://10.0.0.8:8443', status: { employee: 'Bob' } })
    expect(saved).toBe(code)
    expect(value(await rpc('accessCode.save', { code: ` ${updateCode} ` }))).toMatchObject({ configured: true, connected: true, relayURL: 'https://10.0.0.99:8443' })
    expect(decodeAccessCode(saved!)).toEqual({ relayURL: 'https://10.0.0.99:8443', fingerprint: 'c'.repeat(64), token })
    expect(value(await rpc('accessCode.clear', {}))).toMatchObject({ configured: false })
  })

  it('explains refusals and an unreachable relay', async () => {
    const refused = createEmployeeRpc({ accessCodeRef: 'R', readRaw: async () => code, save: async () => {}, clear: async () => {}, relayStatus: async () => ({ ok: false, message: '授权码无效或已被管理员停用，请联系管理员' }) })
    expect(value(await refused('status', {}))).toMatchObject({ connected: false, message: '授权码无效或已被管理员停用，请联系管理员' })
    const offline = createEmployeeRpc({ accessCodeRef: 'R', readRaw: async () => code, save: async () => {}, clear: async () => {}, relayStatus: async () => { throw new Error('connect ECONNREFUSED') } })
    expect(value(await offline('status', {})).message).toContain('请确认管理员的 DSH 已打开')
  })
})

describe('balance', () => {
  const answer = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '9.99', granted_balance: '0.00', topped_up_balance: '9.99' }] }

  it('parses the DeepSeek balance answer', () => {
    expect(parseBalance(answer)).toEqual({ available: true, balances: [{ currency: 'CNY', total: 9.99, granted: 0, toppedUp: 9.99 }] })
    expect(() => parseBalance({})).toThrow()
  })

  it('flags a low balance and reports failures', async () => {
    const warnings: string[] = []
    let requested: RequestInit | undefined
    const monitor = new BalanceMonitor({
      url: 'https://api.deepseek.com/user/balance',
      key: async () => 'sk-x',
      lowBalanceYuan: 50,
      warn(message) { warnings.push(message) },
      fetch: (async (_url: string, init: RequestInit) => { requested = init; return Response.json(answer) }) as typeof fetch,
    })
    expect(await monitor.refresh()).toMatchObject({ state: 'ok', low: true, balances: [{ total: 9.99 }] })
    expect((requested!.headers as Record<string, string>).authorization).toBe('Bearer sk-x')
    expect(warnings).toHaveLength(1)
    const failing = new BalanceMonitor({ url: 'x', key: async () => undefined, lowBalanceYuan: 1, warn: () => {} })
    expect(await failing.refresh()).toMatchObject({ state: 'failed', message: '没有已配置 Key 的启用部门' })
  })
})

it('rejects prices too large to store exactly', () => {
  expect(() => parsePrice('99999999999999')).toThrow(/过大/u)
})

describe('rpcRoute', () => {
  it('decodes commands, answers JSON, and rejects malformed bodies', async () => {
    const route = rpcRoute('/api/genyee-keyhub/test', async (endpoint, payload) => ({ ok: true, value: { endpoint, payload } }))
    expect(route).toMatchObject({ path: '/api/genyee-keyhub/test', methods: ['POST'], requestBody: 'buffered' })
    const answer = await route.fetch(new Request('http://host/api/genyee-keyhub/test', { method: 'POST', body: JSON.stringify({ endpoint: 'state', payload: { a: 1 } }) }))
    expect(await answer.json()).toEqual({ ok: true, value: { endpoint: 'state', payload: { a: 1 } } })
    expect((await route.fetch(new Request('http://host/x', { method: 'POST', body: 'nope' }))).status).toBe(400)
    expect((await route.fetch(new Request('http://host/x', { method: 'POST', body: '{}' }))).status).toBe(400)
  })
})
