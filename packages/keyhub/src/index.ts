/**
 * Genyee key hub: one plugin, two roles.
 * The admin role keeps the company's DeepSeek keys and relays employee requests, binding each to the employee's `user_id`;
 * the employee role registers the `genyee-keyhub` model route, which reaches DeepSeek only through that relay.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import { applyAdmin } from './admin/index.ts'
import { Config } from './config.ts'
import { applyEmployee } from './employee/index.ts'

export { Config } from './config.ts'
export type { AdminConfig, EmployeeConfig } from './config.ts'
export { decodeAccessCode, encodeAccessCode, generateToken } from './access-code.ts'
export type { AccessCode } from './access-code.ts'
export { hashToken } from './admin/directory.ts'
export { PROVIDER } from './employee/index.ts'

export const name = 'genyee-keyhub'
export const inject = ['llm']

/**
 * Start the configured role.
 * @param ctx - plugin context.
 * @param config - validated settings of this row.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  switch (config.role) {
    case 'admin': return applyAdmin(ctx, config)
    case 'employee': return applyEmployee(ctx, config)
  }
}
