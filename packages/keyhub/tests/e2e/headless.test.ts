/**
 * Real composition: the published `dsh` CLI boots a headless profile with this package installed,
 * an admin row from a `--patch` overlay serving TLS, and the bundle's employee row selecting the
 * `genyee-keyhub` route. A local stand-in answers for DeepSeek.
 */
import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { generate } from 'selfsigned'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeAccessCode, normalizeFingerprint } from '../../src/access-code.ts'
import { parsePrice } from '../../src/admin/money.ts'
import { KeyhubStore } from '../../src/admin/store.ts'
import type { MockDeepSeek } from '../support/mock-deepseek.ts'
import { startMockDeepSeek, streamReply } from '../support/mock-deepseek.ts'

const run = promisify(execFile)
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dsh = join(packageDir, 'node_modules/.bin/dsh')

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done) })
  const { port } = server.address() as { port: number }
  await new Promise<void>((done) => { server.close(() => { done() }) })
  return port
}

describe('headless DSH through the relay', () => {
  let home: string
  let work: string
  let upstream: MockDeepSeek
  let env: NodeJS.ProcessEnv

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'keyhub-home-'))
    work = await mkdtemp(join(tmpdir(), 'keyhub-work-'))
    upstream = await startMockDeepSeek()
    upstream.respond((_request, res) => { streamReply(res, 'GENYEE-PONG') })

    const pems = await generate([{ name: 'commonName', value: 'keyhub-e2e' }], {
      keySize: 2048, extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
    })
    await writeFile(join(work, 'relay.crt'), pems.cert)
    await writeFile(join(work, 'relay.key'), pems.private)
    const port = await freePort()
    const store = KeyhubStore.open(join(work, 'ledger.db'))
    store.putDepartment({ id: 'rd', name: '研发部', keyRef: 'GENYEE_KEY_RD', enabled: true })
    const token = store.addEmployee({ userId: 'emp_e2e01', name: '测试员工', departmentId: 'rd' })
    store.setPrice('deepseek-flash', { inputCacheHit: parsePrice('0.2'), inputCacheMiss: parsePrice('2'), output: parsePrice('3') }, 0)
    store.close()
    await writeFile(join(work, 'admin.patch.yml'), [
      '- insert:',
      '    - id: genyee-keyhub-admin',
      "      name: '@genyee/dsh-keyhub'",
      '      config:',
      '        role: admin',
      '        listenHost: 127.0.0.1',
      `        listenPort: ${port}`,
      `        tlsCertFile: ${join(work, 'relay.crt')}`,
      `        tlsKeyFile: ${join(work, 'relay.key')}`,
      `        ledgerFile: ${join(work, 'ledger.db')}`,
      `        upstreamBaseURL: ${upstream.baseURL}`,
      '',
    ].join('\n'))
    const accessCode = encodeAccessCode({
      relayURL: `https://127.0.0.1:${port}`,
      fingerprint: normalizeFingerprint(new X509Certificate(pems.cert).fingerprint256),
      token,
    })
    env = {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      GENYEE_KEY_RD: 'sk-e2e-rd',
      GENYEE_KEYHUB_ACCESS_CODE: accessCode,
    }
    delete env.DEEPSEEK_API_KEY
    await run(dsh, ['--profile', 'e2e', '--from-default-profile', 'headless', '--dump-config'], { env, cwd: work })
    await run(dsh, ['plugin', '--profile', 'e2e', 'add', packageDir], { env, cwd: work })
  })

  afterAll(async () => {
    await upstream?.close()
    await rm(home, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })

  it('answers through the relay with the employee bound and DSH extensions removed', async () => {
    const { stdout } = await run(dsh, ['--profile', 'e2e', '--patch', join(work, 'admin.patch.yml'), 'Reply with the single word ping'], { env, cwd: work })
    expect(stdout).toContain('GENYEE-PONG')

    expect(upstream.received.length).toBeGreaterThan(0)
    for (const request of upstream.received) {
      expect(request.path).toBe('/anthropic/v1/messages')
      expect(request.headers['x-api-key']).toBe('sk-e2e-rd')
      expect(request.headers['x-deepseek-harness-user-id']).toBeUndefined()
      const body = JSON.parse(request.body) as Record<string, unknown>
      expect(body.metadata).toEqual({ user_id: 'emp_e2e01' })
      expect(Object.keys(body).filter(field => field.startsWith('dsh_'))).toEqual([])
    }

    const store = KeyhubStore.open(join(work, 'ledger.db'))
    try {
      const [spending] = store.spending('employee', 0, Date.now() + 1)
      expect(spending).toMatchObject({ id: 'emp_e2e01', requests: upstream.received.length })
      expect(spending.costMicros).toBeGreaterThan(0)
    } finally { store.close() }
  })
})
