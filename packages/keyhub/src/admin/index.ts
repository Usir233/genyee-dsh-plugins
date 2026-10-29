/** Admin role: serve the relay over HTTPS (or explicitly plain HTTP), enforce the ledger, and serve the management page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { readFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import { encodeAccessCode } from '../access-code.ts'
import type { AdminConfig } from '../config.ts'
import { PLUGIN_VERSION } from '../version.ts'
import { BalanceMonitor } from './balance.ts'
import { certificateFingerprint } from './ledger-ops.ts'
import { createLedgerRelay } from './ledger-relay.ts'
import { assertTimeZone } from './money.ts'
import { rpcRoute } from '../rpc-route.ts'
import { ADMIN_ROUTE, createAdminRpc } from './rpc.ts'
import { KeyhubStore } from './store.ts'

/** How often the ledger is checked for writes made by admin tools. */
const LEDGER_POLL_MS = 1000
/** Delay before repeating a failed balance query. */
const BALANCE_RETRY_MS = 60_000

/**
 * Normalize an IP literal: IPv6 to its compressed lowercase form, IPv4-mapped IPv6 to IPv4.
 * @param host - an IP literal.
 * @returns the canonical spelling.
 */
function canonicalIP(host: string): string {
  if (isIP(host) !== 6) return host
  const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1)
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonical)
  if (mapped === null) return canonical
  const high = Number.parseInt(mapped[1]!, 16)
  const low = Number.parseInt(mapped[2]!, 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

/**
 * Reject wildcard, non-literal, and non-local listen addresses.
 * @param host - the configured listen address.
 * @param localAddresses - addresses of this machine's interfaces.
 * @throws Error when `host` is not one concrete IP literal of a local interface.
 */
export function assertConcreteHost(host: string, localAddresses: readonly string[] = localInterfaceAddresses()): void {
  if (isIP(host) === 0) throw new Error(`keyhub: listenHost "${host}" must be an IP address literal of one local interface`)
  const canonical = canonicalIP(host)
  if (canonical === '0.0.0.0' || canonical === '::') {
    throw new Error(`keyhub: listenHost "${host}" is a wildcard address; name the one interface employees reach`)
  }
  if (!localAddresses.map(canonicalIP).includes(canonical)) {
    throw new Error(`keyhub: listenHost "${host}" is not an address of this machine (${localAddresses.join(', ')}); the IP may have changed`)
  }
}

function localInterfaceAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap(entries => (entries ?? []).map(entry => entry.address))
}

/**
 * Origin employees reach the relay at.
 * @param config - admin settings.
 * @returns `https://host:port`, or `http://` for plain HTTP; IPv6 hosts are bracketed.
 */
function relayOrigin(config: AdminConfig): string {
  const host = isIP(config.listenHost) === 6 ? `[${config.listenHost}]` : config.listenHost
  return `${config.insecureHttp ? 'http' : 'https'}://${host}:${config.listenPort}`
}

/**
 * Start the admin role.
 * @param ctx - the plugin context owning the ledger, the listener, the ledger watch, the balance poll, and the management RPC.
 * @param config - admin settings.
 */
