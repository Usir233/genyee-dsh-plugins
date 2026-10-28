/** Plugin configuration: one row selects the admin or employee role and that role's settings. */
import z from '@deepseek-ai/schemastery'

/** Settings of the admin role, which holds the company keys and relays employee requests. */
export interface AdminConfig {
  role: 'admin'
  /** Concrete local interface address the relay listens on; wildcard addresses are rejected. */
  listenHost: string
  /** TCP port of the relay listener. */
  listenPort: number
  /** PEM certificate file served by the relay; required unless `insecureHttp` is set. */
  tlsCertFile?: string
  /** PEM private key file matching `tlsCertFile`. */
  tlsKeyFile?: string
  /** Serve plain HTTP; authorization codes then cross the network unencrypted. */
  insecureHttp: boolean
  /** YAML file listing departments and employees; reloaded when it changes. */
  directoryFile: string
  /** JSON Lines file each completed request appends one usage record to. */
  usageLogFile: string
  /** DeepSeek Anthropic-compatible API root the relay forwards to. */
  upstreamBaseURL: string
  /** Idle read timeout of one upstream response; DeepSeek keeps a queued request alive for up to 10 minutes. */
  upstreamReadTimeoutMs: number
  /** Largest accepted request body, in bytes. */
  maxRequestBytes: number
}

/** Settings of the employee role, which reaches the company models only through the admin relay. */
export interface EmployeeConfig {
  role: 'employee'
  /** Credential reference holding the access code the admin issued to this employee. */
  accessCodeRef: string
}

/** Settings of one plugin row. */
export type Config = AdminConfig | EmployeeConfig

/** The upstream read timeout floor: DeepSeek closes a queued request after 10 minutes. */
const MIN_UPSTREAM_READ_TIMEOUT_MS = 600_000

const AdminConfigSchema: z<AdminConfig> = z.object({
  role: z.const('admin').required(),
  listenHost: z.string().required(),
  listenPort: z.natural().max(65535).default(8443),
  tlsCertFile: z.string(),
  tlsKeyFile: z.string(),
  insecureHttp: z.boolean().default(false),
  directoryFile: z.string().required(),
  usageLogFile: z.string().required(),
  upstreamBaseURL: z.string().default('https://api.deepseek.com/anthropic'),
  upstreamReadTimeoutMs: z.natural().min(MIN_UPSTREAM_READ_TIMEOUT_MS).default(MIN_UPSTREAM_READ_TIMEOUT_MS),
  maxRequestBytes: z.natural().min(1).default(64 * 1024 * 1024),
})

const EmployeeConfigSchema: z<EmployeeConfig> = z.object({
  role: z.const('employee').required(),
  accessCodeRef: z.string().default('GENYEE_KEYHUB_ACCESS_CODE'),
})

export const Config: z<Config> = z.union([AdminConfigSchema, EmployeeConfigSchema])
