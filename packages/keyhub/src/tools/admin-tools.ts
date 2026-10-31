#!/usr/bin/env node
/**
 * Admin command-line tools for the ledger, usable while the admin DSH runs:
 *
 *   make-cert   --ip 10.0.0.8 --out ./keyhub
 *   relay-code  --relay https://10.0.0.8:8443 [--cert relay.crt]
 *   department  --db ledger.db --id rd --name 研发部 --key-ref GENYEE_DEEPSEEK_KEY_RD [--disable | --enable]
 *   employee-add --db ledger.db --name 张三 --department rd [--expires 2026-12-31] --relay https://10.0.0.8:8443 --cert relay.crt
 *   employee    --db ledger.db --user emp_xxx [--name 张三] [--disable | --enable] [--department rd] [--models a,b | --all-models]
 *               [--max-concurrency 4 | --default-concurrency] [--expires 2026-12-31 | --no-expires] [--reset-token --relay … --cert …]
 *   quota       --db ledger.db (--employee emp_xxx | --department rd) (--amount 100 --period month | --clear)
 *   top-up      --db ledger.db (--employee emp_xxx | --department rd) --amount 50 [--note 项目加急]
 *   price       --db ledger.db (--model deepseek-flash --hit 0.2 --miss 2 --output 3 | --defaults)
 *   report      --db ledger.db
 *   export      --db ledger.db --from 2026-10-01 --to 2026-11-01 [--employee emp_xxx | --department rd] --out usage.csv
 *
 * Amounts are in 元; prices in 元 per million tokens; periods and dates follow the time zone the admin relay recorded
 * in the ledger. Access codes are printed once and not stored.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { generate } from 'selfsigned'
import { encodeAccessCode, encodeRelayUpdate } from '../access-code.ts'
import { applyDefaultPrices, certificateFingerprint, describeQuota, newUserId, quotaView, topUp, usageCsv } from '../admin/ledger-ops.ts'
import { formatYuan, parsePrice, parseYuan, periodStart, PRICE_UNITS_PER_YUAN, zonedDayStart } from '../admin/money.ts'
import type { QuotaScope } from '../admin/store.ts'
import { KeyhubStore } from '../admin/store.ts'

/** Validity of a generated relay certificate. */
const CERT_VALIDITY_DAYS = 3650

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
  if (relayURL.startsWith('https:')) fingerprint = certificateFingerprint(await readFile(required(cert, 'cert')))
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
    console.log(`fingerprint: ${certificateFingerprint(pems.cert)}`)
  },

  async 'relay-code'(args) {
    const { values } = parseArgs({ args, options: { relay: { type: 'string' }, cert: { type: 'string' } } })
    const relayURL = new URL(required(values.relay, 'relay')).origin
    let fingerprint: string | undefined
    if (relayURL.startsWith('https:')) fingerprint = certificateFingerprint(await readFile(required(values.cert, 'cert')))
    console.log(encodeRelayUpdate({ relayURL, fingerprint }))
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
    const { values } = parseArgs({ args, options: { db: { type: 'string' }, name: { type: 'string' }, department: { type: 'string' }, expires: { type: 'string' }, relay: { type: 'string' }, cert: { type: 'string' } } })
    const userId = newUserId()
    const token = withStore(values.db, (store) => {
      const expiresAt = values.expires === undefined ? undefined : dateEnd(values.expires, store.timeZone())
      return store.addEmployee({ userId, name: required(values.name, 'name'), departmentId: required(values.department, 'department'), ...expiresAt === undefined ? {} : { expiresAt } })
    })
    console.log(`employee ${userId} added; give this access code to ${values.name} (shown once):`)
    console.log(await accessCodeFor(values.relay, values.cert, token))
  },

  async employee(args) {
    const { values } = parseArgs({
      args,
      options: {
        db: { type: 'string' }, user: { type: 'string' }, name: { type: 'string' }, disable: { type: 'boolean' }, enable: { type: 'boolean' }, department: { type: 'string' },
        models: { type: 'string' }, 'all-models': { type: 'boolean' }, 'max-concurrency': { type: 'string' }, 'default-concurrency': { type: 'boolean' },
        expires: { type: 'string' }, 'no-expires': { type: 'boolean' },
        'reset-token': { type: 'boolean' }, relay: { type: 'string' }, cert: { type: 'string' },
      },
    })
    const userId = required(values.user, 'user')
    const token = withStore(values.db, (store) => {
      const timeZone = store.timeZone()
      store.updateEmployee(userId, {
        ...values.name === undefined ? {} : { name: values.name },
        ...values.disable === true ? { enabled: false } : values.enable === true ? { enabled: true } : {},
        ...values.department === undefined ? {} : { departmentId: values.department },
        ...values['all-models'] === true ? { models: null } : values.models === undefined ? {} : { models: values.models.split(',').map(model => model.trim()).filter(model => model.length > 0) },
        ...values['default-concurrency'] === true ? { maxConcurrency: null } : values['max-concurrency'] === undefined ? {} : { maxConcurrency: Number(values['max-concurrency']) },
        ...values['no-expires'] === true ? { expiresAt: null } : values.expires === undefined ? {} : { expiresAt: dateEnd(values.expires, timeZone) },
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
    const { values } = parseArgs({ args, options: { db: { type: 'string' }, employee: { type: 'string' }, department: { type: 'string' }, amount: { type: 'string' }, note: { type: 'string' } } })
    const [scope, id] = subjectOf(values)
    withStore(values.db, (store) => {
      topUp(store, scope, id, parseYuan(required(values.amount, 'amount')), values.note, Date.now())
    })
    console.log(`top-up of ${scope} ${id} saved`)
  },

  async price(args) {
    const { values } = parseArgs({ args, options: { db: { type: 'string' }, model: { type: 'string' }, hit: { type: 'string' }, miss: { type: 'string' }, output: { type: 'string' }, defaults: { type: 'boolean' } } })
    withStore(values.db, (store) => {
      if (values.defaults === true) {
        const added = applyDefaultPrices(store, Date.now())
        console.log(`${added} default model price(s) added`)
        return
      }
      store.setPrice(required(values.model, 'model'), {
        inputCacheHit: parsePrice(required(values.hit, 'hit')),
        inputCacheMiss: parsePrice(required(values.miss, 'miss')),
        output: parsePrice(required(values.output, 'output')),
      }, Date.now())
      console.log(`price of ${values.model} saved`)
    })
  },

  async report(args) {
    const { values } = parseArgs({ args, options: { db: { type: 'string' } } })
    withStore(values.db, (store) => {
      const now = Date.now()
      const timeZone = store.timeZone()
      const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      const describe = (scope: QuotaScope, id: string, quota: Parameters<typeof quotaView>[3]): string => describeQuota(quotaView(store, scope, id, quota, now))
      console.log('# 价格（元/百万 token：命中 / 未命中 / 输出）')
      for (const { model, price } of store.prices(now)) {
        console.log(`  ${model}: ${price.inputCacheHit / PRICE_UNITS_PER_YUAN} / ${price.inputCacheMiss / PRICE_UNITS_PER_YUAN} / ${price.output / PRICE_UNITS_PER_YUAN}`)
      }
      const month = periodStart('month', now, timeZone)!
      const spent = new Map(store.spending('employee', month, now + 1).map(row => [row.id, row]))
      const ips = store.clientAddresses(now - 86_400_000)
      for (const department of store.departments()) {
        console.log(`# ${department.name} (${department.id})${department.enabled ? '' : ' [停用]'} key=${department.keyRef} ${describe('department', department.id, department.quota)}`)
        for (const employee of store.employees().filter(entry => entry.departmentId === department.id)) {
          const row = spent.get(employee.userId)
          const ip = ips.get(employee.userId)
          const expiry = employee.expiresAt === undefined ? '' : ` 到期=${dateFmt.format(employee.expiresAt)}${now >= employee.expiresAt ? '[已过期]' : ''}`
          const ipInfo = ip === undefined ? '' : ` IP=${ip.lastAddress}${ip.recentAddresses.length > 1 ? `(24h:${ip.recentAddresses.length})` : ''}`
          console.log(`  ${employee.name} ${employee.userId}${employee.enabled ? '' : ' [停用]'} ${describe('employee', employee.userId, employee.quota)}`
            + ` 本月 ${row?.requests ?? 0} 次 ${formatYuan(row?.costMicros ?? 0)}`
            + `${employee.models === undefined ? '' : ` 模型=${employee.models.join(',')}`}${employee.maxConcurrency === undefined ? '' : ` 并发=${employee.maxConcurrency}`}${expiry}${ipInfo}`)
        }
      }
    })
  },

  async export(args) {
    const { values } = parseArgs({ args, options: { db: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, employee: { type: 'string' }, department: { type: 'string' }, out: { type: 'string' } } })
    const out = required(values.out, 'out')
    const csv = withStore(values.db, (store) => {
      const timeZone = store.timeZone()
      return usageCsv(store, {
        from: dateStart(required(values.from, 'from'), timeZone),
        to: dateStart(required(values.to, 'to'), timeZone),
        ...values.employee === undefined ? {} : { userId: values.employee },
        ...values.department === undefined ? {} : { departmentId: values.department },
      })
    })
    await writeFile(out, csv)
    console.log(`usage written to ${out}`)
  },
}

/**
 * Midnight of a calendar date on the ledger's calendar.
 * @param date - `YYYY-MM-DD`.
 * @param timeZone - the ledger time zone.
 * @returns epoch milliseconds.
 */
function dateStart(date: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date)
  if (match === null) throw new Error(`date "${date}" must be YYYY-MM-DD`)
  return zonedDayStart(Number(match[1]), Number(match[2]), Number(match[3]), timeZone)
}

/**
 * End (`23:59:59.999`) of a calendar date on the ledger's calendar.
 * @param date - `YYYY-MM-DD`.
 * @param timeZone - the ledger time zone.
 * @returns epoch milliseconds.
 */
function dateEnd(date: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date)
  if (match === null) throw new Error(`date "${date}" must be YYYY-MM-DD`)
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1))
  return zonedDayStart(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone) - 1
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
