/**
 * Admin command-line tools for the ledger, usable while the admin DSH runs:
 *
 *   make-cert   --ip 10.0.0.8 --out ./keyhub
 *   department  --db ledger.db --id rd --name 研发部 --key-ref GENYEE_DEEPSEEK_KEY_RD [--disable | --enable]
 *   employee-add --db ledger.db --name 张三 --department rd --relay https://10.0.0.8:8443 --cert relay.crt
 *   employee    --db ledger.db --user emp_xxx [--disable | --enable] [--department rd] [--models a,b | --all-models]
 *               [--max-concurrency 4 | --default-concurrency] [--reset-token --relay … --cert …]
 *   quota       --db ledger.db (--employee emp_xxx | --department rd) (--amount 100 --period month | --clear)
 *   top-up      --db ledger.db (--employee emp_xxx | --department rd) --amount 50 [--note 项目加急] [--time-zone Asia/Shanghai]
 *   price       --db ledger.db --model deepseek-flash --hit 0.2 --miss 2 --output 3
 *   report      --db ledger.db [--time-zone Asia/Shanghai]
 *
 * Amounts are in 元; prices in 元 per million tokens. Access codes are printed once and not stored.
 */
import { randomBytes, X509Certificate } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { generate } from 'selfsigned'
import { encodeAccessCode, normalizeFingerprint } from '../access-code.ts'
import { formatYuan, parsePrice, parseYuan, periodStart, PRICE_UNITS_PER_YUAN } from '../admin/money.ts'
import { quotaStanding } from '../admin/quota.ts'
import type { QuotaScope } from '../admin/store.ts'
import { KeyhubStore } from '../admin/store.ts'

/** Validity of a generated relay certificate. */
const CERT_VALIDITY_DAYS = 3650
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/**
 * Create a random DeepSeek `user_id` without personal data.
 * @returns `emp_` followed by 16 base32 characters.
 */
export function newUserId(): string {
  return `emp_${[...randomBytes(16)].map(byte => BASE32[byte % 32]).join('')}`
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) throw new Error(`missing --${flag}`)
  return value
}

function withStore<T>(db: string | undefined, run: (store: KeyhubStore) => T): T {
  const store = KeyhubStore.open(required(db, 'db'))
  try { return run(store) }
  finally { store.close() }
}

async function accessCodeFor(relay: string | undefined, cert: string | undefined, token: string): Promise<string> {
  const relayURL = new URL(required(relay, 'relay')).origin
  let fingerprint: string | undefined
  if (relayURL.startsWith('https:')) fingerprint = normalizeFingerprint(new X509Certificate(await readFile(required(cert, 'cert'))).fingerprint256)
  return encodeAccessCode({ relayURL, fingerprint, token })
}

