/** Employee role: register the `genyee-keyhub` DeepSeek route, served through the loopback proxy to the admin relay. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { catalogModelInfo, registerDeepSeekProvider, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { AccessCode } from '../access-code.ts'
import { decodeAccessCode } from '../access-code.ts'
import type { EmployeeConfig } from '../config.ts'
import type { LocalProxy } from './local-proxy.ts'
import { startLocalProxy } from './local-proxy.ts'

/** Provider route id employees select. */
export const PROVIDER = 'genyee-keyhub'

/** Idle timeout of one relay response: the relay's own upstream floor plus margin. */
const RELAY_READ_TIMEOUT_MS = 660_000

/**
 * Start the employee role.
 * @param ctx - the plugin context owning the proxy and the route.
 * @param config - employee settings.
 */
export async function applyEmployee(ctx: Context, config: EmployeeConfig): Promise<void> {
  const ref = credentialRef(config.accessCodeRef)
  const readAccessCode = async (): Promise<AccessCode> => {
    const credentials = ctx.get('credentials')
    const value = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : launchEnvironmentOf(ctx).get(config.accessCodeRef)?.value
    if (value === undefined || value.trim().length === 0) {
      throw new Error(`尚未填写 Genyee 接入码（${config.accessCodeRef}），请向管理员索取并填写`)
    }
    return decodeAccessCode(value)
  }

  let proxy: LocalProxy | undefined
  await ctx.effect(async () => {
    proxy = await startLocalProxy({ accessCode: readAccessCode, readTimeoutMs: RELAY_READ_TIMEOUT_MS })
    const running = proxy
    return async () => { await running.close() }
  }, 'keyhub.localProxy')

  const options = () => resolveAdapterOptions({ baseURL: proxy!.baseURL })
  registerDeepSeekProvider(ctx, PROVIDER, {
    providerName: 'Genyee',
    options,
    resolveAuth: async () => ({ headers: { 'x-api-key': proxy!.secret } }),
    discoverModels: async provider => options().models.map(model => catalogModelInfo(provider, model)),
  })
}
