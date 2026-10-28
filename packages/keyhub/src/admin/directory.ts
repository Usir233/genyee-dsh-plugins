/** Department and employee directory of the admin relay, read from a YAML file. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'

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
}

/** One parsed directory generation. */
export interface Directory {
  readonly departments: ReadonlyMap<string, Department>
  /** Employees keyed by `tokenSha256`. */
  readonly byToken: ReadonlyMap<string, Employee>
}

/** An employee admitted to use the relay, with the department that pays for the request. */
export interface Admission {
  readonly employee: Employee
  readonly department: Department
}

/** `user_id` characters and length accepted by DeepSeek. */
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,512}$/u
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u

/**
 * Hash an authorization token for directory lookup.
 * @param token - the token an employee presents.
 * @returns lowercase hex SHA-256 digest.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Admit one token against a directory generation.
 * @param directory - the current directory.
 * @param token - the presented authorization token.
 * @returns the employee and department, or `undefined` when the token is unknown or either entry is disabled.
 */
export function admit(directory: Directory, token: string): Admission | undefined {
  const employee = directory.byToken.get(hashToken(token))
  if (employee === undefined || !employee.enabled) return undefined
  const department = directory.departments.get(employee.departmentId)
  if (department === undefined || !department.enabled) return undefined
  return { employee, department }
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} must be a mapping`)
  return value as Record<string, unknown>
}

function text(fields: Record<string, unknown>, key: string, where: string): string {
  const value = fields[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where}.${key} must be a non-empty string`)
  return value
}

function flag(fields: Record<string, unknown>, key: string, where: string): boolean {
  const value = fields[key] ?? true
  if (typeof value !== 'boolean') throw new Error(`${where}.${key} must be true or false`)
  return value
}

function list(fields: Record<string, unknown>, key: string, where: string): readonly unknown[] {
  const value = fields[key] ?? []
  if (!Array.isArray(value)) throw new Error(`${where}.${key} must be a list`)
  return value
}

/**
 * Parse and validate directory YAML text.
 * @param source - YAML text with `departments` and `employees` lists.
 * @param file - file name used in diagnostics.
 * @returns the validated directory.
 * @throws Error naming the first invalid entry.
 */
export function parseDirectory(source: string, file: string): Directory {
  const root = record(parse(source) ?? {}, file)
  const departments = new Map<string, Department>()
  for (const [index, raw] of list(root, 'departments', file).entries()) {
    const where = `${file}: departments[${index}]`
    const fields = record(raw, where)
    const department: Department = {
      id: text(fields, 'id', where),
      name: text(fields, 'name', where),
      keyRef: text(fields, 'keyRef', where),
      enabled: flag(fields, 'enabled', where),
    }
    if (departments.has(department.id)) throw new Error(`${where}.id "${department.id}" is duplicated`)
    departments.set(department.id, department)
  }
  const byToken = new Map<string, Employee>()
  const userIds = new Set<string>()
  for (const [index, raw] of list(root, 'employees', file).entries()) {
    const where = `${file}: employees[${index}]`
    const fields = record(raw, where)
    const employee: Employee = {
      userId: text(fields, 'userId', where),
      name: text(fields, 'name', where),
      departmentId: text(fields, 'department', where),
      tokenSha256: text(fields, 'tokenSha256', where).toLowerCase(),
      enabled: flag(fields, 'enabled', where),
    }
    if (!USER_ID_PATTERN.test(employee.userId)) throw new Error(`${where}.userId must match ${String(USER_ID_PATTERN)}`)
    if (!SHA256_HEX_PATTERN.test(employee.tokenSha256)) throw new Error(`${where}.tokenSha256 must be a hex SHA-256 digest`)
    if (!departments.has(employee.departmentId)) throw new Error(`${where}.department "${employee.departmentId}" is not a listed department`)
    if (userIds.has(employee.userId)) throw new Error(`${where}.userId "${employee.userId}" is duplicated`)
    if (byToken.has(employee.tokenSha256)) throw new Error(`${where}.tokenSha256 is shared with another employee`)
    userIds.add(employee.userId)
    byToken.set(employee.tokenSha256, employee)
  }
  return { departments, byToken }
}

/**
 * Read and validate the directory file.
 * @param file - absolute or working-directory-relative path.
 * @returns the validated directory.
 */
export async function loadDirectory(file: string): Promise<Directory> {
  return parseDirectory(await readFile(file, 'utf8'), file)
}