function subjectOf(values: { employee?: string, department?: string }): [QuotaScope, string] {
  if ((values.employee === undefined) === (values.department === undefined)) throw new Error('name exactly one of --employee and --department')
  return values.employee !== undefined ? ['employee', values.employee] : ['department', values.department!]
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async 'make-cert'(args) {
    const { values } = parseArgs({ args, options: { ip: { type: 'string' }, out: { type: 'string' } } })
    const ip = required(values.ip, 'ip')
    if (isIP(ip) === 0) throw new Error('--ip must be the relay IP address')
    const out = required(values.out, 'out')
    const notBeforeDate = new Date()
    const pems = await generate([{ name: 'commonName', value: `Genyee keyhub ${ip}` }], {
      keySize: 2048, notBeforeDate, notAfterDate: new Date(notBeforeDate.getTime() + CERT_VALIDITY_DAYS * 86_400_000),
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip }] }],
    })
    await writeFile(join(out, 'relay.crt'), pems.cert)
    await writeFile(join(out, 'relay.key'), pems.private, { mode: 0o600 })
    console.log(`certificate: ${join(out, 'relay.crt')}\nprivate key: ${join(out, 'relay.key')}`)
    console.log(`fingerprint: ${normalizeFingerprint(new X509Certificate(pems.cert).fingerprint256)}`)
  },

  async department(args) {
    const { values } = parseArgs({ args, options: { db: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, 'key-ref': { type: 'string' }, disable: { type: 'boolean' }, enable: { type: 'boolean' } } })
    withStore(values.db, (store) => {
      const id = required(values.id, 'id')
      const current = store.department(id)
      store.putDepartment({
        id,
        name: values.name ?? current?.name ?? required(undefined, 'name'),
        keyRef: values['key-ref'] ?? current?.keyRef ?? required(undefined, 'key-ref'),
        enabled: values.disable === true ? false : values.enable === true ? true : current?.enabled ?? true,
      })
      console.log(`department ${id} saved`)
    })
  },

  async 'employee-add'(args) {
    const { values } = parseArgs({ args, options: { db: { type: 'string' }, name: { type: 'string' }, department: { type: 'string' }, relay: { type: 'string' }, cert: { type: 'string' } } })
    const userId = newUserId()
    const token = withStore(values.db, store => store.addEmployee({ userId, name: required(values.name, 'name'), departmentId: required(values.department, 'department') }))
    console.log(`employee ${userId} added; give this access code to ${values.name} (shown once):`)
    console.log(await accessCodeFor(values.relay, values.cert, token))
  },

  async employee(args) {
    const { values } = parseArgs({
      args,
      options: {
        db: { type: 'string' }, user: { type: 'string' }, disable: { type: 'boolean' }, enable: { type: 'boolean' }, department: { type: 'string' },
        models: { type: 'string' }, 'all-models': { type: 'boolean' }, 'max-concurrency': { type: 'string' }, 'default-concurrency': { type: 'boolean' },
        'reset-token': { type: 'boolean' }, relay: { type: 'string' }, cert: { type: 'string' },
      },
    })
    const userId = required(values.user, 'user')
    const token = withStore(values.db, (store) => {
      store.updateEmployee(userId, {
        ...values.disable === true ? { enabled: false } : values.enable === true ? { enabled: true } : {},
        ...values.department === undefined ? {} : { departmentId: values.department },
        ...values['all-models'] === true ? { models: null } : values.models === undefined ? {} : { models: values.models.split(',').map(model => model.trim()).filter(model => model.length > 0) },
        ...values['default-concurrency'] === true ? { maxConcurrency: null } : values['max-concurrency'] === undefined ? {} : { maxConcurrency: Number(values['max-concurrency']) },
      })
      return values['reset-token'] === true ? store.resetToken(userId) : undefined
    })
    console.log(`employee ${userId} saved`)
    if (token !== undefined) console.log(`new access code (the old one no longer works):\n${await accessCodeFor(values.relay, values.cert, token)}`)
  },

  async quota(args) {
    const { values } = parseArgs({ args, options: { db: { type: 'string' }, employee: { type: 'string' }, department: { type: 'string' }, amount: { type: 'string' }, period: { type: 'string' }, clear: { type: 'boolean' } } })
    const [scope, id] = subjectOf(values)
    withStore(values.db, (store) => {
      store.setQuota(scope, id, values.clear === true ? undefined : { micros: parseYuan(required(values.amount, 'amount')), period: required(values.period, 'period') }, Date.now())
    })
    console.log(`quota of ${scope} ${id} ${values.clear === true ? 'cleared' : 'saved'}`)
  },

  async 'top-up'(args) {
    const { values } = parseArgs({ args, options: { db: { type: 'string' }, employee: { type: 'string' }, department: { type: 'string' }, amount: { type: 'string' }, note: { type: 'string' }, 'time-zone': { type: 'string' } } })
    const [scope, id] = subjectOf(values)
    withStore(values.db, (store) => {
      const subject = scope === 'employee' ? store.employee(id) : store.department(id)
      if (subject?.quota === undefined) throw new Error(`${scope} ${id} has no quota to top up`)
      const now = Date.now()
      store.addTopUp(scope, id, parseYuan(required(values.amount, 'amount')), periodStart(subject.quota.period, now, values['time-zone'] ?? DEFAULT_TIME_ZONE), values.note, now)
    })
    console.log(`top-up of ${scope} ${id} saved`)
  },

  async price(args) {
    const { values } = parseArgs({ args, options: { db: { type: 'string' }, model: { type: 'string' }, hit: { type: 'string' }, miss: { type: 'string' }, output: { type: 'string' } } })
    withStore(values.db, (store) => {
      store.setPrice(required(values.model, 'model'), {
        inputCacheHit: parsePrice(required(values.hit, 'hit')),
        inputCacheMiss: parsePrice(required(values.miss, 'miss')),
        output: parsePrice(required(values.output, 'output')),
      }, Date.now())
    })
    console.log(`price of ${values.model} saved`)
  },

  async report(args) {
    const { values } = parseArgs({ args, options: { db: { type: 'string' }, 'time-zone': { type: 'string' } } })
    const timeZone = values['time-zone'] ?? DEFAULT_TIME_ZONE
    withStore(values.db, (store) => {
      const now = Date.now()
      const describe = (scope: QuotaScope, id: string, quota: Parameters<typeof quotaStanding>[3] | undefined): string => {
        if (quota === undefined) return '不限额'
        const standing = quotaStanding(store, scope, id, quota, now, timeZone)
        return `${quota.period}: 已用 ${formatYuan(standing.spentMicros)} / ${formatYuan(standing.allowanceMicros)}`
      }
      console.log('# 价格（元/百万 token：命中 / 未命中 / 输出）')
      for (const { model, price } of store.prices(now)) {
        console.log(`  ${model}: ${price.inputCacheHit / PRICE_UNITS_PER_YUAN} / ${price.inputCacheMiss / PRICE_UNITS_PER_YUAN} / ${price.output / PRICE_UNITS_PER_YUAN}`)
      }
      const month = periodStart('month', now, timeZone)!
      const spent = new Map(store.spending('employee', month, now + 1).map(row => [row.id, row]))
      for (const department of store.departments()) {
        console.log(`# ${department.name} (${department.id})${department.enabled ? '' : ' [停用]'} key=${department.keyRef} ${describe('department', department.id, department.quota)}`)
        for (const employee of store.employees().filter(entry => entry.departmentId === department.id)) {
          const row = spent.get(employee.userId)
          console.log(`  ${employee.name} ${employee.userId}${employee.enabled ? '' : ' [停用]'} ${describe('employee', employee.userId, employee.quota)}`
            + ` 本月 ${row?.requests ?? 0} 次 ${formatYuan(row?.costMicros ?? 0)}`
            + `${employee.models === undefined ? '' : ` 模型=${employee.models.join(',')}`}${employee.maxConcurrency === undefined ? '' : ` 并发=${employee.maxConcurrency}`}`)
        }
      }
    })
  },
}

const [command, ...rest] = process.argv.slice(2)
const selected = command === undefined ? undefined : commands[command]
if (selected === undefined) {
  console.error(`usage: admin-tools.js <${Object.keys(commands).join('|')}> [options]`)
  process.exitCode = 2
} else {
  selected(rest).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
