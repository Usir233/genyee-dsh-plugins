/** Request rewriting applied by the admin relay before a request leaves for DeepSeek. */
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'

/**
 * Prefix DSH reserves for its request body extensions, such as `dsh_plugin_packages` (enabled plugin packages)
 * and `dsh_session_log` (the session's event log); no such field is forwarded.
 */
const DSH_EXTENSION_PREFIX = 'dsh_'

/**
 * Request headers dropped before forwarding: hop-by-hop headers, the employee's
 * credentials, the DSH device identifier, and content coding the relay must not
 * receive because it reads usage from the response stream.
 */
const DROPPED_REQUEST_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'host', 'content-length', 'accept-encoding',
  'x-api-key', 'authorization',
  'x-deepseek-harness-user-id',
])

/** Response headers dropped before answering the employee: hop-by-hop and length headers the relay recomputes. */
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'trailer', 'content-length',
])

/** Outcome of rewriting one Messages request body. */
export type BodyRewrite =
  | { readonly ok: true, readonly body: Buffer, readonly model: string | undefined, readonly maxTokens: number | undefined }
  | { readonly ok: false, readonly reason: string }

/**
 * Bind a Messages request to one employee.
 * Overwrites `metadata.user_id`, keeps the other `metadata` fields, and removes every DSH body extension field.
 * @param raw - the request body the employee sent.
 * @param userId - the employee's DeepSeek `user_id`.
 * @returns the rewritten JSON body with its `model` and `max_tokens`, or the reason the body is not a JSON object.
 */
export function rewriteMessagesBody(raw: Buffer, userId: string): BodyRewrite {
  let parsed: unknown
  try { parsed = JSON.parse(raw.toString('utf8')) }
  catch (_malformedJson) { return { ok: false, reason: 'request body is not valid JSON' } }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'request body is not a JSON object' }
  const body = parsed as Record<string, unknown>
  const metadata = typeof body.metadata === 'object' && body.metadata !== null && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : {}
  body.metadata = { ...metadata, user_id: userId }
  for (const field of Object.keys(body)) if (field.startsWith(DSH_EXTENSION_PREFIX)) delete body[field]
  return {
    ok: true,
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    model: typeof body.model === 'string' ? body.model : undefined,
    maxTokens: typeof body.max_tokens === 'number' && Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : undefined,
  }
}

/**
 * Header names a message lists in its `Connection` header; they are hop-by-hop for that message.
 * @param headers - the message headers.
 * @returns lowercase names.
 */
function connectionListed(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection
  return new Set((value ?? '').split(',').map(name => name.trim().toLowerCase()).filter(name => name.length > 0))
}

/**
 * Build upstream request headers.
 * @param incoming - headers the employee sent.
 * @param apiKey - the department's DeepSeek API key.
 * @param contentLength - byte length of the forwarded body, or `undefined` to stream it.
 * @returns headers with the employee credential replaced by `apiKey` and an identity content coding.
 */
export function upstreamHeaders(incoming: IncomingHttpHeaders, apiKey: string, contentLength: number | undefined): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  const listed = connectionListed(incoming)
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name) || listed.has(name)) continue
    headers[name] = value
  }
  headers['x-api-key'] = apiKey
  headers['accept-encoding'] = 'identity'
  if (contentLength !== undefined) headers['content-length'] = contentLength
  return headers
}

/**
 * Build the headers answered to the employee.
 * @param upstream - headers DeepSeek answered with.
 * @returns the headers without hop-by-hop and length fields.
 */
export function downstreamHeaders(upstream: IncomingHttpHeaders): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  const listed = connectionListed(upstream)
  for (const [name, value] of Object.entries(upstream)) {
    if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name) || listed.has(name)) continue
    headers[name] = value
  }
  return headers
}
