/** Admin role: serve the relay over HTTPS (or explicitly plain HTTP) and keep its directory current. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { appendFile, readFile, unwatchFile, watchFile } from 'node:fs'
import { readFile as readFileAsync } from 'node:fs/promises'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import type { AdminConfig } from '../config.ts'
import type { Directory } from './directory.ts'
import { loadDirectory, parseDirectory } from './directory.ts'
import type { UsageRecord } from './relay.ts'
import { createRelay } from './relay.ts'

/** How often the directory file's modification time is polled. */
const DIRECTORY_POLL_MS = 1000

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
 * Start the admin role.
 * @param ctx - the plugin context owning the listener and the directory watch.
 * @param config - admin settings.
 */
export async function applyAdmin(ctx: Context, config: AdminConfig): Promise<void> {
  assertConcreteHost(config.listenHost)
  if (!config.insecureHttp && (config.tlsCertFile === undefined || config.tlsKeyFile === undefined)) {
    throw new Error('keyhub: set tlsCertFile and tlsKeyFile, or set insecureHttp: true to serve plain HTTP')
  }
  const directoryFile = resolve(config.directoryFile)
  const usageLogFile = resolve(config.usageLogFile)
  let directory: Directory = await loadDirectory(directoryFile)

  const relay = createRelay({
    directory: () => directory,
    async resolveKey(ref) {
      const name = credentialRef(ref)
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(name))?.value
      return launchEnvironmentOf(ctx).get(ref)?.value
    },
    upstreamBaseURL: config.upstreamBaseURL,
    upstreamReadTimeoutMs: config.upstreamReadTimeoutMs,
    maxRequestBytes: config.maxRequestBytes,
    recordUsage(record: UsageRecord) {
      appendFile(usageLogFile, `${JSON.stringify(record)}\n`, (error) => {
        if (error !== null) ctx.logger.error('keyhub: appending usage to %s failed: %s', usageLogFile, error.message)
      })
    },
    warn(message) { ctx.logger.warn(message) },
  })

  ctx.effect(() => {
    const reload = (): void => {
      readFile(directoryFile, 'utf8', (error, source) => {
        if (error !== null) {
          ctx.logger.error('keyhub: reading %s failed; keeping the previous directory: %s', directoryFile, error.message)
          return
        }
        let next: Directory
        try { next = parseDirectory(source, directoryFile) }
        catch (invalid) {
          ctx.logger.error('keyhub: %s is invalid; keeping the previous directory: %s', directoryFile, invalid instanceof Error ? invalid.message : String(invalid))
          return
        }
        directory = next
        relay.interrupt(({ employee }) => {
          const current = next.byToken.get(employee.tokenSha256)
          return current !== undefined && current.enabled && current.userId === employee.userId
            && next.departments.get(current.departmentId)?.enabled === true
        })
        ctx.logger.info('keyhub: directory reloaded from %s', directoryFile)
      })
    }
    watchFile(directoryFile, { interval: DIRECTORY_POLL_MS }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) reload()
    })
    return () => { unwatchFile(directoryFile) }
  }, 'keyhub.watchDirectory')

  await ctx.effect(async () => {
    let server: Server
    if (config.insecureHttp) {
      ctx.logger.warn('keyhub: serving plain HTTP on %s; authorization codes cross the network unencrypted', config.listenHost)
      server = createServer((req, res) => { relay.handle(req, res) })
    } else {
      const [cert, key] = await Promise.all([readFileAsync(resolve(config.tlsCertFile!)), readFileAsync(resolve(config.tlsKeyFile!))])
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
