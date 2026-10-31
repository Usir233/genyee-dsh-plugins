import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateToken } from '../src/access-code.ts'
import { topUp } from '../src/admin/ledger-ops.ts'
import { createLedgerRelay } from '../src/admin/ledger-relay.ts'
import { parsePrice, parseYuan } from '../src/admin/money.ts'
import type { Relay } from '../src/admin/relay.ts'
import { apiRoot } from '../src/admin/relay.ts'
import type { LedgerAdmission, UsageRow } from '../src/admin/store.ts'
import { KeyhubStore } from '../src/admin/store.ts'
import { ESTIMATE_BYTES_PER_OUTPUT_TOKEN } from '../src/admin/usage.ts'
import { PLUGIN_VERSION } from '../src/version.ts'
import type { MockDeepSeek } from './support/mock-deepseek.ts'
import { REPLY_USAGE, sseEvent, startMockDeepSeek, streamReply } from './support/mock-deepseek.ts'

const FLASH = 'deepseek-flash'
const PRO = 'deepseek-v4-pro'

interface Harness {
  readonly url: string
  readonly relay: Relay<LedgerAdmission>
  readonly store: KeyhubStore
  /** Usage rows recorded so far, oldest first. */
  usage(): UsageRow[]
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
  store.setTimeZone('Asia/Shanghai')
  const { relay, recheck } = createLedgerRelay(store, {
    timeZone: 'Asia/Shanghai',
    defaultMaxConcurrency: 2,
    resolveKey: async ref => keys[ref],
    upstreamBaseURL: upstream.baseURL,
    upstreamReadTimeoutMs: 600_000,
    maxRequestBytes: 1024 * 1024,
    warn: () => {},
  })
  const server: Server = createServer((req, res) => { relay.handle(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    relay, store, alice, bob,
    usage: () => store.usageRows({ from: 0, to: Number.MAX_SAFE_INTEGER }),
    sync: recheck,
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
    await waitFor(() => harness.usage().length === 1)
    expect(harness.usage()[0]).toMatchObject({
      userId: 'emp_bob', departmentId: 'rd', model: PRO, status: 200, outcome: 'completed', estimated: false,
      inputTokens: REPLY_USAGE.input_tokens, cacheReadTokens: REPLY_USAGE.cache_read_input_tokens, cacheWriteTokens: 0, outputTokens: REPLY_USAGE.output_tokens,
      costMicros: 131,
    })
    expect(upstream.received[0].headers['x-api-key']).toBe('sk-rd')
    // 7 hit × 1 + 11 miss × 4 + 5 out × 16 = 131 元 per million tokens, i.e. 131 micro-yuan.
    expect(harness.store.spentSince('employee', 'emp_bob', 0)).toBe(131)
    expect(harness.store.spentSince('department', 'rd', 0)).toBe(131)
  })

  it('refuses unknown tokens without contacting DeepSeek', async () => {
    const response = await messages(harness.url, generateToken(), { model: FLASH, messages: [] })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error', code: 'keyhub_unauthorized', message: '授权码无效或已被管理员停用，请联系管理员' } })
    expect(upstream.received).toHaveLength(0)
  })

  it('refuses disabled employees and employees of disabled departments', async () => {
    harness.store.updateEmployee('emp_alice', { enabled: false })
    expect((await messages(harness.url, harness.alice, { model: FLASH, messages: [] })).status).toBe(400)
    harness.store.updateEmployee('emp_alice', { enabled: true })
    harness.store.putDepartment({ id: 'sales', name: '销售部', keyRef: 'KEY_SALES', enabled: false })
    expect((await messages(harness.url, harness.alice, { model: FLASH, messages: [] })).status).toBe(400)
    expect((await messages(harness.url, harness.bob, { model: FLASH, messages: [] })).status).toBe(200)
    expect(upstream.received).toHaveLength(1)
  })

  it('stops accepting a reset token at once', async () => {
    harness.store.resetToken('emp_alice')
    expect((await messages(harness.url, harness.alice, { model: FLASH, messages: [] })).status).toBe(400)
  })

  it('answers a missing department key with a message for the employee', async () => {
    await harness.close()
    harness = await startRelay(upstream, { KEY_RD: 'sk-rd' })
    const response = await messages(harness.url, harness.alice, { model: FLASH, messages: [] })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'keyhub_department_key_missing' } })
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
    expect(forbidden.status).toBe(400)
    expect(await forbidden.json()).toMatchObject({ error: { code: 'keyhub_model_not_allowed', message: `你没有使用模型 ${PRO} 的权限，请联系管理员` } })
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
    await waitFor(() => harness.usage().length === 1)
    const refused = await messages(harness.url, harness.bob, { model: PRO, messages: [] })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: 'keyhub_quota_exhausted', message: '你的本月额度已用完（已用 ¥0.0001，额度 ¥0.0001），请联系管理员' } })
    topUp(harness.store, 'employee', 'emp_bob', parseYuan('1'), undefined, Date.now())
    expect((await messages(harness.url, harness.bob, { model: PRO, messages: [] })).status).toBe(200)
  })

  it('refuses requests once the department quota is spent', async () => {
    harness.store.setQuota('department', 'rd', { micros: 1, period: 'total' }, 0)
    await (await messages(harness.url, harness.bob, { model: FLASH, messages: [] })).text()
    await waitFor(() => harness.usage().length === 1)
    const refused = await messages(harness.url, harness.bob, { model: FLASH, messages: [] })
    expect(refused.status).toBe(400)
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
    await waitFor(() => harness.usage().length === 1)
    expect(harness.usage()[0]).toMatchObject({ outcome: 'interrupted', inputTokens: 3, estimated: true })
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
    await waitFor(() => harness.usage().length === 1)
    expect(harness.usage()[0].outcome).toBe('interrupted')
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

  it('forwards Files API uploads with the department key and records the uploader', async () => {
    upstream.respond((request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'file_1', echoed: request.body.length }))
    })
    const response = await fetch(`${harness.url}/anthropic/v1/files`, { method: 'POST', headers: { 'x-api-key': harness.alice }, body: 'file-bytes' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'file_1', echoed: 10 })
    expect(upstream.received[0]).toMatchObject({ method: 'POST', path: '/anthropic/v1/files', body: 'file-bytes' })
    expect(upstream.received[0].headers['x-api-key']).toBe('sk-sales')
    expect(harness.store.fileOwner('file_1')).toBe('emp_alice')
    expect(harness.usage()).toHaveLength(0)
  })

  it('keeps each employee to their own files', async () => {
    harness.store.recordFile('file_alice', 'emp_alice', 'sales', 0)
    harness.store.recordFile('file_bob', 'emp_bob', 'rd', 0)
    upstream.respond((request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (request.path?.startsWith('/anthropic/v1/files?')) {
        res.end(JSON.stringify({ data: [{ id: 'file_alice' }, { id: 'file_bob' }, { id: 'file_foreign' }], has_more: true, first_id: 'file_alice', last_id: 'file_foreign' }))
      } else {
        res.end(JSON.stringify({ id: 'file_alice', deleted: true }))
      }
    })
    const list = await fetch(`${harness.url}/anthropic/v1/files?limit=1000`, { headers: { 'x-api-key': harness.alice } })
    expect(await list.json()).toEqual({ data: [{ id: 'file_alice' }], has_more: true, first_id: 'file_alice', last_id: 'file_foreign' })

    const foreign = await fetch(`${harness.url}/anthropic/v1/files/file_bob`, { method: 'DELETE', headers: { 'x-api-key': harness.alice } })
    expect(foreign.status).toBe(404)
    const unknown = await fetch(`${harness.url}/anthropic/v1/files/file_foreign`, { headers: { 'x-api-key': harness.alice } })
    expect(unknown.status).toBe(404)
    expect(upstream.received).toHaveLength(1)

    const own = await fetch(`${harness.url}/anthropic/v1/files/file_alice`, { method: 'DELETE', headers: { 'x-api-key': harness.alice } })
    expect(own.status).toBe(200)
    await own.text()
    expect(upstream.received[1]).toMatchObject({ method: 'DELETE', path: '/anthropic/v1/files/file_alice' })
    expect(harness.store.fileOwner('file_alice')).toBeUndefined()
  })

  it('verifies file_id ownership and department isolation in Messages requests', async () => {
    harness.store.recordFile('file_alice', 'emp_alice', 'sales', 0)
    harness.store.recordFile('file_bob', 'emp_bob', 'rd', 0)

    const foreign = await messages(harness.url, harness.alice, {
      model: FLASH,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'file_bob' } }] }],
    })
    expect(foreign.status).toBe(400)
    expect(await foreign.json()).toMatchObject({ error: { code: 'keyhub_file_forbidden', message: expect.stringContaining('file_bob') } })
    expect(upstream.received).toHaveLength(0)

    const allowed = await messages(harness.url, harness.alice, {
      model: FLASH,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'file_alice' } }] }],
    })
    expect(allowed.status).toBe(200)
    await allowed.text()
    expect(upstream.received).toHaveLength(1)

    // Moving Alice to another department isolates files uploaded under her old department's key.
    harness.store.updateEmployee('emp_alice', { departmentId: 'rd' })
    const moved = await messages(harness.url, harness.alice, {
      model: FLASH,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'file_alice' } }] }],
    })
    expect(moved.status).toBe(400)
    expect(await moved.json()).toMatchObject({ error: { code: 'keyhub_file_forbidden' } })
  })

  it('refuses expired tokens and interrupts in-flight streams upon expiration', async () => {
    harness.store.updateEmployee('emp_alice', { expiresAt: Date.now() - 1000 })
    const refused = await messages(harness.url, harness.alice, { model: FLASH, messages: [] })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: 'keyhub_token_expired', message: expect.stringContaining('已过期') } })
    expect((await fetch(`${harness.url}/keyhub/v1/status`, { headers: { 'x-api-key': harness.alice } })).status).toBe(400)

    harness.store.updateEmployee('emp_alice', { expiresAt: Date.now() + 60_000 })
    upstream.respond((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sseEvent(res, 'message_start', { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } })
    })
    const active = await messages(harness.url, harness.alice, { model: FLASH, messages: [] })
    const reader = active.body!.getReader()
    await reader.read()
    harness.store.updateEmployee('emp_alice', { expiresAt: Date.now() - 1 })
    harness.sync()
    await expect(async () => { while (!(await reader.read()).done) { /* drain */ } }).rejects.toThrow()
  })

  it('refuses file uploads above the size limit even without a declared length', async () => {
    const chunk = new Uint8Array(256 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8) controller.close()
        else {
          sent++
          controller.enqueue(chunk)
        }
      },
    })
    const response = await fetch(`${harness.url}/anthropic/v1/files`, { method: 'POST', headers: { 'x-api-key': harness.alice }, body, duplex: 'half' } as RequestInit)
    expect(response.status).toBe(413)
    expect(harness.store.fileOwner('file_1')).toBeUndefined()
  })

  it('refuses file uploads once the quota is spent, but still lets the employee list files', async () => {
    harness.store.setQuota('employee', 'emp_alice', { micros: 0, period: 'month' }, 0)
    const upload = await fetch(`${harness.url}/anthropic/v1/files`, { method: 'POST', headers: { 'x-api-key': harness.alice }, body: 'x' })
    expect(upload.status).toBe(400)
    upstream.respond((_request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [], has_more: false }))
    })
    expect((await fetch(`${harness.url}/anthropic/v1/files`, { headers: { 'x-api-key': harness.alice } })).status).toBe(200)
  })

  it('reports the employee standing on the status route', async () => {
    harness.store.setQuota('employee', 'emp_bob', { micros: parseYuan('10'), period: 'month' }, 0)
    harness.store.updateEmployee('emp_bob', { models: [PRO, 'deepseek-unpriced'] })
    const response = await fetch(`${harness.url}/keyhub/v1/status`, { headers: { 'x-api-key': harness.bob } })
    expect(await response.json()).toEqual({
      employee: 'Bob', userId: 'emp_bob', department: '研发部', models: [PRO], maxConcurrency: 2,
      quota: { employee: { period: 'month', quotaMicros: 10_000_000, allowanceMicros: 10_000_000, spentMicros: 0, remainingMicros: 10_000_000 } },
      relayVersion: PLUGIN_VERSION,
    })
  })

  it('counts the cost reserved by requests in flight against the quota', async () => {
    // One FLASH request reserves at least its max_tokens of output: 1 000 000 tokens × ¥3 per million = ¥3.
    harness.store.setQuota('employee', 'emp_alice', { micros: parseYuan('2'), period: 'month' }, 0)
    upstream.respond((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': keep-alive\n\n')
    })
    const first = await messages(harness.url, harness.alice, { model: FLASH, max_tokens: 1_000_000, messages: [] })
    expect(first.status).toBe(200)
    const second = await messages(harness.url, harness.alice, { model: FLASH, max_tokens: 16, messages: [] })
    expect(second.status).toBe(400)
    expect(await second.json()).toMatchObject({ error: { message: expect.stringContaining('已被进行中的请求占满') } })
    await first.body!.cancel()
    await waitFor(() => harness.usage().length === 1)
    upstream.respond((_request, res) => { streamReply(res, 'pong') })
    expect((await messages(harness.url, harness.alice, { model: FLASH, max_tokens: 16, messages: [] })).status).toBe(200)
  })

  it('bills generated output when the employee disconnects before the final usage', async () => {
    const text = '长城是中国古代的军事防御工程'
    upstream.respond((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sseEvent(res, 'message_start', { type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 0, output_tokens: 0 } } })
      sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } })
      sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } })
    })
    const response = await messages(harness.url, harness.alice, { model: FLASH, messages: [] })
    const reader = response.body!.getReader()
    let seen = ''
    while (!seen.includes('text_delta')) seen += new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    await waitFor(() => harness.usage().length === 1)
    const [row] = harness.usage()
    const expectedOutput = Math.ceil((Buffer.byteLength('plan') + Buffer.byteLength(text)) / ESTIMATE_BYTES_PER_OUTPUT_TOKEN)
    expect(row).toMatchObject({ outcome: 'interrupted', estimated: true, inputTokens: 20, outputTokens: expectedOutput })
    // 20 miss × 2 + output × 3, in 元 per million tokens = micro-yuan.
    expect(row!.costMicros).toBe(20 * 2 + expectedOutput * 3)
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
