/** Employee role: register the `genyee-keyhub` DeepSeek route, served through the loopback proxy to the admin relay. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { catalogModelInfo, registerDeepSeekProvider, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { AccessCode } from '../access-code.ts'
import { decodeAccessCode } from '../access-code.ts'
import type { EmployeeConfig } from '../config.ts'
import type { EmployeeRpcDependencies } from './rpc.ts'
import { rpcRoute } from '../rpc-route.ts'
import { createEmployeeRpc, EMPLOYEE_ROUTE } from './rpc.ts'
import type { LocalProxy } from './local-proxy.ts'
import { startLocalProxy } from './local-proxy.ts'

/** Provider route id employees select. */
export const PROVIDER = 'genyee-keyhub'

/** Upper bound of one status query to the relay. */
const STATUS_TIMEOUT_MS = 10_000

/**
 * Start the employee role.
 * @param ctx - the plugin context owning the proxy, the route, and the settings RPC.
 * @param config - employee settings.
 */
export async function applyEmployee(ctx: Context, config: EmployeeConfig): Promise<void> {
  const ref = credentialRef(config.accessCodeRef)
  // Credentials are looked up per use: profiles without a credentials service (headless) read the launch environment.
  const readRaw = async (): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    const value = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : launchEnvironmentOf(ctx).get(config.accessCodeRef)?.value
    return value === undefined || value.trim().length === 0 ? undefined : value
  }
  const readAccessCode = async (): Promise<AccessCode> => {
    const value = await readRaw()
    if (value === undefined) throw new Error(`尚未填写 Genyee 接入码（${config.accessCodeRef}），请向管理员索取，并在“设置 → Genyee 密钥中心”中填写`)
    return decodeAccessCode(value)
  }

  let proxy: LocalProxy | undefined
  await ctx.effect(async () => {
    proxy = await startLocalProxy({ accessCode: readAccessCode, readTimeoutMs: config.relayReadTimeoutMs })
    const running = proxy
    return async () => { await running.close() }
  }, 'keyhub.localProxy')

  /** Ask the relay for this employee's standing through the loopback proxy, which pins the relay certificate. */
  const relayStatus: EmployeeRpcDependencies['relayStatus'] = async () => {
    const running = proxy!
    const response = await fetch(new URL('/keyhub/v1/status', running.baseURL), {
      headers: { 'x-api-key': running.secret },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    })
    const body = await response.json() as Record<string, unknown>
    if (response.ok) return { ok: true, status: body }
    const error = body.error as Record<string, unknown> | undefined
    return { ok: false, message: typeof error?.message === 'string' ? error.message : `管理端返回 HTTP ${response.status}` }
  }

  const options = () => resolveAdapterOptions({ baseURL: proxy!.baseURL })
  registerDeepSeekProvider(ctx, PROVIDER, {
    providerName: 'Genyee',
    options,
    resolveAuth: async () => ({ headers: { 'x-api-key': proxy!.secret } }),
    async discoverModels(provider) {
      const catalog = options().models
      let allowed: readonly string[] | undefined
      try {
        const answer = await relayStatus()
        const models = answer.ok ? (answer.status as { models?: unknown }).models : undefined
        if (Array.isArray(models)) allowed = models.filter((model): model is string => typeof model === 'string')
      } catch (_relayUnreachable) {
        // The relay is closed or the code is missing; listing the full catalog lets the request report the reason.
      }
      const visible = allowed === undefined ? catalog : catalog.filter(model => allowed.includes(model.id))
      return (visible.length > 0 ? visible : catalog).map(model => catalogModelInfo(provider, model))
    },
  })

  const rpc = createEmployeeRpc({
    accessCodeRef: config.accessCodeRef,
    readRaw,
    async save(code) {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) throw new Error('当前 DSH 没有可写入的凭据库，请在凭据文件中手动填写')
      await credentials.set(ref, code)
    },
    async clear() {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) throw new Error('当前 DSH 没有可写入的凭据库，请在凭据文件中手动填写')
      await credentials.unset(ref)
    },
    relayStatus,
  })
  // Headless profiles have no Connection; the settings section then simply does not exist.
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register(rpcRoute(EMPLOYEE_ROUTE, rpc)), 'keyhub: settings route')
  })
}
