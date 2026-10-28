/** Admin role: serve the relay over HTTPS (or explicitly plain HTTP) and enforce the ledger. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { readFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import type { AdminConfig } from '../config.ts'
import { assertTimeZone, requestCostMicros } from './money.ts'
import { checkRequest } from './quota.ts'
import type { UsageRecord } from './relay.ts'
import { createRelay } from './relay.ts'
import type { LedgerAdmission } from './store.ts'
import { KeyhubStore } from './store.ts'

/** How often the ledger is checked for writes made by admin tools. */
const LEDGER_POLL_MS = 1000

/**
 * Reject wildcard and non-literal listen addresses.
 * @param host - the configured listen address.
 * @throws Error when `host` is not one concrete IP literal.
 */
export function assertConcreteHost(host: string): void {
  if (isIP(host) === 0) throw new Error(`keyhub: listenHost "${host}" must be an IP address literal of one local interface`)
  if (host === '0.0.0.0' || host === '::' || host === '::ffff:0.0.0.0') {
    throw new Error(`keyhub: listenHost "${host}" is a wildcard address; name the one interface employees reach`)
  }
}

/**
 * Cost of one completed request at its completion time.
 * @param store - the ledger.
 * @param record - the request's usage record.
 * @returns micro-yuan; zero when the response reported no usage.
 */
function costOf(store: KeyhubStore, record: UsageRecord): number {
  if (record.usage === undefined || record.model === undefined) return 0
  const price = store.priceAt(record.model, Date.parse(record.at))
  return price === undefined ? 0 : requestCostMicros(record.usage, price)
}

/**
 * Start the admin role.
 * @param ctx - the plugin context owning the ledger, the listener, and the ledger watch.
 * @param config - admin settings.
 */
export async function applyAdmin(ctx: Context, config: AdminConfig): Promise<void> {
  assertConcreteHost(config.listenHost)
  assertTimeZone(config.timeZone)
  if (!config.insecureHttp && (config.tlsCertFile === undefined || config.tlsKeyFile === undefined)) {
    throw new Error('keyhub: set tlsCertFile and tlsKeyFile, or set insecureHttp: true to serve plain HTTP')
  }
  const ledgerFile = resolve(config.ledgerFile)
  let store: KeyhubStore | undefined
  ctx.effect(() => {
    const opened = KeyhubStore.open(ledgerFile)
    store = opened
    return () => { opened.close() }
  }, 'keyhub.ledger')
  const ledger = store!

  const relay = createRelay<LedgerAdmission>({
    admit: token => ledger.admit(token),
    check: (admission, model, inFlight) => checkRequest(ledger, { admission, model, inFlight, now: Date.now() }, {
      timeZone: config.timeZone, defaultMaxConcurrency: config.defaultMaxConcurrency,
    }),
    async resolveKey(ref) {
      const name = credentialRef(ref)
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(name))?.value
      return launchEnvironmentOf(ctx).get(ref)?.value
    },
    upstreamBaseURL: config.upstreamBaseURL,
    upstreamReadTimeoutMs: config.upstreamReadTimeoutMs,
    maxRequestBytes: config.maxRequestBytes,
    recordUsage(record) {
      try {
        ledger.recordUsage({ ...record, at: Date.parse(record.at), costMicros: costOf(ledger, record) })
      } catch (error) {
        ctx.logger.error('keyhub: recording usage of %s failed: %s', record.userId, error instanceof Error ? error.message : String(error))
      }
    },
    warn(message) { ctx.logger.warn(message) },
  })

  ctx.effect(() => {
    let version = ledger.dataVersion()
    const timer = setInterval(() => {
      const next = ledger.dataVersion()
      if (next === version) return
      version = next
      relay.interrupt(({ employee, department }) => {
        const current = ledger.readmit(employee.userId)
        return current !== undefined && current.employee.tokenSha256 === employee.tokenSha256 && current.department.id === department.id
      })
    }, LEDGER_POLL_MS)
    return () => { clearInterval(timer) }
  }, 'keyhub.watchLedger')

  await ctx.effect(async () => {
    let server: Server
    if (config.insecureHttp) {
      ctx.logger.warn('keyhub: serving plain HTTP on %s; authorization codes cross the network unencrypted', config.listenHost)
      server = createServer((req, res) => { relay.handle(req, res) })
    } else {
      const [cert, key] = await Promise.all([readFile(resolve(config.tlsCertFile!)), readFile(resolve(config.tlsKeyFile!))])
      server = createSecureServer({ cert, key }, (req, res) => { relay.handle(req, res) })
    }
    // Requests may wait in DeepSeek's queue for up to 10 minutes; the upstream timeout bounds them instead.
    server.requestTimeout = 0
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(config.listenPort, config.listenHost, () => {
        server.off('error', rejectListen)
        server.on('error', (error) => { ctx.logger.error(error) })
        resolveListen()
      })
    })
    ctx.logger.info('keyhub: relay listening on %s:%d', config.listenHost, config.listenPort)
    return async () => {
      relay.closeAll()
      const closed = new Promise<void>((resolveClose) => { server.close(() => { resolveClose() }) })
      server.closeAllConnections()
      await closed
    }
  }, 'keyhub.listen')
}
