import { X509Certificate } from 'node:crypto'
import type { Server } from 'node:https'
import { createServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { generate } from 'selfsigned'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AccessCode } from '../src/access-code.ts'
import { generateToken, normalizeFingerprint } from '../src/access-code.ts'
import { startLocalProxy } from '../src/employee/local-proxy.ts'

describe('local proxy', () => {
  let relay: Server
  let relayURL: string
  let fingerprint: string
  const seen: Array<{ path: string | undefined, token: string | string[] | undefined }> = []
  const token = generateToken()

  beforeAll(async () => {
    const pems = await generate([{ name: 'commonName', value: 'keyhub-test' }], { keySize: 2048, extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }] })
    fingerprint = normalizeFingerprint(new X509Certificate(pems.cert).fingerprint256)
    relay = createServer({ cert: pems.cert, key: pems.private }, (req, res) => {
      seen.push({ path: req.url, token: req.headers['x-api-key'] })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(': keep-alive\n\nevent: message_stop\ndata: {}\n\n')
    })
    await new Promise<void>((resolve) => { relay.listen(0, '127.0.0.1', resolve) })
    relayURL = `https://127.0.0.1:${(relay.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    const closed = new Promise<void>((resolve) => { relay.close(() => { resolve() }) })
    relay.closeAllConnections()
    await closed
  })

  async function withProxy(code: () => Promise<AccessCode>, run: (baseURL: string, secret: string) => Promise<void>): Promise<void> {
    const proxy = await startLocalProxy({ accessCode: code, readTimeoutMs: 10_000 })
    try { await run(proxy.baseURL, proxy.secret) }
    finally { await proxy.close() }
  }

  it('forwards to the pinned relay with the employee token', async () => {
    seen.length = 0
    await withProxy(async () => ({ relayURL, fingerprint, token }), async (baseURL, secret) => {
      const response = await fetch(`${baseURL}/v1/messages`, { method: 'POST', headers: { 'x-api-key': secret }, body: '{}' })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain(': keep-alive')
    })
    expect(seen).toEqual([{ path: '/anthropic/v1/messages', token }])
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

  it('refuses callers without the per-launch secret', async () => {
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
