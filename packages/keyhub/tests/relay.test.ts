import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateToken } from '../src/access-code.ts'
import { parsePrice, parseYuan, periodStart, requestCostMicros } from '../src/admin/money.ts'
import { checkRequest } from '../src/admin/quota.ts'
import type { Relay, UsageRecord } from '../src/admin/relay.ts'
import { apiRoot, createRelay } from '../src/admin/relay.ts'
import type { LedgerAdmission } from '../src/admin/store.ts'
import { KeyhubStore } from '../src/admin/store.ts'
import type { MockDeepSeek } from './support/mock-deepseek.ts'
import { REPLY_USAGE, sseEvent, startMockDeepSeek } from './support/mock-deepseek.ts'

const FLASH = 'deepseek-flash'
const PRO = 'deepseek-v4-pro'

interface Harness {
  readonly url: string
  readonly relay: Relay<LedgerAdmission>
  readonly store: KeyhubStore
  readonly usage: UsageRecord[]
  readonly alice: string
  readonly bob: string
  /** Re-check in-flight requests against the ledger, as the admin role does on ledger writes. */
  sync(): void
  close(): Promise<void>
}

async function startRelay(upstream: MockDeepSeek, keys: Record<string, string> = { KEY_SALES: 'sk-sales', KEY_RD: 'sk-rd' }): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'keyhub-ledger-'))
  const store = KeyhubStore.open(join(dir, 'ledger.db'))
  store.putDepartment({ id: 'sales', name: '销售部', keyRef: 'KEY_SALES', enabled: true })
  store.putDepartment({ id: 'rd', name: '研发部', keyRef: 'KEY_RD', enabled: true })
  const alice = store.addEmployee({ userId: 'emp_alice', name: 'Alice', departmentId: 'sales' })
  const bob = store.addEmployee({ userId: 'emp_bob', name: 'Bob', departmentId: 'rd' })
  store.setPrice(FLASH, { inputCacheHit: parsePrice('0.2'), inputCacheMiss: parsePrice('2'), output: parsePrice('3') }, 0)
  store.setPrice(PRO, { inputCacheHit: parsePrice('1'), inputCacheMiss: parsePrice('4'), output: parsePrice('16') }, 0)
  const usage: UsageRecord[] = []
  const relay = createRelay<LedgerAdmission>({
    admit: token => store.admit(token),
    check: (admission, model, inFlight) => checkRequest(store, { admission, model, inFlight, now: Date.now() }, { timeZone: 'Asia/Shanghai', defaultMaxConcurrency: 2 }),
    resolveKey: async ref => keys[ref],
    upstreamBaseURL: upstream.baseURL,
    upstreamReadTimeoutMs: 600_000,
    maxRequestBytes: 1024 * 1024,
    recordUsage(record) {
      usage.push(record)
      const price = record.model === undefined ? undefined : store.priceAt(record.model, Date.parse(record.at))
      const costMicros = record.usage === undefined || price === undefined ? 0 : requestCostMicros(record.usage, price)
      store.recordUsage({ ...record, at: Date.parse(record.at), costMicros })
    },
    warn: () => {},
  })
  const server: Server = createServer((req, res) => { relay.handle(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    relay, store, usage, alice, bob,
    sync() {
      relay.interrupt(({ employee }) => store.readmit(employee.userId)?.employee.tokenSha256 === employee.tokenSha256)
    },
    async close() {
      relay.closeAll()
      const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      server.closeAllConnections()
      await closed
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function messages(url: string, token: string, body: object, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'files-api-2025-04-14', ...extraHeaders },
    body: JSON.stringify(body),
  })
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

describe('relay', () => {
  let upstream: MockDeepSeek
  let harness: Harness

  beforeEach(async () => {
    upstream = await startMockDeepSeek()
    harness = await startRelay(upstream)
  })
  afterEach(async () => {
    await harness.close()
    await upstream.close()
  })

  it('binds the request to the employee and swaps in the department key', async () => {
    const response = await messages(harness.url, harness.alice, {
      model: FLASH, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }],
      metadata: { user_id: 'emp_bob', other: 'kept' },
      dsh_plugin_packages: ['secret-plugin'],
      dsh_session_log: { version: 1, events: [] },
    }, { 'x-deepseek-harness-user-id': 'device-123' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const text = await response.text()
    expect(text).toContain(': keep-alive')
    expect(text).toContain('"text":"pong"')

    const [received] = upstream.received
    expect(received.path).toBe('/anthropic/v1/messages')
    expect(received.headers['x-api-key']).toBe('sk-sales')
    expect(received.headers['anthropic-version']).toBe('2023-06-01')
    expect(received.headers['anthropic-beta']).toBe('files-api-2025-04-14')
    expect(received.headers['x-deepseek-harness-user-id']).toBeUndefined()
    expect(received.headers['accept-encoding']).toBe('identity')
    const body = JSON.parse(received.body) as Record<string, unknown>
    expect(body.metadata).toEqual({ user_id: 'emp_alice', other: 'kept' })
    expect(body).not.toHaveProperty('dsh_plugin_packages')
    expect(body).not.toHaveProperty('dsh_session_log')
    expect(body.model).toBe(FLASH)
  })

  it('records usage and its cost in the ledger', async () => {
    await (await messages(harness.url, harness.bob, { model: PRO, messages: [] })).text()
    await waitFor(() => harness.usage.length === 1)
    expect(harness.usage[0]).toMatchObject({
      userId: 'emp_bob', departmentId: 'rd', model: PRO, status: 200, outcome: 'completed',
      usage: { inputTokens: REPLY_USAGE.input_tokens, cacheReadTokens: REPLY_USAGE.cache_read_input_tokens, cacheWriteTokens: 0, outputTokens: REPLY_USAGE.output_tokens },
    })
    expect(upstream.received[0].headers['x-api-key']).toBe('sk-rd')
    // 7 hit × 1 + 11 miss × 4 + 5 out × 16 = 131 元 per million tokens, i.e. 131 micro-yuan.
    expect(harness.store.spentSince('employee', 'emp_bob', 0)).toBe(131)
    expect(harness.store.spentSince('department', 'rd', 0)).toBe(131)
  })

  it('refuses unknown tokens without contacting DeepSeek', async () => {
    const response = await messages(harness.url, generateToken(), { model: FLASH, messages: [] })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } })
    expect(upstream.received).toHaveLength(0)
  })

  it('refuses disabled employees and employees of disabled departments', async () => {
    harness.store.updateEmployee('emp_alice', { enabled: false })
    expect((await messages(harness.url, harness.alice, { model: FLASH, messages: [] })).status).toBe(401)
    harness.store.updateEmployee('emp_alice', { enabled: true })
    harness.store.putDepartment({ id: 'sales', name: '销售部', keyRef: 'KEY_SALES', enabled: false })
    expect((await messages(harness.url, harness.alice, { model: FLASH, messages: [] })).status).toBe(401)
    expect((await messages(harness.url, harness.bob, { model: FLASH, messages: [] })).status).toBe(200)
    expect(upstream.received).toHaveLength(1)
  })

  it('stops accepting a reset token at once', async () => {
    harness.store.resetToken('emp_alice')
    expect((await messages(harness.url, harness.alice, { model: FLASH, messages: [] })).status).toBe(401)
  })

  it('answers a missing department key with a permission error', async () => {
    await harness.close()
    harness = await startRelay(upstream, { KEY_RD: 'sk-rd' })
    const response = await messages(harness.url, harness.alice, { model: FLASH, messages: [] })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { type: 'permission_error' } })
    expect(upstream.received).toHaveLength(0)
  })

  it('rejects bodies that are not JSON objects', async () => {
    const response = await fetch(`${harness.url}/anthropic/v1/messages`, { method: 'POST', headers: { 'x-api-key': harness.alice }, body: '[1]' })
    expect(response.status).toBe(400)
  })

  it('rejects bodies above the size limit', async () => {
    const response = await messages(harness.url, harness.alice, { model: FLASH, padding: 'x'.repeat(2 * 1024 * 1024) })
    expect(response.status).toBe(413)
    expect(upstream.received).toHaveLength(0)
  })

  it('refuses models outside the employee allowlist and models without a price', async () => {
    harness.store.updateEmployee('emp_alice', { models: [FLASH] })
    const forbidden = await messages(harness.url, harness.alice, { model: PRO, messages: [] })
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toMatchObject({ error: { message: `你没有使用模型 ${PRO} 的权限，请联系管理员` } })
    const unpriced = await messages(harness.url, harness.bob, { model: 'deepseek-new', messages: [] })
    expect(unpriced.status).toBe(400)
    expect(await unpriced.json()).toMatchObject({ error: { message: expect.stringContaining('尚未设置模型 deepseek-new 的价格') } })
    expect(upstream.received).toHaveLength(0)
  })

  it('refuses requests beyond the employee concurrency limit', async () => {
    upstream.respond((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': keep-alive\n\n')
    })
    const open = await Promise.all([1, 2].map(() => messages(harness.url, harness.alice, { model: FLASH, messages: [] })))
    const third = await messages(harness.url, harness.alice, { model: FLASH, messages: [] })
    expect(third.status).toBe(429)
    expect(await third.json()).toMatchObject({ error: { type: 'rate_limit_error' } })
    harness.store.updateEmployee('emp_alice', { maxConcurrency: 3 })
    const raised = await messages(harness.url, harness.alice, { model: FLASH, messages: [] })
    expect(raised.status).toBe(200)
    for (const response of [...open, raised]) await response.body!.cancel()
  })

  it('refuses requests once the employee quota is spent, and resumes after a top-up', async () => {
    harness.store.setQuota('employee', 'emp_bob', { micros: 100, period: 'month' }, 0)
    await (await messages(harness.url, harness.bob, { model: PRO, messages: [] })).text()
    await waitFor(() => harness.usage.length === 1)
    const refused = await messages(harness.url, harness.bob, { model: PRO, messages: [] })
    expect(refused.status).toBe(402)
    expect(await refused.json()).toMatchObject({ error: { type: 'billing_error', message: '你的本月额度已用完（已用 ¥0.0001，额度 ¥0.0001），请联系管理员' } })
    const now = Date.now()
    harness.store.addTopUp('employee', 'emp_bob', parseYuan('1'), periodStart('month', now, 'Asia/Shanghai'), undefined, now)
    expect((await messages(harness.url, harness.bob, { model: PRO, messages: [] })).status).toBe(200)
  })

  it('refuses requests once the department quota is spent', async () => {
    harness.store.setQuota('department', 'rd', { micros: 1, period: 'total' }, 0)
    await (await messages(harness.url, harness.bob, { model: FLASH, messages: [] })).text()
    await waitFor(() => harness.usage.length === 1)
    const refused = await messages(harness.url, harness.bob, { model: FLASH, messages: [] })
    expect(refused.status).toBe(402)
    expect(await refused.json()).toMatchObject({ error: { message: expect.stringContaining('部门“研发部”的总额度已用完') } })
  })

  it('interrupts a streaming request when the employee is disabled', async () => {
    upstream.respond((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sseEvent(res, 'message_start', { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } })
    })
    const response = await messages(harness.url, harness.alice, { model: FLASH, messages: [] })
    const reader = response.body!.getReader()
    await reader.read()
    harness.store.updateEmployee('emp_alice', { enabled: false })
    harness.sync()
    await expect(async () => { while (!(await reader.read()).done) { /* drain */ } }).rejects.toThrow()
    await waitFor(() => harness.usage.length === 1)
    expect(harness.usage[0]).toMatchObject({ outcome: 'interrupted', usage: { inputTokens: 3 } })
  })

  it('aborts the upstream request when the employee disconnects', async () => {
    let upstreamClosed = false
    upstream.respond((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': keep-alive\n\n')
      res.once('close', () => { upstreamClosed = true })
    })
    const response = await messages(harness.url, harness.alice, { model: FLASH, messages: [] })
    await response.body!.cancel()
    await waitFor(() => upstreamClosed)
    await waitFor(() => harness.usage.length === 1)
    expect(harness.usage[0].outcome).toBe('interrupted')
  })

  it('passes DeepSeek errors through unchanged', async () => {
    upstream.respond((_request, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'busy' } }))
    })
    const response = await messages(harness.url, harness.alice, { model: FLASH, messages: [] })
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: { message: 'busy' } })
  })

  it('forwards Files API requests with the department key', async () => {
    upstream.respond((request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'file_1', echoed: request.body.length }))
    })
    const response = await fetch(`${harness.url}/anthropic/v1/files?limit=5`, { method: 'POST', headers: { 'x-api-key': harness.alice }, body: 'file-bytes' })
    expect(response.status).toBe(200)
    expect(upstream.received[0]).toMatchObject({ method: 'POST', path: '/anthropic/v1/files?limit=5', body: 'file-bytes' })
    expect(upstream.received[0].headers['x-api-key']).toBe('sk-sales')
    expect(harness.usage).toHaveLength(0)
  })

  it('reports the employee on the status route', async () => {
    const response = await fetch(`${harness.url}/keyhub/v1/status`, { headers: { 'x-api-key': harness.bob } })
    expect(await response.json()).toEqual({ employee: 'Bob', department: '研发部' })
  })

  it('streams events to the employee before the upstream response ends', async () => {
    let finish: (() => void) | undefined
    upstream.respond((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': keep-alive\n\n')
      finish = () => { res.end() }
    })
    const response = await messages(harness.url, harness.alice, { model: FLASH, messages: [] })
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain(': keep-alive')
    finish!()
    expect((await reader.read()).done).toBe(true)
  })
})

describe('apiRoot', () => {
  it('appends /v1 unless the base already ends with it', () => {
    expect(apiRoot('https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com/anthropic/v1')
    expect(apiRoot('https://gw.example/anthropic/v1/')).toBe('https://gw.example/anthropic/v1')
  })
})
