/** Access codes: the admin relay address, its certificate fingerprint, and one employee's authorization token in one pasteable string. */
import { randomBytes } from 'node:crypto'

/** Decoded access code. */
export interface AccessCode {
  /** Relay origin, `https://host:port` (or `http://` for a relay serving plain HTTP). */
  readonly relayURL: string
  /** Lowercase hex SHA-256 fingerprint of the relay certificate; absent for plain HTTP. */
  readonly fingerprint: string | undefined
  /** The employee's authorization token. */
  readonly token: string
}

const PREFIX = 'gkh1.'
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u
const TOKEN_PATTERN = /^gk_[A-Za-z0-9_-]{43}$/u

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
  let url: URL
  try { url = new URL(u) }
  catch (_invalidUrl) { throw new Error('接入码格式不正确：管理端地址无效') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('接入码格式不正确：管理端地址必须是 http 或 https')
  if (url.protocol === 'https:' && (f === undefined || !FINGERPRINT_PATTERN.test(f))) throw new Error('接入码格式不正确：缺少管理端证书指纹')
  if (!TOKEN_PATTERN.test(t)) throw new Error('接入码格式不正确：授权码无效')
  return { relayURL: url.origin, fingerprint: url.protocol === 'https:' ? f : undefined, token: t }
}
