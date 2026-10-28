/**
 * Admin command-line helpers used until the management page exists:
 *
 *   node lib/tools/admin-tools.js make-cert --ip 10.0.0.8 --out ./keyhub
 *   node lib/tools/admin-tools.js issue --relay https://10.0.0.8:8443 --cert ./keyhub/relay.crt --name 张三 --department rd
 *
 * `make-cert` writes a self-signed certificate for the relay address and prints its fingerprint.
 * `issue` prints a new employee's directory entry and access code; the token appears only in the access code.
 */
import { randomBytes, X509Certificate } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { generate } from 'selfsigned'
import { encodeAccessCode, generateToken, normalizeFingerprint } from '../access-code.ts'
import { hashToken } from '../admin/directory.ts'

/** Validity of a generated relay certificate. */
const CERT_VALIDITY_DAYS = 3650
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * Create a random DeepSeek `user_id` without personal data.
 * @returns `emp_` followed by 16 base32 characters.
 */
export function newUserId(): string {
  return `emp_${[...randomBytes(16)].map(byte => BASE32[byte % 32]).join('')}`
}

async function makeCert(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { ip: { type: 'string' }, out: { type: 'string' } } })
  if (values.ip === undefined || isIP(values.ip) === 0 || values.out === undefined) throw new Error('usage: make-cert --ip <relay IP address> --out <directory>')
  const notBeforeDate = new Date()
  const notAfterDate = new Date(notBeforeDate.getTime() + CERT_VALIDITY_DAYS * 86_400_000)
  const pems = await generate([{ name: 'commonName', value: `Genyee keyhub ${values.ip}` }], {
    keySize: 2048, notBeforeDate, notAfterDate,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: values.ip }] }],
  })
  await writeFile(join(values.out, 'relay.crt'), pems.cert)
  await writeFile(join(values.out, 'relay.key'), pems.private, { mode: 0o600 })
  console.log(`certificate: ${join(values.out, 'relay.crt')}`)
  console.log(`private key: ${join(values.out, 'relay.key')}`)
  console.log(`fingerprint: ${normalizeFingerprint(new X509Certificate(pems.cert).fingerprint256)}`)
}

async function issue(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { relay: { type: 'string' }, cert: { type: 'string' }, name: { type: 'string' }, department: { type: 'string' } } })
  if (values.relay === undefined || values.name === undefined || values.department === undefined) {
    throw new Error('usage: issue --relay <https://ip:port> --cert <relay.crt> --name <employee name> --department <department id>')
  }
  const relayURL = new URL(values.relay).origin
  let fingerprint: string | undefined
  if (relayURL.startsWith('https:')) {
    if (values.cert === undefined) throw new Error('issue: --cert is required for an https relay')
    fingerprint = normalizeFingerprint(new X509Certificate(await readFile(values.cert)).fingerprint256)
  }
  const token = generateToken()
  console.log('# Add to the employees list of the directory file:')
  console.log(`  - { userId: ${newUserId()}, name: ${JSON.stringify(values.name)}, department: ${values.department}, tokenSha256: ${hashToken(token)} }`)
  console.log('')
  console.log('# Give this access code to the employee (shown once):')
  console.log(encodeAccessCode({ relayURL, fingerprint, token }))
}

const [command, ...rest] = process.argv.slice(2)
const commands: Record<string, (args: string[]) => Promise<void>> = { 'make-cert': makeCert, issue }
const selected = command === undefined ? undefined : commands[command]
if (selected === undefined) {
  console.error('usage: admin-tools.js <make-cert|issue> [options]')
  process.exitCode = 2
} else {
  selected(rest).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
