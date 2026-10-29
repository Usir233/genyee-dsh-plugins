/**
 * The relay against the real DeepSeek API. Runs only with `DEEPSEEK_API_KEY` set in the environment or in the
 * repository's `.env`; every request uses `deepseek-flash` with small outputs to keep the cost to a few fen.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BalanceMonitor } from '../../src/admin/balance.ts'
import { createLedgerRelay } from '../../src/admin/ledger-relay.ts'
import type { LedgerRelay } from '../../src/admin/ledger-relay.ts'
import { parsePrice } from '../../src/admin/money.ts'
import { KeyhubStore } from '../../src/admin/store.ts'
import { ESTIMATE_BYTES_PER_OUTPUT_TOKEN } from '../../src/admin/usage.ts'

function readKey(): string | undefined {
  if (process.env.DEEPSEEK_API_KEY !== undefined && process.env.DEEPSEEK_API_KEY.length > 0) return process.env.DEEPSEEK_API_KEY
  const file = resolve(import.meta.dirname, '../../../../.env')
  if (!existsSync(file)) return undefined
  return /^DEEPSEEK_API_KEY=(.+)$/mu.exec(readFileSync(file, 'utf8'))?.[1]?.trim()
}

const KEY = readKey()
const FLASH = 'deepseek-flash'
/** A system prompt long enough for DeepSeek's context cache. */
const SYSTEM = `You are a terse assistant for the Genyee key hub test. ${Array.from({ length: 300 }, (_, index) => `Guideline ${index}: answer briefly about subject ${index}.`).join(' ')}`

