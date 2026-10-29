import { X509Certificate } from 'node:crypto'
import type { Server } from 'node:https'
import { createServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { generate } from 'selfsigned'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AccessCode } from '../src/access-code.ts'
import { generateToken, normalizeFingerprint } from '../src/access-code.ts'
import { proxyPort, proxySecret } from '../src/employee/identity.ts'
import { startLocalProxy } from '../src/employee/local-proxy.ts'

describe('local proxy', () => {
  let relay: Server
  let relayURL: string
  let fingerprint: string
  const seen: Array<{ path: string | undefined, token: string | string[] | undefined, deviceId?: string | string[] | undefined, body?: string }> = []
  const token = generateToken()

  beforeAll(async () => {
    const pems = await generate([{ name: 'commonName', value: 'keyhub-test' }], { keySize: 2048, extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }] })
    fingerprint = normalizeFingerprint(new X509Certificate(pems.cert).fingerprint256)
    relay = createServer({ cert: pems.cert, key: pems.private }, (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      req.on('end', () => {
        seen.push({ path: req.url, token: req.headers['x-api-key'], deviceId: req.headers['x-deepseek-harness-user-id'], body: Buffer.concat(chunks).toString('utf8') })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(': keep-alive\n\nevent: message_stop\ndata: {}\n\n')
      })
    })
    await new Promise<void>((resolve) => { relay.listen(0, '127.0.0.1', resolve) })
    relayURL = `https://127.0.0.1:${(relay.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    const closed = new Promise<void>((resolve) => { relay.close(() => { resolve() }) })
    relay.closeAllConnections()
    await closed
  })

  const SECRET = 'route-secret'

  async function withProxy(code: () => Promise<AccessCode>, run: (baseURL: string, secret: string) => Promise<void>, preferredPort = 0): Promise<void> {
    const proxy = await startLocalProxy({ accessCode: code, secret: async () => SECRET, readTimeoutMs: 10_000, maxRequestBytes: 1024 * 1024, preferredPort })
    try { await run(proxy.baseURL, SECRET) }
    finally { await proxy.close() }
  }

  it('forwards to the pinned relay with the employee token and without DSH extensions', async () => {
    seen.length = 0
    await withProxy(async () => ({ relayURL, fingerprint, token }), async (baseURL, secret) => {
      const response = await fetch(`${baseURL}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': secret, 'x-deepseek-harness-user-id': 'device-1' },
        body: JSON.stringify({ model: 'deepseek-flash', dsh_session_log: { events: ['secret'] }, dsh_plugin_packages: ['x'], messages: [] }),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain(': keep-alive')
    })
    expect(seen).toEqual([{ path: '/anthropic/v1/messages', token, deviceId: undefined, body: JSON.stringify({ model: 'deepseek-flash', messages: [] }) }])
  })

  it('streams other requests through unchanged', async () => {
    seen.length = 0
    await withProxy(async () => ({ relayURL, fingerprint, token }), async (baseURL, secret) => {
      expect((await fetch(`${baseURL}/v1/files`, { method: 'POST', headers: { 'x-api-key': secret }, body: 'dsh_raw-bytes' })).status).toBe(200)
    })
    expect(seen).toMatchObject([{ path: '/anthropic/v1/files', body: 'dsh_raw-bytes' }])
  })

  it('listens on the preferred port, and on another one when it is taken', async () => {
    const preferred = proxyPort(`test-installation-${process.pid}-${Date.now()}`)
    await withProxy(async () => ({ relayURL, fingerprint, token }), async (first) => {
      expect(new URL(first).port).toBe(String(preferred))
      await withProxy(async () => ({ relayURL, fingerprint, token }), async (second) => {
        expect(new URL(second).port).not.toBe(String(preferred))
      }, preferred)
    }, preferred)
  })

  it('refuses a relay whose certificate does not match, before sending the token', async () => {
    seen.length = 0
    await withProxy(async () => ({ relayURL, fingerprint: 'cd'.repeat(32), token }), async (baseURL, secret) => {
      const response = await fetch(`${baseURL}/v1/messages`, { method: 'POST', headers: { 'x-api-key': secret }, body: '{}' })
      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('证书与接入码不符') } })
    })
    expect(seen).toHaveLength(0)
  })

  it('refuses callers without the route secret', async () => {
    await withProxy(async () => ({ relayURL, fingerprint, token }), async (baseURL) => {
      expect((await fetch(`${baseURL}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'guess' }, body: '{}' })).status).toBe(401)
    })
  })

  it('shows the access-code problem to the employee', async () => {
    await withProxy(async () => { throw new Error('尚未填写 Genyee 接入码') }, async (baseURL, secret) => {
      const response = await fetch(`${baseURL}/v1/messages`, { method: 'POST', headers: { 'x-api-key': secret }, body: '{}' })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { message: '尚未填写 Genyee 接入码' } })
    })
  })

  it('reports an unreachable relay', async () => {
    await withProxy(async () => ({ relayURL: 'https://127.0.0.1:1', fingerprint, token }), async (baseURL, secret) => {
      const response = await fetch(`${baseURL}/v1/messages`, { method: 'POST', headers: { 'x-api-key': secret }, body: '{}' })
      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('无法连接管理端') } })
    })
  })
})

describe('proxy identity', () => {
  it('derives a stable port and secret', () => {
    const token = generateToken()
    expect(proxySecret(token)).toBe(proxySecret(token))
    expect(proxySecret(token)).not.toBe(proxySecret(generateToken()))
    expect(proxySecret(token)).not.toContain(token.slice(3))
    const port = proxyPort('/Users/a/.dsh\0GENYEE_KEYHUB_ACCESS_CODE')
    expect(port).toBe(proxyPort('/Users/a/.dsh\0GENYEE_KEYHUB_ACCESS_CODE'))
    expect(port).toBeGreaterThanOrEqual(40_000)
    expect(port).toBeLessThan(50_000)
  })
})
