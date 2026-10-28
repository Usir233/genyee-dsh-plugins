/** HTTP request handling of the admin relay: admission, rewriting, streaming, interruption, and usage capture. */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Admission, Directory } from './directory.ts'
import { admit } from './directory.ts'
import { downstreamHeaders, rewriteMessagesBody, upstreamHeaders } from './rewrite.ts'
import type { TokenUsage, UsageTap } from './usage.ts'
import { jsonUsageTap, streamUsageTap } from './usage.ts'

/** How one Messages request ended. */
export type RequestOutcome = 'completed' | 'interrupted' | 'failed'

/** One usage record per Messages request that reached DeepSeek. */
export interface UsageRecord {
  /** ISO 8601 completion time. */
  readonly at: string
  readonly userId: string
  readonly departmentId: string
  readonly model: string | undefined
  /** Upstream HTTP status, or `undefined` when no response arrived. */
  readonly status: number | undefined
  readonly outcome: RequestOutcome
  /** Usage the response reported; `undefined` when it reported none. */
  readonly usage: TokenUsage | undefined
  /** Remote address of the employee connection. */
  readonly clientAddress: string | undefined
}

/** Facilities the relay handler needs from its host. */
export interface RelayDependencies {
  /** The current directory generation. */
  directory(): Directory
  /**
   * Resolve a department key.
   * @param ref - the department's credential reference.
   * @returns the key, or `undefined` when none is configured.
   */
  resolveKey(ref: string): Promise<string | undefined>
  /** DeepSeek Anthropic-compatible API root. */
  readonly upstreamBaseURL: string
  readonly upstreamReadTimeoutMs: number
  readonly maxRequestBytes: number
  /**
   * Persist one usage record; failures are the callee's to report.
   * @param record - the completed request's record.
   */
  recordUsage(record: UsageRecord): void
  /**
   * Report a contained failure.
   * @param message - diagnostic text without secrets.
   */
  warn(message: string): void
}

/** A relay request handler with control over in-flight requests. */
export interface Relay {
  /**
   * Serve one HTTP request.
   * @param req - the employee request.
   * @param res - its response.
   */
  handle(req: IncomingMessage, res: ServerResponse): void
  /**
   * Abort every in-flight request whose admission no longer passes.
   * @param stillAdmitted - returns whether a request's employee may continue.
   */
  interrupt(stillAdmitted: (admission: Admission) => boolean): void
  /** Abort every in-flight request. */
  closeAll(): void
}

/** Anthropic error `type` values the DSH DeepSeek adapter classifies. */
type ErrorType = 'authentication_error' | 'permission_error' | 'invalid_request_error' | 'not_found_error' | 'request_too_large' | 'api_error'

const MESSAGES_PATH = '/anthropic/v1/messages'
const FILES_PATH = '/anthropic/v1/files'
const STATUS_PATH = '/keyhub/v1/status'
/** Bytes of a non-streaming response retained to read its usage. */
const JSON_USAGE_LIMIT_BYTES = 4 * 1024 * 1024

/**
 * Resolve the Messages API root without duplicating an explicit `/v1` path, as the DSH adapter does.
 * @param baseURL - configured upstream root.
 * @returns the root beneath which `messages` and `files` live.
 */
