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
  /** SQLite ledger of departments, employees, prices, quotas, and usage; created when missing. */
  ledgerFile: string
  /** IANA time zone whose calendar defines quota days, weeks (from Monday), months, and years. */
  timeZone: string
  /** Simultaneous requests allowed to an employee without a limit of their own. */
  defaultMaxConcurrency: number
  /** DeepSeek Anthropic-compatible API root the relay forwards to. */
  upstreamBaseURL: string
  /** Idle read timeout of one upstream response; DeepSeek keeps a queued request alive for up to 10 minutes. */
  upstreamReadTimeoutMs: number
  /** Largest accepted request body, in bytes. */
  maxRequestBytes: number
  /** DeepSeek account balance endpoint, queried with an enabled department key. */
  balanceURL: string
  /** Minutes between account balance queries; `0` turns them off. */
  balancePollMinutes: number
  /** Balance in 元 below which the management page and the log warn. */
  lowBalanceYuan: number
}

/** Settings of the employee role, which reaches the company models only through the admin relay. */
export interface EmployeeConfig {
  role: 'employee'
  /** Credential reference holding the access code the admin issued to this employee. */
  accessCodeRef: string
  /** Idle read timeout of one relay response; keep it above the admin's `upstreamReadTimeoutMs`. */
  relayReadTimeoutMs: number
  /** Loopback port of the local proxy; `0` derives a stable port in 40000–49999 from the installation. */
  localProxyPort: number
  /** Largest Messages request body the local proxy reads to remove DSH extensions, in bytes. */
  maxRequestBytes: number
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
  ledgerFile: z.string().required(),
  timeZone: z.string().default('Asia/Shanghai'),
  defaultMaxConcurrency: z.natural().min(1).default(8),
  upstreamBaseURL: z.string().default('https://api.deepseek.com/anthropic'),
  upstreamReadTimeoutMs: z.natural().min(MIN_UPSTREAM_READ_TIMEOUT_MS).default(MIN_UPSTREAM_READ_TIMEOUT_MS),
  maxRequestBytes: z.natural().min(1).default(64 * 1024 * 1024),
  balanceURL: z.string().default('https://api.deepseek.com/user/balance'),
  balancePollMinutes: z.natural().default(10),
  lowBalanceYuan: z.number().min(0).default(50),
})

const EmployeeConfigSchema: z<EmployeeConfig> = z.object({
  role: z.const('employee').required(),
  accessCodeRef: z.string().default('GENYEE_KEYHUB_ACCESS_CODE'),
  relayReadTimeoutMs: z.natural().min(MIN_UPSTREAM_READ_TIMEOUT_MS).default(MIN_UPSTREAM_READ_TIMEOUT_MS + 60_000),
  localProxyPort: z.natural().max(65535).default(0),
  maxRequestBytes: z.natural().min(1).default(64 * 1024 * 1024),
})

export const Config: z<Config> = z.union([AdminConfigSchema, EmployeeConfigSchema])