export async function applyAdmin(ctx: Context, config: AdminConfig): Promise<void> {
  assertConcreteHost(config.listenHost)
  assertTimeZone(config.timeZone)
  if (!config.insecureHttp && (config.tlsCertFile === undefined || config.tlsKeyFile === undefined)) {
    throw new Error('keyhub: set tlsCertFile and tlsKeyFile, or set insecureHttp: true to serve plain HTTP')
  }
  const [cert, key] = config.insecureHttp
    ? [undefined, undefined]
    : await Promise.all([readFile(resolve(config.tlsCertFile!)), readFile(resolve(config.tlsKeyFile!))])
  const fingerprint = cert === undefined ? undefined : certificateFingerprint(cert)
  const ledgerFile = resolve(config.ledgerFile)
  let store: KeyhubStore | undefined
  ctx.effect(() => {
    const opened = KeyhubStore.open(ledgerFile)
    store = opened
    return () => { opened.close() }
  }, 'keyhub.ledger')
  const ledger = store!
  ledger.setTimeZone(config.timeZone)

  // Credentials are looked up per use: profiles without a credentials service (headless) read the launch environment.
  const resolveKey = async (ref: string): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(credentialRef(ref)))?.value
    return launchEnvironmentOf(ctx).get(ref)?.value
  }

  const { relay, recheck: recheckInFlight } = createLedgerRelay(ledger, {
    timeZone: config.timeZone,
    defaultMaxConcurrency: config.defaultMaxConcurrency,
    upstreamBaseURL: config.upstreamBaseURL,
    upstreamReadTimeoutMs: config.upstreamReadTimeoutMs,
    maxRequestBytes: config.maxRequestBytes,
    resolveKey,
    warn(message) { ctx.logger.warn(message) },
  })

  ctx.effect(() => {
    let version = ledger.dataVersion()
    const timer = setInterval(() => {
      const next = ledger.dataVersion()
      if (next === version) return
      version = next
      recheckInFlight()
    }, LEDGER_POLL_MS)
    return () => { clearInterval(timer) }
  }, 'keyhub.watchLedger')

  const balance = new BalanceMonitor({
    url: config.balanceURL,
    lowBalanceYuan: config.lowBalanceYuan,
    async key() {
      for (const department of ledger.departments()) {
        if (!department.enabled) continue
        const value = await resolveKey(department.keyRef)
        if (value !== undefined && value.length > 0) return value
      }
      return undefined
    },
    warn(message) { ctx.logger.warn(message) },
  })
  if (config.balancePollMinutes > 0) {
    const interval = config.balancePollMinutes * 60_000
    ctx.effect(() => {
      let timer: NodeJS.Timeout | undefined
      let stopped = false
      // A failed query, such as one made before the credentials service started, is retried sooner than the interval.
      const poll = (): void => {
        void balance.refresh().then((reading) => {
          if (!stopped) timer = setTimeout(poll, reading.state === 'failed' ? Math.min(BALANCE_RETRY_MS, interval) : interval)
        })
      }
      poll()
      return () => {
        stopped = true
        clearTimeout(timer)
      }
    }, 'keyhub.balancePoll')
  }

  const rpc = createAdminRpc({
    store: ledger,
    balance,
    service: {
      relayURL: relayOrigin(config),
      fingerprint,
      upstreamBaseURL: config.upstreamBaseURL,
      timeZone: config.timeZone,
      defaultMaxConcurrency: config.defaultMaxConcurrency,
      lowBalanceYuan: config.lowBalanceYuan,
      version: PLUGIN_VERSION,
    },
    async keyConfigured(ref) {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.describe(credentialRef(ref))).configured
      return (launchEnvironmentOf(ctx).get(ref)?.value ?? '').length > 0
    },
    async storeKey(ref, value) {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) throw new Error('当前 DSH 没有可写入的凭据库，请在凭据文件中手动填写')
      await credentials.set(credentialRef(ref), value)
    },
    ledgerChanged: recheckInFlight,
    accessCode: token => encodeAccessCode({ relayURL: relayOrigin(config), fingerprint, token }),
  })
  // Headless profiles have no Connection; the management page then simply does not exist.
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register(rpcRoute(ADMIN_ROUTE, rpc)), 'keyhub: management route')
  })

  await ctx.effect(async () => {
    const server: Server = cert === undefined
      ? createServer((req, res) => { relay.handle(req, res) })
      : createSecureServer({ cert, key }, (req, res) => { relay.handle(req, res) })
    if (cert === undefined) ctx.logger.warn('keyhub: serving plain HTTP on %s; authorization codes cross the network unencrypted', config.listenHost)
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
