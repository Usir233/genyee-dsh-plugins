/**
 * Loopback proxy between the employee's DSH model route and the admin relay.
 * The DSH adapter sends requests with the global `fetch`, which cannot pin a certificate per request;
 * this proxy receives them on 127.0.0.1, removes DSH's body extensions and device identifier, swaps the route
 * secret for the employee's token, and forwards them through a {@link PinnedAgent}.
 */
import { timingSafeEqual } from 'node:crypto'
import type { Agent, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { AccessCode } from '../access-code.ts'
import { stripDshExtensions } from '../dsh-extensions.ts'
import { FingerprintMismatchError, PinnedAgent } from './pinned-agent.ts'

/** Request headers not forwarded to the relay, including DSH's anonymous device identifier. */
const DROPPED_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'x-api-key', 'authorization',
  'content-length', 'x-deepseek-harness-user-id',
])

/** Response headers not forwarded back to the adapter. */
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'trailer'])

/** Path of Messages requests, whose JSON bodies lose their DSH extensions here. */
const MESSAGES_PATH = '/anthropic/v1/messages'

/** A running loopback proxy. */
export interface LocalProxy {
  /** Base URL the DSH route uses, ending in `/anthropic`. */
  readonly baseURL: string
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
  /**
   * The secret the DSH route currently presents; called once per request.
   * @returns the expected `x-api-key` value.
   */
  secret(): Promise<string>
  /** Idle timeout of one relay response, in milliseconds. */
  readonly readTimeoutMs: number
  /** Largest Messages request body read for rewriting, in bytes. */
  readonly maxRequestBytes: number
  /** Port to listen on first; `0`, or a port in use, falls back to an OS-assigned port. */
  readonly preferredPort: number
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

function sameSecret(presented: string | string[] | undefined, secret: string): boolean {
  if (typeof presented !== 'string') return false
  const bytes = Buffer.from(presented, 'utf8')
  const expected = Buffer.from(secret, 'utf8')
  return bytes.length === expected.length && timingSafeEqual(bytes, expected)
}

/**
 * Read a request body up to a limit.
 * @returns the body, or `undefined` when it exceeds `limit`.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        req.removeAllListeners('data')
        req.resume()
        if (!done) resolve(undefined)
        done = true
        return
      }
      chunks.push(chunk)
    })
    req.once('end', () => {
      if (!done) resolve(Buffer.concat(chunks))
      done = true
    })
    req.on('error', (error) => {
      if (!done) reject(error)
      done = true
    })
  })
}

/**
 * Listen on the preferred loopback port, or on an OS-assigned one when it is `0` or taken.
 * @returns the bound port.
 */
async function listen(server: Server, preferredPort: number): Promise<number> {
  const attempt = (port: number): Promise<void> => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  if (preferredPort !== 0) {
    try { await attempt(preferredPort) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      // Another process holds the derived port; an OS-assigned port only costs the file cache across launches.
      await attempt(0)
    }
  } else {
    await attempt(0)
  }
  return (server.address() as AddressInfo).port
}

/**
 * Start the loopback proxy.
 * @param deps - access code and secret sources, limits, and the preferred port.
 * @returns the running proxy.
 */
export async function startLocalProxy(deps: LocalProxyDependencies): Promise<LocalProxy> {
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
    if (!sameSecret(req.headers['x-api-key'], await deps.secret())) {
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
    let body: Buffer | undefined
    if (req.method === 'POST' && new URL(req.url ?? '/', 'http://proxy').pathname === MESSAGES_PATH) {
      const raw = await readBody(req, deps.maxRequestBytes)
      if (raw === undefined) {
        replyError(res, 413, 'request_too_large', `请求体超过本机上限 ${deps.maxRequestBytes} 字节`)
        return
      }
      body = stripDshExtensions(raw)
    }
    const headers: OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !DROPPED_HEADERS.has(name)) headers[name] = value
    }
    headers['x-api-key'] = code.token
    if (body !== undefined) headers['content-length'] = body.length
    else if (req.headers['content-length'] !== undefined) headers['content-length'] = req.headers['content-length']
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
    if (body !== undefined) upstream.end(body)
    else req.pipe(upstream)
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      replyError(res, 500, 'api_error', `keyhub local proxy failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  server.requestTimeout = 0
  const port = await listen(server, deps.preferredPort)
  return {
    baseURL: `http://127.0.0.1:${port}/anthropic`,
    async close() {
      for (const exchange of open) exchange.destroy()
      const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      server.closeAllConnections()
      for (const agent of agents.values()) agent.destroy()
      await closed
    },
  }
}