describe.skipIf(KEY === undefined)('relay against the real DeepSeek API', () => {
  let dir: string
  let store: KeyhubStore
  let ledger: LedgerRelay
  let server: Server
  let url: string
  let alice: string
  let bob: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'keyhub-real-'))
    store = KeyhubStore.open(join(dir, 'ledger.db'))
    store.setTimeZone('Asia/Shanghai')
    store.putDepartment({ id: 'rd', name: '研发部', keyRef: 'KEY_RD', enabled: true })
    store.setPrice(FLASH, { inputCacheHit: parsePrice('0.2'), inputCacheMiss: parsePrice('2'), output: parsePrice('3') }, 0)
    alice = store.addEmployee({ userId: `emp_real_alice_${Date.now()}`, name: 'Alice', departmentId: 'rd' })
    bob = store.addEmployee({ userId: `emp_real_bob_${Date.now()}`, name: 'Bob', departmentId: 'rd' })
    ledger = createLedgerRelay(store, {
      timeZone: 'Asia/Shanghai', defaultMaxConcurrency: 4,
      upstreamBaseURL: 'https://api.deepseek.com/anthropic', upstreamReadTimeoutMs: 600_000, maxRequestBytes: 8 * 1024 * 1024,
      resolveKey: async ref => ref === 'KEY_RD' ? KEY : undefined,
      warn: (message) => { console.warn(message) },
    })
    server = createServer((req, res) => { ledger.relay.handle(req, res) })
    await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done) })
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    ledger?.relay.closeAll()
    if (server !== undefined) await new Promise<void>((done) => { server.close(() => { done() }); server.closeAllConnections() })
    store?.close()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  })

  const post = (token: string, body: object, headers: Record<string, string> = {}): Promise<Response> => fetch(`${url}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': token, ...headers },
    body: JSON.stringify(body),
  })
  const rows = () => store.usageRows({ from: 0, to: Number.MAX_SAFE_INTEGER })
  const settle = async (count: number): Promise<void> => {
    for (let attempt = 0; attempt < 100 && rows().length < count; attempt++) await new Promise(done => setTimeout(done, 50))
    expect(rows()).toHaveLength(count)
  }

  it('binds requests to each employee: caches are per user_id, usage and cost are recorded', async () => {
    const ask = { model: FLASH, max_tokens: 64, stream: true, system: SYSTEM, metadata: { user_id: 'forged' }, messages: [{ role: 'user', content: 'Say OK.' }] }
    for (const token of [alice, alice, bob]) {
      const response = await post(token, ask)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('message_stop')
    }
    await settle(3)
    const [first, second, third] = rows()
    expect(first).toMatchObject({ outcome: 'completed', estimated: false, cacheReadTokens: 0 })
    expect(first!.inputTokens).toBeGreaterThan(1000)
    // Alice's repeat hits her cache; Bob's identical request does not share Alice's.
    expect(second!.cacheReadTokens).toBeGreaterThan(1000)
    expect(third!.cacheReadTokens).toBe(0)
    for (const row of rows()) expect(row.costMicros).toBeGreaterThan(0)
    console.log('per-user cache:', rows().map(row => ({ user: row.userId.slice(9, 14), miss: row.inputTokens, hit: row.cacheReadTokens, out: row.outputTokens, micros: row.costMicros })))
  })

  it('carries a multi-turn tool call with anthropic-beta through the relay', async () => {
    const tools = [{ name: 'get_weather', description: 'Weather of a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }]
    const first = await post(alice, { model: FLASH, max_tokens: 400, tools, tool_choice: { type: 'any' }, messages: [{ role: 'user', content: 'What is the weather in Beijing? Use the tool.' }] }, { 'anthropic-beta': 'files-api-2025-04-14' })
    expect(first.status).toBe(200)
    const answer = await first.json() as { content: Array<{ type: string, id?: string, name?: string, input?: unknown }> }
    const call = answer.content.find(block => block.type === 'tool_use')
    expect(call).toMatchObject({ name: 'get_weather' })
    const second = await post(alice, {
      model: FLASH, max_tokens: 200, tools,
      messages: [
        { role: 'user', content: 'What is the weather in Beijing? Use the tool.' },
        { role: 'assistant', content: answer.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: call!.id, content: 'Sunny, 21°C' }] },
      ],
    }, { 'anthropic-beta': 'files-api-2025-04-14' })
    expect(second.status).toBe(200)
    const final = await second.json() as { content: Array<{ type: string, text?: string }> }
    expect(final.content.filter(block => block.type === 'text').map(block => block.text).join('')).toMatch(/21|sunny|晴/iu)
  })

  it('estimates output within reason when the employee disconnects mid-stream', async () => {
    const before = rows().length
    // A complete stream first, to compare streamed bytes with billed tokens.
    const full = await post(bob, { model: FLASH, max_tokens: 300, stream: true, messages: [{ role: 'user', content: '用中文写三句话介绍长城。' }] })
    const text = await full.text()
    let generated = 0
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue
      const event = JSON.parse(line.slice(6)) as { type: string, delta?: Record<string, unknown> }
      if (event.type !== 'content_block_delta') continue
      for (const field of ['text', 'thinking', 'partial_json']) if (typeof event.delta?.[field] === 'string') generated += Buffer.byteLength(event.delta[field] as string)
    }
    await settle(before + 1)
    const billed = rows().at(-1)!.outputTokens
    const estimate = Math.ceil(generated / ESTIMATE_BYTES_PER_OUTPUT_TOKEN)
    console.log('output calibration:', { generatedBytes: generated, billedTokens: billed, estimate, bytesPerToken: (generated / billed).toFixed(2) })
    expect(estimate).toBeGreaterThanOrEqual(Math.floor(billed * 0.8))

    const partial = await post(bob, { model: FLASH, max_tokens: 2000, stream: true, messages: [{ role: 'user', content: '写一篇 800 字的文章介绍长城。' }] })
    const reader = partial.body!.getReader()
    let seen = ''
    while (!seen.includes('content_block_delta')) seen += new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    await settle(before + 2)
    expect(rows().at(-1)).toMatchObject({ outcome: 'interrupted', estimated: true })
    expect(rows().at(-1)!.outputTokens).toBeGreaterThan(0)
  })

  it('reads the account balance', async () => {
    const monitor = new BalanceMonitor({ url: 'https://api.deepseek.com/user/balance', key: async () => KEY, lowBalanceYuan: 1, warn: () => {} })
    const reading = await monitor.refresh()
    expect(reading).toMatchObject({ state: 'ok', available: true })
    console.log('balance:', reading.state === 'ok' ? reading.balances : reading)
  })
})
