/**
 * Loopback proxy between the employee's DSH model route and the admin relay.
 * The DSH adapter sends requests with the global `fetch`, which cannot pin a certificate per request;
 * this proxy receives them on 127.0.0.1, swaps the per-launch secret for the employee's token,
 * and forwards them through a {@link PinnedAgent}.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Agent, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { AccessCode } from '../access-code.ts'
import { FingerprintMismatchError, PinnedAgent } from './pinned-agent.ts'

/** Request headers not forwarded to the relay. */
const DROPPED_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'x-api-key', 'authorization',
])

/** Response headers not forwarded back to the adapter. */
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'trailer'])

/** A running loopback proxy. */
export interface LocalProxy {
  /** Base URL the DSH route uses, ending in `/anthropic`. */
  readonly baseURL: string
  /** Per-launch secret the DSH route presents as its `x-api-key`. */
  readonly secret: string
  /** Stop listening and abort open exchanges. */
  close(): Promise<void>
}

/** Facilities the proxy needs from its host. */
export interface LocalProxyDependencies {
  /**
   * Read the current access code; called once per request.
   * @returns the decoded access code.
   * @throws Error when the code is missing or malformed; the message is shown to the employee.
   */
  accessCode(): Promise<AccessCode>
  /** Idle timeout of one relay response, in milliseconds. */
  readonly readTimeoutMs: number
}

function replyError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify({ type: 'error', error: { type, message } })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function sameSecret(presented: string | string[] | undefined, secret: Buffer): boolean {
  if (typeof presented !== 'string') return false
  const bytes = Buffer.from(presented, 'utf8')
  return bytes.length === secret.length && timingSafeEqual(bytes, secret)
}

/**
 * Start the loopback proxy on an OS-assigned port.
 * @param deps - access code source and timeouts.
 * @returns the running proxy.
 */
export async function startLocalProxy(deps: LocalProxyDependencies): Promise<LocalProxy> {
  const secret = randomBytes(32).toString('base64url')
  const secretBytes = Buffer.from(secret, 'utf8')
  const agents = new Map<string, Agent>()
  const open = new Set<{ destroy(): void }>()

  const agentFor = (code: AccessCode): Agent | undefined => {
    if (code.fingerprint === undefined) return undefined
    let agent = agents.get(code.fingerprint)
    if (agent === undefined) {
      agent = new PinnedAgent(code.fingerprint, { keepAlive: true })
      agents.set(code.fingerprint, agent)
    }
    return agent
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!sameSecret(req.headers['x-api-key'], secretBytes)) {
      replyError(res, 401, 'authentication_error', 'keyhub local proxy: unknown caller')
      return
    }
    let code: AccessCode
    try { code = await deps.accessCode() }
    catch (error) {
      // 400, not 401: DSH shows its own "API key invalid" text for 401 instead of this message.
      replyError(res, 400, 'invalid_request_error', error instanceof Error ? error.message : String(error))
      return
    }
    const headers: OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !DROPPED_HEADERS.has(name)) headers[name] = value
    }
    headers['x-api-key'] = code.token
    const target = new URL(req.url ?? '/', code.relayURL)
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: req.method, headers, agent: agentFor(code),
    })
    open.add(upstream)
    upstream.setTimeout(deps.readTimeoutMs, () => { upstream.destroy(new Error(`no data from the admin relay for ${deps.readTimeoutMs} ms`)) })
    upstream.on('error', (error) => {
      const message = error instanceof FingerprintMismatchError
        ? `管理端 ${code.relayURL} 的证书与接入码不符，已拒绝连接；请向管理员确认接入码`
        : `无法连接管理端 ${code.relayURL}：${error.message}；请确认管理员的 DSH 已打开`
      replyError(res, 502, 'api_error', message)
    })
    upstream.once('response', (answer) => {
      const forwarded: OutgoingHttpHeaders = {}
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) forwarded[name] = value
      }
      res.writeHead(answer.statusCode ?? 502, forwarded)
      res.flushHeaders()
      answer.pipe(res)
      answer.on('error', () => { res.destroy() })
    })
    upstream.once('close', () => { open.delete(upstream) })
    res.once('close', () => { if (!res.writableFinished) upstream.destroy() })
    req.pipe(upstream)
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      replyError(res, 500, 'api_error', `keyhub local proxy failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  server.requestTimeout = 0
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/anthropic`,
    secret,
    async close() {
      for (const exchange of open) exchange.destroy()
      const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      server.closeAllConnections()
      for (const agent of agents.values()) agent.destroy()
      await closed
    },
  }
}
