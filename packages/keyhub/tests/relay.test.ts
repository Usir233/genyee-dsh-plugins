import type { Server } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateToken } from '../src/access-code.ts'
import type { Directory } from '../src/admin/directory.ts'
import { hashToken, parseDirectory } from '../src/admin/directory.ts'
import type { Relay, UsageRecord } from '../src/admin/relay.ts'
import { apiRoot, createRelay } from '../src/admin/relay.ts'
import type { MockDeepSeek } from './support/mock-deepseek.ts'
import { REPLY_USAGE, sseEvent, startMockDeepSeek } from './support/mock-deepseek.ts'

const alice = generateToken()
const bob = generateToken()

function directoryYaml(options: { aliceEnabled?: boolean, salesEnabled?: boolean } = {}): string {
  return `
departments:
  - { id: sales, name: 销售部, keyRef: KEY_SALES, enabled: ${options.salesEnabled ?? true} }
  - { id: rd, name: 研发部, keyRef: KEY_RD }
employees:
  - { userId: emp_alice, name: Alice, department: sales, tokenSha256: ${hashToken(alice)}, enabled: ${options.aliceEnabled ?? true} }
  - { userId: emp_bob, name: Bob, department: rd, tokenSha256: ${hashToken(bob)} }
`
}

interface Harness {
  readonly url: string
  readonly relay: Relay
  readonly usage: UsageRecord[]
  setDirectory(directory: Directory): void
  close(): Promise<void>
}

async function startRelay(upstream: MockDeepSeek, keys: Record<string, string> = { KEY_SALES: 'sk-sales', KEY_RD: 'sk-rd' }): Promise<Harness> {
  let directory = parseDirectory(directoryYaml(), 'test.yml')
  const usage: UsageRecord[] = []
  const relay = createRelay({
    directory: () => directory,
    resolveKey: async ref => keys[ref],
    upstreamBaseURL: upstream.baseURL,
    upstreamReadTimeoutMs: 600_000,
    maxRequestBytes: 1024 * 1024,
    recordUsage: record => { usage.push(record) },
    warn: () => {},
  })
  const server: Server = createServer((req, res) => { relay.handle(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    relay,
    usage,
    setDirectory(next) { directory = next },
    async close() {
      relay.closeAll()
      const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      server.closeAllConnections()
      await closed
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
    const response = await messages(harness.url, alice, {
      model: 'deepseek-flash', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }],
      metadata: { user_id: 'emp_bob', other: 'kept' },
      dsh_plugin_packages: ['secret-plugin'],
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
    expect(body.model).toBe('deepseek-flash')
  })

  it('records the usage the stream reported', async () => {
    await (await messages(harness.url, bob, { model: 'deepseek-v4-pro', messages: [] })).text()
    await waitFor(() => harness.usage.length === 1)
    expect(harness.usage[0]).toMatchObject({
      userId: 'emp_bob', departmentId: 'rd', model: 'deepseek-v4-pro', status: 200, outcome: 'completed',
      usage: { inputTokens: REPLY_USAGE.input_tokens, cacheReadTokens: REPLY_USAGE.cache_read_input_tokens, cacheWriteTokens: 0, outputTokens: REPLY_USAGE.output_tokens },
    })
    expect(upstream.received[0].headers['x-api-key']).toBe('sk-rd')
  })

  it('refuses unknown tokens without contacting DeepSeek', async () => {
    const response = await messages(harness.url, generateToken(), { messages: [] })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } })
    expect(upstream.received).toHaveLength(0)
  })

  it('refuses disabled employees and employees of disabled departments', async () => {
    harness.setDirectory(parseDirectory(directoryYaml({ aliceEnabled: false }), 'test.yml'))
    expect((await messages(harness.url, alice, { messages: [] })).status).toBe(401)
    harness.setDirectory(parseDirectory(directoryYaml({ salesEnabled: false }), 'test.yml'))
    expect((await messages(harness.url, alice, { messages: [] })).status).toBe(401)
    expect((await messages(harness.url, bob, { messages: [] })).status).toBe(200)
    expect(upstream.received).toHaveLength(1)
  })

  it('answers a missing department key with a permission error', async () => {
    await harness.close()
    harness = await startRelay(upstream, { KEY_RD: 'sk-rd' })
    const response = await messages(harness.url, alice, { messages: [] })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { type: 'permission_error' } })
    expect(upstream.received).toHaveLength(0)
  })

  it('rejects bodies that are not JSON objects', async () => {
    const response = await fetch(`${harness.url}/anthropic/v1/messages`, { method: 'POST', headers: { 'x-api-key': alice }, body: '[1]' })
    expect(response.status).toBe(400)
  })

  it('rejects bodies above the size limit', async () => {
    const response = await messages(harness.url, alice, { padding: 'x'.repeat(2 * 1024 * 1024) })
    expect(response.status).toBe(413)
    expect(upstream.received).toHaveLength(0)
  })

  it('interrupts a streaming request when the employee is disabled', async () => {
    upstream.respond((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sseEvent(res, 'message_start', { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } })
    })
    const response = await messages(harness.url, alice, { model: 'deepseek-flash', messages: [] })
    const reader = response.body!.getReader()
    await reader.read()
    harness.setDirectory(parseDirectory(directoryYaml({ aliceEnabled: false }), 'test.yml'))
    harness.relay.interrupt(({ employee }) => employee.userId !== 'emp_alice')
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
    const response = await messages(harness.url, alice, { messages: [] })
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
    const response = await messages(harness.url, alice, { messages: [] })
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: { message: 'busy' } })
  })

  it('forwards Files API requests with the department key', async () => {
    upstream.respond((request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'file_1', echoed: request.body.length }))
    })
    const response = await fetch(`${harness.url}/anthropic/v1/files?limit=5`, { method: 'POST', headers: { 'x-api-key': alice }, body: 'file-bytes' })
    expect(response.status).toBe(200)
    expect(upstream.received[0]).toMatchObject({ method: 'POST', path: '/anthropic/v1/files?limit=5', body: 'file-bytes' })
    expect(upstream.received[0].headers['x-api-key']).toBe('sk-sales')
    expect(harness.usage).toHaveLength(0)
  })

  it('reports the employee on the status route', async () => {
    const response = await fetch(`${harness.url}/keyhub/v1/status`, { headers: { 'x-api-key': bob } })
    expect(await response.json()).toEqual({ employee: 'Bob', department: '研发部' })
  })

  it('streams events to the employee before the upstream response ends', async () => {
    let finish: (() => void) | undefined
    upstream.respond((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': keep-alive\n\n')
      finish = () => { res.end() }
    })
    const response = await messages(harness.url, alice, { messages: [] })
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
