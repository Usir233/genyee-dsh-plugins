/**
 * DSH request body extensions: top-level fields DSH adds to DeepSeek Messages requests, such as
 * `dsh_plugin_packages` (enabled plugin packages) and `dsh_session_log` (the session's event log).
 * The genyee-keyhub route never forwards them: the employee's loopback proxy removes them before the request
 * leaves the machine, and the admin relay removes any that still arrive.
 */

/** Prefix DSH reserves for its request body extensions. */
const DSH_EXTENSION_PREFIX = 'dsh_'

/**
 * Remove every DSH body extension from a parsed request body, in place.
 * @param body - a JSON object request body.
 * @returns the names of the removed fields.
 */
export function removeDshExtensions(body: Record<string, unknown>): string[] {
  const removed = Object.keys(body).filter(field => field.startsWith(DSH_EXTENSION_PREFIX))
  for (const field of removed) delete body[field]
  return removed
}

/**
 * Remove every DSH body extension from a serialized request body.
 * @param raw - the request body bytes.
 * @returns the body without extensions, or `raw` unchanged when it is not a JSON object or carries none.
 */
export function stripDshExtensions(raw: Buffer): Buffer {
  let parsed: unknown
  try { parsed = JSON.parse(raw.toString('utf8')) }
  catch (_notJson) { return raw } // The relay answers malformed bodies; the proxy forwards them unchanged.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return raw
  const body = parsed as Record<string, unknown>
  return removeDshExtensions(body).length === 0 ? raw : Buffer.from(JSON.stringify(body), 'utf8')
}
