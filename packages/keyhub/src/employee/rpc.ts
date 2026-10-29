/**
 * Settings-section commands of the employee role, served on {@link EMPLOYEE_ROUTE}: save or clear the access code and
 * report the connection to the admin relay. Only the owner of this DSH reaches the route (see `src/rpc-route.ts`).
 */
import { decodeAccessCode } from '../access-code.ts'
import type { RpcAnswer, RpcHandler } from '../rpc-route.ts'

/** Connection API route of the employee settings section. */
export const EMPLOYEE_ROUTE = '/api/genyee-keyhub/employee'

/** What the settings section shows. */
export interface EmployeeConnection {
  readonly accessCodeRef: string
  /** Whether an access code is stored. */
  readonly configured: boolean
  /** Relay origin from the stored access code. */
  readonly relayURL: string | undefined
  /** Whether the relay answered and admitted the stored code. */
  readonly connected: boolean
  /** The relay's status body when connected. */
  readonly status: unknown
  /** Why the relay is not usable, written for the employee. */
  readonly message: string | undefined
}

/** Facilities of the settings RPC. */
export interface EmployeeRpcDependencies {
  readonly accessCodeRef: string
  /**
   * Read the stored access code text.
   * @returns the text, or `undefined` when none is stored.
   */
  readRaw(): Promise<string | undefined>
  /**
   * Store a validated access code.
   * @param code - the access code text.
   */
  save(code: string): Promise<void>
  /** Remove the stored access code. */
  clear(): Promise<void>
  /**
   * Query the relay status with the stored code.
   * @returns the status body, or the relay's refusal message.
   * @throws Error when the relay cannot be reached.
   */
  relayStatus(): Promise<{ ok: true, status: unknown } | { ok: false, message: string }>
}

/**
 * Create the settings command handler.
 * @param deps - credential access and the relay status query.
 * @returns a handler of one decoded command.
 */
export function createEmployeeRpc(deps: EmployeeRpcDependencies): RpcHandler {
  const failure = (code: string, message: string): RpcAnswer => ({ ok: false, error: { code, message, details: {} } })

  const connection = async (): Promise<EmployeeConnection> => {
    const raw = await deps.readRaw()
    const base = { accessCodeRef: deps.accessCodeRef, configured: raw !== undefined }
    if (raw === undefined) return { ...base, relayURL: undefined, connected: false, status: undefined, message: '尚未填写接入码' }
    let relayURL: string
    try { relayURL = decodeAccessCode(raw).relayURL }
    catch (error) {
      return { ...base, relayURL: undefined, connected: false, status: undefined, message: error instanceof Error ? error.message : String(error) }
    }
    try {
      const answer = await deps.relayStatus()
      return answer.ok
        ? { ...base, relayURL, connected: true, status: answer.status, message: undefined }
        : { ...base, relayURL, connected: false, status: undefined, message: answer.message }
    } catch (error) {
      return { ...base, relayURL, connected: false, status: undefined, message: `无法连接管理端 ${relayURL}：${error instanceof Error ? error.message : String(error)}；请确认管理员的 DSH 已打开` }
    }
  }

  return async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'status': return { ok: true, value: await connection() }
        case 'accessCode.save': {
          const code = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).code : undefined
          if (typeof code !== 'string' || code.trim().length === 0) return failure('keyhub/invalid', '请粘贴管理员提供的接入码')
          decodeAccessCode(code)
          await deps.save(code.trim())
          return { ok: true, value: await connection() }
        }
        case 'accessCode.clear':
          await deps.clear()
          return { ok: true, value: await connection() }
        default: return failure('keyhub/unknown-endpoint', `未知操作 ${endpoint}`)
      }
    } catch (error) {
      // Access-code and credential-store errors carry messages written for the employee.
      return failure('keyhub/failed', error instanceof Error ? error.message : String(error))
    }
  }
}