export function apiRoot(baseURL: string): string {
  const base = baseURL.replace(/\/+$/u, '')
  return new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`
}

function replyError(res: ServerResponse, status: number, type: ErrorType, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify({ type: 'error', error: { type, message } })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        req.removeAllListeners('data')
        req.resume()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.once('end', () => { resolve(Buffer.concat(chunks)) })
    req.once('error', reject)
  })
}

/**
 * Create the relay request handler.
 * @param deps - host facilities and upstream settings.
 * @returns the handler and its in-flight request control.
 */
export function createRelay(deps: RelayDependencies): Relay {
  const root = apiRoot(deps.upstreamBaseURL)
  const inFlight = new Set<{ readonly admission: Admission, abort(): void }>()

  const authenticate = (req: IncomingMessage, res: ServerResponse): Admission | undefined => {
    const token = req.headers['x-api-key']
    const admission = typeof token === 'string' && token.length > 0 ? admit(deps.directory(), token) : undefined
    if (admission === undefined) replyError(res, 401, 'authentication_error', '授权码无效或已被管理员停用，请联系管理员')
    return admission
  }

  const departmentKey = async (admission: Admission, res: ServerResponse): Promise<string | undefined> => {
    let key: string | undefined
    try { key = await deps.resolveKey(admission.department.keyRef) }
    catch (error) {
      deps.warn(`keyhub: resolving the key of department "${admission.department.id}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (key === undefined || key.length === 0) {
      replyError(res, 403, 'permission_error', `管理端尚未配置部门“${admission.department.name}”的 DeepSeek Key，请联系管理员`)
      return undefined
    }
    return key
  }

  /**
   * Forward one request upstream and stream the answer back.
   * @returns resolves once the exchange ended, with how it ended and the usage observed.
   */
  const forward = (
    req: IncomingMessage, res: ServerResponse, admission: Admission, target: URL,
    headers: OutgoingHttpHeaders, body: Buffer | IncomingMessage, observeUsage: boolean,
  ): Promise<{ outcome: RequestOutcome, status: number | undefined, usage: TokenUsage | undefined }> => new Promise((resolve) => {
    let settled = false
    let status: number | undefined
    let tap: UsageTap | undefined
    const settle = (outcome: RequestOutcome): void => {
      if (settled) return
      settled = true
      inFlight.delete(entry)
      resolve({ outcome, status, usage: tap?.finish() })
    }
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: req.method, headers })
    const entry = {
      admission,
      abort() {
        upstream.destroy()
        res.destroy()
        settle('interrupted')
      },
    }
    inFlight.add(entry)
    upstream.setTimeout(deps.upstreamReadTimeoutMs, () => {
      upstream.destroy(new Error(`no upstream data for ${deps.upstreamReadTimeoutMs} ms`))
    })
    upstream.once('error', (error) => {
      if (settled) return
      deps.warn(`keyhub: upstream request for "${admission.employee.userId}" failed: ${error.message}`)
      replyError(res, 502, 'api_error', `管理端无法连接 DeepSeek：${error.message}`)
      settle('failed')
    })
    upstream.once('response', (answer) => {
      status = answer.statusCode
      res.writeHead(answer.statusCode ?? 502, downstreamHeaders(answer.headers))
      res.flushHeaders()
      if (observeUsage && answer.statusCode === 200) {
        tap = String(answer.headers['content-type'] ?? '').includes('text/event-stream')
          ? streamUsageTap()
          : jsonUsageTap(JSON_USAGE_LIMIT_BYTES)
      }
      answer.on('data', (chunk: Buffer) => {
        tap?.push(chunk)
        if (!res.write(chunk)) {
          answer.pause()
          res.once('drain', () => { answer.resume() })
        }
      })
      answer.once('end', () => {
        res.end()
        settle('completed')
      })
      answer.once('error', () => {
        res.destroy()
        settle('failed')
      })
    })
    res.once('close', () => {
      if (settled) return
      upstream.destroy()
      settle('interrupted')
    })
    if (Buffer.isBuffer(body)) upstream.end(body)
    else body.pipe(upstream)
  })

  const messages = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const admission = authenticate(req, res)
    if (admission === undefined) return
    const raw = await readBody(req, deps.maxRequestBytes)
    if (raw === undefined) {
      replyError(res, 413, 'request_too_large', `请求体超过管理端上限 ${deps.maxRequestBytes} 字节`)
      return
    }
    const rewrite = rewriteMessagesBody(raw, admission.employee.userId)
    if (!rewrite.ok) {
      replyError(res, 400, 'invalid_request_error', rewrite.reason)
      return
    }
    const key = await departmentKey(admission, res)
    if (key === undefined) return
    const target = new URL(`${root}/messages`)
    const result = await forward(req, res, admission, target, upstreamHeaders(req.headers, key, rewrite.body.length), rewrite.body, true)
    if (result.status === undefined && result.usage === undefined && result.outcome === 'failed') return
    deps.recordUsage({
      at: new Date().toISOString(),
      userId: admission.employee.userId,
      departmentId: admission.department.id,
      model: rewrite.model,
      status: result.status,
      outcome: result.outcome,
      usage: result.usage,
      clientAddress: req.socket.remoteAddress,
    })
  }

  const files = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const admission = authenticate(req, res)
    if (admission === undefined) return
    const key = await departmentKey(admission, res)
    if (key === undefined) return
    const declared = req.headers['content-length']
    const length = declared === undefined ? undefined : Number(declared)
    if (length !== undefined && length > deps.maxRequestBytes) {
      replyError(res, 413, 'request_too_large', `请求体超过管理端上限 ${deps.maxRequestBytes} 字节`)
      return
    }
    // TODO: record the uploading employee of each file id and refuse other employees' file ids.
    const target = new URL(`${root}${url.pathname.slice('/anthropic/v1'.length)}${url.search}`)
    await forward(req, res, admission, target, upstreamHeaders(req.headers, key, Number.isSafeInteger(length) ? length : undefined), req, false)
  }

  const status = (req: IncomingMessage, res: ServerResponse): void => {
    const admission = authenticate(req, res)
    if (admission === undefined) return
    const body = JSON.stringify({ employee: admission.employee.name, department: admission.department.name })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://relay')
    if (url.pathname === MESSAGES_PATH) {
      if (req.method !== 'POST') replyError(res, 405, 'invalid_request_error', 'method not allowed')
      else await messages(req, res)
    } else if (url.pathname === FILES_PATH || url.pathname.startsWith(`${FILES_PATH}/`)) {
      await files(req, res, url)
    } else if (url.pathname === STATUS_PATH && req.method === 'GET') {
      status(req, res)
    } else {
      replyError(res, 404, 'not_found_error', `no relay route for ${url.pathname}`)
    }
  }

  return {
    handle(req, res) {
      route(req, res).catch((error: unknown) => {
        deps.warn(`keyhub: relay request failed: ${error instanceof Error ? error.message : String(error)}`)
        replyError(res, 500, 'api_error', '管理端处理请求时出错')
      })
    },
    interrupt(stillAdmitted) {
      for (const entry of [...inFlight]) if (!stillAdmitted(entry.admission)) entry.abort()
    },
    closeAll() {
      for (const entry of [...inFlight]) entry.abort()
    },
  }
}
