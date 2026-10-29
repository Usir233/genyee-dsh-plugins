/**
 * Stable identity of the employee's loopback proxy. DSH caches uploaded files per route base URL and authentication
 * headers, so a port and secret that stay the same across launches keep that cache valid. The port derives from the
 * installation, which is known at startup; the secret derives from the access code, so a new code starts a new cache.
 */
import { createHmac } from 'node:crypto'

/** First port of the range derived ports fall in. */
const DERIVED_PORT_BASE = 40_000
/** Number of ports in that range. */
const DERIVED_PORT_COUNT = 10_000

function mac(token: string, purpose: string): Buffer {
  return createHmac('sha256', token).update(`genyee-keyhub/local-proxy/${purpose}`).digest()
}

/**
 * Secret the DSH route presents to the loopback proxy.
 * @param token - the employee's authorization token.
 * @returns 256 bits in base64url; it does not reveal the token.
 */
export function proxySecret(token: string): string {
  return mac(token, 'secret').toString('base64url')
}

/**
 * Loopback port the proxy tries first.
 * @param installation - text that identifies this DSH installation and plugin row, such as its data directory.
 * @returns a port in 40000–49999.
 */
export function proxyPort(installation: string): number {
  return DERIVED_PORT_BASE + (mac(installation, 'port').readUInt32BE(0) % DERIVED_PORT_COUNT)
}
