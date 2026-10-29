/** HTTP request handling of the admin relay: admission, rewriting, streaming, interruption, file ownership, and usage capture. */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Transform } from 'node:stream'
import type { Admission } from './directory.ts'
import type { CheckResult, PendingRequests, Refusal } from './quota.ts'
import { downstreamHeaders, rewriteMessagesBody, upstreamHeaders } from './rewrite.ts'
import type { ObservedUsage, UsageTap } from './usage.ts'
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
  /** Usage the response reported or implied; `undefined` when it reported none. */
  readonly observed: ObservedUsage | undefined
  /** Remote address of the employee connection. */
  readonly clientAddress: string | undefined
}

/** File ownership facilities of the ledger. */
export interface FileOwnership {
  /**
   * Record the uploader of a file.
   * @param fileId - DeepSeek file id from the upload response.
   * @param admission - the uploading employee.
   */
  record(fileId: string, admission: Admission): void
  /**
   * The uploader of a file.
   * @param fileId - DeepSeek file id.
   * @returns the uploader's user id, or `undefined` for a file the relay did not upload.
   */
  owner(fileId: string): string | undefined
  /**
   * Forget a deleted file.
   * @param fileId - DeepSeek file id.
   */
  forget(fileId: string): void
}

/** Facilities the relay handler needs from its host. */
export interface RelayDependencies<A extends Admission> {
  /**
   * Admit one authorization token.
   * @param token - the presented token.
   * @returns the employee and department, or `undefined` when the token is unknown or either is disabled.
   */
  admit(token: string): A | undefined
  /**
   * Decide whether an admitted Messages request may go to DeepSeek; called right before forwarding.
   * @param admission - the employee and department.
   * @param request - the request's `model`, `max_tokens`, and body size.
   * @param pending - the employee's and department's requests already in flight.
   * @returns the reservation to hold, or the refusal.
   */
  check(admission: A, request: { model: string | undefined, maxTokens: number | undefined, bodyBytes: number }, pending: PendingRequests): CheckResult
  /**
   * Decide whether an admitted employee may upload a file; only the quotas apply.
   * @param admission - the employee and department.
   * @param pending - the employee's and department's requests already in flight.
   * @returns the refusal, or `undefined` to forward.
   */
  checkUpload(admission: A, pending: PendingRequests): Refusal | undefined
  /**
   * Resolve a department key.
   * @param ref - the department's credential reference.
   * @returns the key, or `undefined` when none is configured.
   */
  resolveKey(ref: string): Promise<string | undefined>
  /**
   * Describe an employee's standing for `GET /keyhub/v1/status`.
   * @param admission - the employee and department.
   * @returns a JSON-serializable status body.
   */
  status(admission: A): object
  readonly files: FileOwnership
  /** DeepSeek Anthropic-compatible API root. */
  readonly upstreamBaseURL: string
  readonly upstreamReadTimeoutMs: number
  readonly maxRequestBytes: number
  /**
   * Persist one usage record; failures are the callee's to report.
   * @param record - the completed request's record.
   * @param admission - the employee and department the request ran as.
   */
  recordUsage(record: UsageRecord, admission: A): void
  /**
   * Report a contained failure.
   * @param message - diagnostic text without secrets.
   */
  warn(message: string): void
}

/** A relay request handler with control over in-flight requests. */
export interface Relay<A extends Admission> {
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
  interrupt(stillAdmitted: (admission: A) => boolean): void
  /** Abort every in-flight request. */
  closeAll(): void
}

/** Anthropic error `type` values the DSH DeepSeek adapter classifies. */
type ErrorType = Refusal['type'] | 'not_found_error' | 'request_too_large' | 'api_error'

const MESSAGES_PATH = '/anthropic/v1/messages'
const FILES_PATH = '/anthropic/v1/files'
const STATUS_PATH = '/keyhub/v1/status'
/** Bytes of a non-streaming response retained to read its usage or rewrite it. */
const BUFFERED_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024
/** Files API methods the DSH adapter uses. */
const FILE_METHODS = new Set(['GET', 'POST', 'DELETE'])
const NOT_FOUND_FILE = '文件不存在或不属于你'

