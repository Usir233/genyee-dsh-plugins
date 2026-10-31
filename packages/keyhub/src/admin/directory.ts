/** Department and employee identities shared by the relay and the ledger. */
import { createHash } from 'node:crypto'

/** One department; its employees' requests use its DeepSeek key. */
export interface Department {
  readonly id: string
  readonly name: string
  /** Credential reference of the department's DeepSeek API key. */
  readonly keyRef: string
  readonly enabled: boolean
}

/** One employee entry. */
export interface Employee {
  /** The DeepSeek `user_id` sent for this employee; contains no personal data. */
  readonly userId: string
  readonly name: string
  readonly departmentId: string
  /** Lowercase hex SHA-256 of the employee's authorization token. */
  readonly tokenSha256: string
  readonly enabled: boolean
  /** Epoch milliseconds when this employee's token expires; `undefined` when it does not expire. */
  readonly expiresAt?: number
}

/** An employee admitted to use the relay, with the department that pays for the request. */
export interface Admission {
  readonly employee: Employee
  readonly department: Department
}

/** `user_id` characters and length accepted by DeepSeek. */
export const USER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,512}$/u

/**
 * Hash an authorization token for lookup.
 * @param token - the token an employee presents.
 * @returns lowercase hex SHA-256 digest.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
