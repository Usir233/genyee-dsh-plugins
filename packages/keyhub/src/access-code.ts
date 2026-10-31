/** Access codes: the admin relay address, its certificate fingerprint, and one employee's authorization token in one pasteable string. */
import { randomBytes } from 'node:crypto'

/** Relay origin and certificate fingerprint, without an employee token. */
export interface RelayEndpoint {
  /** Relay origin, `https://host:port` (or `http://` for a relay serving plain HTTP). */
  readonly relayURL: string
  /** Lowercase hex SHA-256 fingerprint of the relay certificate; absent for plain HTTP. */
  readonly fingerprint: string | undefined
}

/** Decoded access code. */
export interface AccessCode extends RelayEndpoint {
  /** The employee's authorization token. */
  readonly token: string
}

const PREFIX = 'gkh1.'
const UPDATE_PREFIX = 'gkhu1.'
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u
const TOKEN_PATTERN = /^gk_[A-Za-z0-9_-]{43}$/u

function parseEndpoint(u: unknown, f: unknown, label: string): RelayEndpoint {
  if (typeof u !== 'string' || (f !== undefined && typeof f !== 'string')) {
    throw new Error(`${label}格式不正确：缺少管理端地址`)
  }
  let url: URL
  try { url = new URL(u) }
  catch (_invalidUrl) { throw new Error(`${label}格式不正确：管理端地址无效`) }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${label}格式不正确：管理端地址必须是 http 或 https`)
  if (url.protocol === 'https:' && (f === undefined || !FINGERPRINT_PATTERN.test(f))) throw new Error(`${label}格式不正确：缺少管理端证书指纹`)
  return { relayURL: url.origin, fingerprint: url.protocol === 'https:' ? f : undefined }
}

/**
 * Normalize a certificate fingerprint written with or without colons, in either case.
 * @param value - fingerprint text, such as Node's `fingerprint256`.
 * @returns lowercase hex without separators.
 */
export function normalizeFingerprint(value: string): string {
  return value.replaceAll(':', '').toLowerCase()
}

/**
 * Generate a new authorization token.
 * @returns `gk_` followed by 256 random bits in base64url.
 */
export function generateToken(): string {
  return `gk_${randomBytes(32).toString('base64url')}`
}

/**
 * Encode an access code.
 * @param code - relay address, fingerprint, and token.
 * @returns the pasteable access code.
 */
export function encodeAccessCode(code: AccessCode): string {
  const payload = { u: code.relayURL, ...code.fingerprint === undefined ? {} : { f: code.fingerprint }, t: code.token }
  return PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Decode and validate an access code.
 * @param text - the pasted access code; surrounding whitespace is ignored.
 * @returns the decoded fields.
 * @throws Error when the code is malformed, names a non-HTTP(S) origin, or pairs HTTPS without a fingerprint.
 */
export function decodeAccessCode(text: string): AccessCode {
  const trimmed = text.trim()
  if (!trimmed.startsWith(PREFIX)) throw new Error('接入码格式不正确：应以 gkh1. 开头')
  let payload: unknown
  try { payload = JSON.parse(Buffer.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8')) }
  catch (_malformedPayload) { throw new Error('接入码格式不正确：内容无法解析') }
  if (typeof payload !== 'object' || payload === null) throw new Error('接入码格式不正确：内容无法解析')
  const { u, f, t } = payload as Record<string, unknown>
  if (typeof u !== 'string' || typeof t !== 'string' || (f !== undefined && typeof f !== 'string')) {
    throw new Error('接入码格式不正确：缺少地址或授权码')
  }
  const endpoint = parseEndpoint(u, f, '接入码')
  if (!TOKEN_PATTERN.test(t)) throw new Error('接入码格式不正确：授权码无效')
  return { ...endpoint, token: t }
}

/**
 * Whether a pasted string is a relay connection update code (`gkhu1.`).
 * @param text - pasted text.
 * @returns `true` when it starts with `gkhu1.`.
 */
export function isRelayUpdate(text: string): boolean {
  return text.trim().startsWith(UPDATE_PREFIX)
}

/**
 * Encode a relay connection update code carrying only the relay origin and certificate fingerprint.
 * @param endpoint - relay address and optional fingerprint.
 * @returns the pasteable update code (`gkhu1.…`).
 */
export function encodeRelayUpdate(endpoint: RelayEndpoint): string {
  const payload = { u: endpoint.relayURL, ...endpoint.fingerprint === undefined ? {} : { f: endpoint.fingerprint } }
  return UPDATE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Decode and validate a relay connection update code (`gkhu1.…`).
 * @param text - the pasted update code; surrounding whitespace is ignored.
 * @returns the new relay origin and certificate fingerprint.
 */
export function decodeRelayUpdate(text: string): RelayEndpoint {
  const trimmed = text.trim()
  if (!trimmed.startsWith(UPDATE_PREFIX)) throw new Error('连接更新码格式不正确：应以 gkhu1. 开头')
  let payload: unknown
  try { payload = JSON.parse(Buffer.from(trimmed.slice(UPDATE_PREFIX.length), 'base64url').toString('utf8')) }
  catch (_malformedPayload) { throw new Error('连接更新码格式不正确：内容无法解析') }
  if (typeof payload !== 'object' || payload === null) throw new Error('连接更新码格式不正确：内容无法解析')
  const { u, f } = payload as Record<string, unknown>
  return parseEndpoint(u, f, '连接更新码')
}

/**
 * Replace the relay origin and certificate fingerprint of an existing employee access code while keeping its token.
 * @param existingAccessCode - the employee's stored `gkh1.…` access code.
 * @param updateText - the admin's `gkhu1.…` relay update code.
 * @returns the updated `gkh1.…` access code.
 */
export function applyRelayUpdate(existingAccessCode: string, updateText: string): string {
  const current = decodeAccessCode(existingAccessCode)
  const endpoint = decodeRelayUpdate(updateText)
  return encodeAccessCode({ ...endpoint, token: current.token })
}