/** The employee closed the connection before the request body ended. */
class ClientGoneError extends Error {}

/**
 * Resolve the Messages API root without duplicating an explicit `/v1` path, as the DSH adapter does.
 * @param baseURL - configured upstream root.
 * @returns the root beneath which `messages` and `files` live.
 */
export function apiRoot(baseURL: string): string {
  const base = baseURL.replace(/\/+$/u, '')
  return new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`
}

function replyError(res: ServerResponse, status: number, type: ErrorType, message: string, code?: string): void {
  if (res.headersSent || res.destroyed) {
    res.destroy()
    return
  }
  const body = JSON.stringify({ type: 'error', error: { type, ...code === undefined ? {} : { code }, message } })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function replyJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * Read a request body up to a limit.
 * @returns the body, or `undefined` when it exceeds `limit`.
 * @throws ClientGoneError when the connection closes before the body ends.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (settle: () => void): void => {
      if (done) return
      done = true
      settle()
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        req.removeAllListeners('data')
        req.resume()
        finish(() => { resolve(undefined) })
        return
      }
      chunks.push(chunk)
    })
    req.once('end', () => { finish(() => { resolve(Buffer.concat(chunks)) }) })
    req.on('error', (error) => { finish(() => { reject(error) }) })
    req.once('close', () => { finish(() => { reject(new ClientGoneError('the employee closed the connection')) }) })
  })
}

/**
 * Pass a request body through while counting it.
 * @param limit - largest accepted byte count.
 * @param onOverflow - called once when the body exceeds `limit`; the stream then fails.
 * @returns the counting stream.
 */
function byteLimit(limit: number, onOverflow: () => void): Transform {
  let size = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (size > limit) {
        onOverflow()
        callback(new Error(`request body exceeds ${limit} bytes`))
        return
      }
      callback(null, chunk)
    },
  })
}

/** How the relay handles a successful upstream response body. */
type ResponseMode =
  | { readonly kind: 'stream', readonly observeUsage: boolean }
  /** Buffer a JSON body and replace it; `rewrite` returns the bytes to answer. */
  | { readonly kind: 'buffer', rewrite(body: Buffer): Buffer }

/** One exchange in flight. */
interface InFlight<A> {
  readonly admission: A
  readonly kind: 'messages' | 'files'
  readonly reserveMicros: number
  abort(): void
}

/** Result of one forwarded exchange. */
interface Forwarded {
  readonly outcome: RequestOutcome
  readonly status: number | undefined
  readonly observed: ObservedUsage | undefined
}

/**
 * Create the relay request handler.
 * @param deps - host facilities and upstream settings.
 * @returns the handler and its in-flight request control.
 */
export function createRelay<A extends Admission>(deps: RelayDependencies<A>): Relay<A> {
  const root = apiRoot(deps.upstreamBaseURL)
  const inFlight = new Set<InFlight<A>>()

  const pendingOf = (admission: A): PendingRequests => {
    let count = 0
    let employeeMicros = 0
    let departmentMicros = 0
    for (const entry of inFlight) {
      const sameEmployee = entry.admission.employee.userId === admission.employee.userId
      if (sameEmployee && entry.kind === 'messages') count++
      if (sameEmployee) employeeMicros += entry.reserveMicros
      if (entry.admission.department.id === admission.department.id) departmentMicros += entry.reserveMicros
    }
    return { count, employeeMicros, departmentMicros }
  }

  const authenticate = (req: IncomingMessage, res: ServerResponse): A | undefined => {
    const token = req.headers['x-api-key']
    const admission = typeof token === 'string' && token.length > 0 ? deps.admit(token) : undefined
    // 400, not 401: DSH shows its own "API key invalid" text for 401 instead of this message (see Refusal).
    if (admission === undefined) replyError(res, 400, 'invalid_request_error', '授权码无效或已被管理员停用，请联系管理员', 'keyhub_unauthorized')
    return admission
  }

  const departmentKey = async (admission: A, res: ServerResponse): Promise<string | undefined> => {
    let key: string | undefined
    try { key = await deps.resolveKey(admission.department.keyRef) }
    catch (error) {
      deps.warn(`keyhub: resolving the key of department "${admission.department.id}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (key === undefined || key.length === 0) {
      replyError(res, 400, 'invalid_request_error', `管理端尚未配置部门“${admission.department.name}”的 DeepSeek Key，请联系管理员`, 'keyhub_department_key_missing')
      return undefined
    }
    return key
  }

  /**
   * Forward one request upstream and answer the employee.
   * @returns resolves once the exchange ended, with how it ended and the usage observed.
   */
  const forward = (
    req: IncomingMessage, res: ServerResponse, entryBase: Omit<InFlight<A>, 'abort'>, target: URL, method: string,
    headers: OutgoingHttpHeaders, body: Buffer | NodeJS.ReadableStream, mode: ResponseMode,
  ): Promise<Forwarded> => new Promise((resolve) => {
    let settled = false
    let status: number | undefined
    let tap: UsageTap | undefined
    const settle = (outcome: RequestOutcome): void => {
      if (settled) return
      settled = true
      inFlight.delete(entry)
      resolve({ outcome, status, observed: tap?.finish() })
    }
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method, headers })
    const entry: InFlight<A> = {
      ...entryBase,
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
    upstream.on('error', (error) => {
      if (settled) return
      deps.warn(`keyhub: upstream request for "${entryBase.admission.employee.userId}" failed: ${error.message}`)
      replyError(res, 502, 'api_error', `管理端无法连接 DeepSeek：${error.message}`)
      settle('failed')
    })
    upstream.once('response', (answer) => {
      status = answer.statusCode
      answer.on('error', () => {
        res.destroy()
        settle('failed')
      })
      if (mode.kind === 'buffer' && answer.statusCode === 200) {
        const chunks: Buffer[] = []
        let size = 0
        answer.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size <= BUFFERED_RESPONSE_LIMIT_BYTES) chunks.push(chunk)
        })
        answer.once('end', () => {
          if (size > BUFFERED_RESPONSE_LIMIT_BYTES) {
            replyError(res, 502, 'api_error', 'DeepSeek 文件接口的响应过大')
            settle('failed')
            return
          }
          let rewritten: Buffer
          try { rewritten = mode.rewrite(Buffer.concat(chunks)) }
          catch (error) {
            deps.warn(`keyhub: rewriting a Files API response failed: ${error instanceof Error ? error.message : String(error)}`)
            replyError(res, 502, 'api_error', 'DeepSeek 文件接口返回了无法识别的内容')
            settle('failed')
            return
          }
          const answerHeaders = downstreamHeaders(answer.headers)
          answerHeaders['content-length'] = rewritten.length
          res.writeHead(200, answerHeaders)
          res.end(rewritten)
          settle('completed')
        })
        return
      }
      res.writeHead(answer.statusCode ?? 502, downstreamHeaders(answer.headers))
      res.flushHeaders()
      if (mode.kind === 'stream' && mode.observeUsage && answer.statusCode === 200) {
        tap = String(answer.headers['content-type'] ?? '').includes('text/event-stream')
          ? streamUsageTap()
          : jsonUsageTap(BUFFERED_RESPONSE_LIMIT_BYTES)
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
    // Read now: the socket's address is gone once an interrupted exchange destroys it.
    const clientAddress = req.socket.remoteAddress
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
    const verdict = deps.check(admission, { model: rewrite.model, maxTokens: rewrite.maxTokens, bodyBytes: rewrite.body.length }, pendingOf(admission))
    if (!verdict.ok) {
      replyError(res, verdict.refusal.status, verdict.refusal.type, verdict.refusal.message, verdict.refusal.code)
      return
    }
    const result = await forward(
      req, res, { admission, kind: 'messages', reserveMicros: verdict.reserveMicros }, new URL(`${root}/messages`), 'POST',
      upstreamHeaders(req.headers, key, rewrite.body.length), rewrite.body, { kind: 'stream', observeUsage: true },
    )
    if (result.status === undefined && result.observed === undefined && result.outcome === 'failed') return
    deps.recordUsage({
      at: new Date().toISOString(),
      userId: admission.employee.userId,
      departmentId: admission.department.id,
      model: rewrite.model,
      status: result.status,
      outcome: result.outcome,
      observed: result.observed,
      clientAddress,
    }, admission)
  }

  /** Keep only the employee's own files in a `GET /files` page; paging fields stay as DeepSeek answered them. */
  const ownFilesPage = (admission: A) => (body: Buffer): Buffer => {
    const page = JSON.parse(body.toString('utf8')) as Record<string, unknown>
    if (!Array.isArray(page.data)) throw new Error('the file list has no data array')
    page.data = page.data.filter(file => typeof file === 'object' && file !== null
      && deps.files.owner(String((file as Record<string, unknown>).id)) === admission.employee.userId)
    return Buffer.from(JSON.stringify(page), 'utf8')
  }

  /** Record the uploader of a `POST /files` answer and pass the answer through unchanged. */
  const recordUpload = (admission: A) => (body: Buffer): Buffer => {
    const file = JSON.parse(body.toString('utf8')) as Record<string, unknown>
    if (typeof file.id !== 'string' || file.id.length === 0) throw new Error('the upload answer has no file id')
    deps.files.record(file.id, admission)
    return body
  }

  const files = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? 'GET'
    if (!FILE_METHODS.has(method)) {
      replyError(res, 405, 'invalid_request_error', 'method not allowed')
      return
    }
    const admission = authenticate(req, res)
    if (admission === undefined) return
    const rest = url.pathname.slice(FILES_PATH.length)
    const fileId = rest.length > 1 ? decodeURIComponent(rest.slice(1).split('/')[0]!) : undefined
    if (fileId !== undefined && deps.files.owner(fileId) !== admission.employee.userId) {
      replyError(res, 404, 'not_found_error', NOT_FOUND_FILE)
      return
    }
    const upload = fileId === undefined && method === 'POST'
    if (fileId === undefined && method === 'DELETE') {
      replyError(res, 405, 'invalid_request_error', 'method not allowed')
      return
    }
    if (upload) {
      const refusal = deps.checkUpload(admission, pendingOf(admission))
      if (refusal !== undefined) {
        replyError(res, refusal.status, refusal.type, refusal.message, refusal.code)
        return
      }
    }
    const declared = req.headers['content-length']
    const length = declared === undefined ? undefined : Number(declared)
    if (length !== undefined && length > deps.maxRequestBytes) {
      replyError(res, 413, 'request_too_large', `请求体超过管理端上限 ${deps.maxRequestBytes} 字节`)
      return
    }
    const key = await departmentKey(admission, res)
    if (key === undefined) return
    const target = new URL(`${root}${url.pathname.slice('/anthropic/v1'.length)}${url.search}`)
    const mode: ResponseMode = upload
      ? { kind: 'buffer', rewrite: recordUpload(admission) }
      : fileId === undefined && method === 'GET'
        ? { kind: 'buffer', rewrite: ownFilesPage(admission) }
        : { kind: 'stream', observeUsage: false }
    const body = byteLimit(deps.maxRequestBytes, () => {
      replyError(res, 413, 'request_too_large', `请求体超过管理端上限 ${deps.maxRequestBytes} 字节`)
    })
    // The overflow was answered with 413 above; closing that response aborts the upstream request.
    body.on('error', (_overflow) => { req.unpipe(body) })
    req.pipe(body)
    const result = await forward(
      req, res, { admission, kind: 'files', reserveMicros: 0 }, target, method,
      upstreamHeaders(req.headers, key, Number.isSafeInteger(length) ? length : undefined), body, mode,
    )
    if (fileId !== undefined && method === 'DELETE' && result.status !== undefined && result.status >= 200 && result.status < 300) {
      deps.files.forget(fileId)
    }
  }

  const status = (req: IncomingMessage, res: ServerResponse): void => {
    const admission = authenticate(req, res)
    if (admission === undefined) return
    replyJson(res, 200, deps.status(admission))
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
        if (error instanceof ClientGoneError) return
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
