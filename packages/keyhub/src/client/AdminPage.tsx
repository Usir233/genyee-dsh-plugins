/** Management page of the admin role: departments, employees, quotas, prices, usage, and service status. */
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChannelCall, Translate } from './host.ts'
import type {
  DepartmentView, EmployeeView, IssuedCode, ManagementState, QuotaPeriod, QuotaScope, QuotaView, UsageSummary,
} from './types.ts'

const PERIODS: readonly QuotaPeriod[] = ['day', 'week', 'month', 'year', 'total']
const TABS = ['departments', 'employees', 'quotas', 'prices', 'usage', 'service'] as const
type Tab = typeof TABS[number]

/**
 * Format micro-yuan for people.
 * @param micros - amount in micro-yuan.
 * @returns `¥` with two decimals, or four below one fen.
 */
export function yuan(micros: number): string {
  const value = micros / 1_000_000
  return `¥${value !== 0 && Math.abs(value) < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
}

function quotaText(t: Translate, quota: QuotaView | undefined): string {
  if (quota === undefined) return t('common.unlimited')
  return `${t(`period.${quota.period}`)} ${t('quota.used', { spent: yuan(quota.spentMicros), allowance: yuan(quota.allowanceMicros) })}`
}

/** Props of {@link AdminPage}. */
export interface AdminPageProps {
  readonly t: Translate
  /** Caller of the admin channel. */
  readonly call: ChannelCall
}

/** Shared mutation plumbing of the tabs. */
interface Mutations {
  readonly t: Translate
  readonly state: ManagementState
  /**
   * Run one state-changing call and adopt the returned state.
   * @param endpoint - admin channel endpoint.
   * @param payload - request payload.
   * @returns whether it succeeded; failures are shown on the page.
   */
  mutate(endpoint: string, payload: object): Promise<boolean>
  /** Run a call that issues an access code and show the code. */
  issue(endpoint: string, payload: object, name: string): Promise<boolean>
  readonly call: ChannelCall
}

/**
 * The management page.
 * @param props - translation and the admin channel.
 * @returns the page.
 */
export function AdminPage({ t, call }: AdminPageProps) {
  const [tab, setTab] = useState<Tab>('departments')
  const [state, setState] = useState<ManagementState | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [issued, setIssued] = useState<{ name: string, code: string } | undefined>()

  const load = useCallback(async () => {
    try {
      setState(await call<ManagementState>('state'))
      setError(undefined)
    } catch (failure) {
      setError(t('admin.loadFailed', { message: failure instanceof Error ? failure.message : String(failure) }))
    }
  }, [call, t])
  useEffect(() => { void load() }, [load])

  const mutate = useCallback(async (endpoint: string, payload: object) => {
    try {
      setState(await call<ManagementState>(endpoint, payload))
      setError(undefined)
      setNotice(t('common.saved'))
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setNotice(undefined)
      return false
    }
  }, [call, t])

  const issue = useCallback(async (endpoint: string, payload: object, name: string) => {
    try {
      const answer = await call<IssuedCode>(endpoint, payload)
      setState(answer.state)
      setIssued({ name, code: answer.accessCode })
      setError(undefined)
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      return false
    }
  }, [call])

  useEffect(() => {
    if (notice === undefined) return
    const timer = setTimeout(() => { setNotice(undefined) }, 2500)
    return () => { clearTimeout(timer) }
  }, [notice])

  if (state === undefined) {
    return <div className="gk-page">{error === undefined ? <p>{t('admin.loading')}</p> : <div className="gk-notice gk-error">{error}</div>}</div>
  }
  const shared: Mutations = { t, state, mutate, issue, call }
  return (
    <div className="gk-page">
      <div className="gk-head">
        <div>
          <h1 className="gk-title">{t('admin.title')}</h1>
          <div className="gk-subtitle">{t('admin.subtitle', { url: state.service.relayURL })}</div>
        </div>
        <button type="button" className="gk-button" onClick={() => { void load() }}>{t('admin.refresh')}</button>
      </div>
      <div className="gk-tabs" role="tablist">
        {TABS.map(name => (
          <button key={name} type="button" role="tab" className="gk-tab" aria-selected={tab === name} onClick={() => { setTab(name) }}>{t(`tab.${name}`)}</button>
        ))}
      </div>
      {error !== undefined && <div className="gk-notice gk-error" role="alert">{error}</div>}
      {notice !== undefined && error === undefined && <div className="gk-notice gk-info" role="status">{notice}</div>}
      {tab === 'departments' && <DepartmentsTab {...shared} />}
      {tab === 'employees' && <EmployeesTab {...shared} />}
      {tab === 'quotas' && <QuotasTab {...shared} />}
      {tab === 'prices' && <PricesTab {...shared} />}
      {tab === 'usage' && <UsageTab {...shared} onError={setError} />}
      {tab === 'service' && <ServiceTab {...shared} />}
      {issued !== undefined && <AccessCodeDialog t={t} name={issued.name} code={issued.code} onClose={() => { setIssued(undefined) }} />}
    </div>
  )
}

function Table({ head, rows, empty }: { head: ReactNode[], rows: ReactNode[][], empty: string }) {
  return (
    <div className="gk-table-wrap">
      <table className="gk-table">
        <thead><tr>{head.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0
            ? <tr><td colSpan={head.length}>{empty}</td></tr>
            : rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  )
}

function Field({ label, children }: { label: string, children: ReactNode }) {
  return <label className="gk-field"><span>{label}</span>{children}</label>
}

function StatusTag({ t, enabled }: { t: Translate, enabled: boolean }) {
  return <span className={`gk-tag ${enabled ? 'gk-ok' : 'gk-bad'}`}><span className="gk-dot" />{t(enabled ? 'common.enabled' : 'common.disabled')}</span>
}

function DepartmentsTab({ t, state, mutate }: Mutations) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [keying, setKeying] = useState<string | undefined>()
  const [key, setKey] = useState('')
  const rows = state.departments.map((department: DepartmentView) => [
    department.name,
    <span className="gk-mono">{department.id}</span>,
    <span className="gk-mono">{department.keyRef}</span>,
    keying === department.id
      ? (
          <span className="gk-actions">
            <input className="gk-input" type="password" autoComplete="off" value={key} placeholder={t('department.keyPlaceholder')} onChange={(event) => { setKey(event.target.value) }} />
            <button type="button" className="gk-button gk-primary gk-small" disabled={key.trim().length === 0} onClick={() => { void mutate('department.setKey', { id: department.id, key }).then((ok) => { if (ok) { setKeying(undefined); setKey('') } }) }}>{t('common.save')}</button>
            <button type="button" className="gk-button gk-small" onClick={() => { setKeying(undefined); setKey('') }}>{t('common.cancel')}</button>
          </span>
        )
      : <span className={`gk-tag ${state.keyConfigured[department.id] ? 'gk-ok' : 'gk-bad'}`}><span className="gk-dot" />{t(state.keyConfigured[department.id] ? 'department.keyConfigured' : 'department.keyMissing')}</span>,
    quotaText(t, department.quota),
    yuan(department.monthSpentMicros),
    String(department.employees),
    <StatusTag t={t} enabled={department.enabled} />,
    <span className="gk-actions">
      <button type="button" className="gk-button gk-small" onClick={() => { setKeying(department.id); setKey('') }}>{t('department.setKey')}</button>
      <button type="button" className={`gk-button gk-small ${department.enabled ? 'gk-danger' : ''}`} onClick={() => { void mutate('department.save', { id: department.id, enabled: !department.enabled }) }}>{t(department.enabled ? 'common.disable' : 'common.enable')}</button>
    </span>,
  ])
  return (
    <>
      <div className="gk-card">
        <Table
          head={[t('department.name'), t('department.id'), t('department.keyRef'), t('department.key'), t('department.quota'), t('department.month'), t('department.employees'), t('department.status'), t('common.actions')]}
          rows={rows}
          empty={t('common.none')}
        />
      </div>
      <div className="gk-card">
        <h3>{t('department.add')}</h3>
        <form className="gk-form" onSubmit={(event) => { event.preventDefault(); void mutate('department.save', { id, name }).then((ok) => { if (ok) { setId(''); setName('') } }) }}>
          <Field label={t('department.id')}><input className="gk-input" value={id} onChange={(event) => { setId(event.target.value) }} /></Field>
          <Field label={t('department.name')}><input className="gk-input" value={name} onChange={(event) => { setName(event.target.value) }} /></Field>
          <button type="submit" className="gk-button gk-primary" disabled={id.trim().length === 0 || name.trim().length === 0}>{t('common.add')}</button>
        </form>
        <p className="gk-hint">{t('department.idHint')}</p>
      </div>
    </>
  )
}

/** Local calendar date `YYYY-MM-DD` of an instant. */
function isoDate(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

function parseExpiryDate(date: string): number | null {
  const trimmed = date.trim()
  return trimmed === '' ? null : new Date(`${trimmed}T23:59:59.999`).getTime()
}

function EmployeeEditor({ t, state, employee, mutate, onDone }: Mutations & { employee: EmployeeView, onDone(): void }) {
  const [name, setName] = useState(employee.name)
  const [departmentId, setDepartmentId] = useState(employee.departmentId)
  const [allModels, setAllModels] = useState(employee.models === undefined)
  const [models, setModels] = useState<string[]>([...employee.models ?? []])
  const [concurrency, setConcurrency] = useState(employee.maxConcurrency === undefined ? '' : String(employee.maxConcurrency))
  const [expires, setExpires] = useState(employee.expiresAt === undefined ? '' : isoDate(new Date(employee.expiresAt)))
  const save = (): void => {
    const limit = concurrency.trim() === '' ? null : Number(concurrency)
    const expiresAt = parseExpiryDate(expires)
    void mutate('employee.update', { userId: employee.userId, name, departmentId, models: allModels ? null : models, maxConcurrency: limit, expiresAt }).then((ok) => { if (ok) onDone() })
  }
  return (
    <div className="gk-form">
      <Field label={t('employee.name')}>
        <input className="gk-input" value={name} onChange={(event) => { setName(event.target.value) }} />
      </Field>
      <Field label={t('employee.department')}>
        <select className="gk-select" value={departmentId} onChange={(event) => { setDepartmentId(event.target.value) }}>
          {state.departments.map(department => <option key={department.id} value={department.id}>{department.name}</option>)}
        </select>
      </Field>
      <Field label={t('employee.models')}>
        <span className="gk-models">
          <label><input type="checkbox" checked={allModels} onChange={(event) => { setAllModels(event.target.checked) }} />{t('employee.allModels')}</label>
          {!allModels && state.prices.map(price => (
            <label key={price.model}>
              <input type="checkbox" checked={models.includes(price.model)} onChange={(event) => { setModels(event.target.checked ? [...models, price.model] : models.filter(model => model !== price.model)) }} />
              {price.model}
            </label>
          ))}
        </span>
      </Field>
      <Field label={t('employee.concurrency')}>
        <input className="gk-input" inputMode="numeric" value={concurrency} placeholder={t('employee.concurrencyDefault', { n: state.service.defaultMaxConcurrency })} onChange={(event) => { setConcurrency(event.target.value) }} />
      </Field>
      <Field label={t('employee.expires')}>
        <input className="gk-input" type="date" value={expires} onChange={(event) => { setExpires(event.target.value) }} />
      </Field>
      <button type="button" className="gk-button gk-primary" disabled={name.trim().length === 0} onClick={save}>{t('common.save')}</button>
      <button type="button" className="gk-button" onClick={onDone}>{t('common.cancel')}</button>
    </div>
  )
}

function EmployeesTab(props: Mutations) {
  const { t, state, mutate, issue } = props
  const [name, setName] = useState('')
  const [departmentId, setDepartmentId] = useState(state.departments[0]?.id ?? '')
  const [expires, setExpires] = useState('')
  const [filterDepartment, setFilterDepartment] = useState('')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<string | undefined>()
  const departments = useMemo(() => new Map(state.departments.map(department => [department.id, department.name])), [state.departments])
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return state.employees.filter((employee) => {
      if (filterDepartment !== '' && employee.departmentId !== filterDepartment) return false
      if (keyword === '') return true
      return employee.name.toLowerCase().includes(keyword)
        || employee.userId.toLowerCase().includes(keyword)
        || (employee.lastClientAddress ?? '').toLowerCase().includes(keyword)
        || employee.recentClientAddresses.some(addr => addr.toLowerCase().includes(keyword))
    })
  }, [state.employees, filterDepartment, search])
  const now = Date.now()
  const rows = filtered.map((employee: EmployeeView) => [
    employee.name,
    departments.get(employee.departmentId) ?? employee.departmentId,
    <span className="gk-mono">{employee.userId}</span>,
    quotaText(t, employee.quota),
    t('employee.monthValue', { count: employee.monthRequests, cost: yuan(employee.monthSpentMicros) }),
    employee.models === undefined ? t('common.all') : employee.models.join(', ') || '—',
    employee.maxConcurrency === undefined ? t('employee.concurrencyDefault', { n: state.service.defaultMaxConcurrency }) : String(employee.maxConcurrency),
    employee.expiresAt === undefined
      ? t('employee.neverExpires')
      : now >= employee.expiresAt
        ? <span className="gk-tag gk-bad">{t('employee.expired', { date: isoDate(new Date(employee.expiresAt)) })}</span>
        : isoDate(new Date(employee.expiresAt)),
    employee.lastClientAddress === undefined
      ? '—'
      : (
          <span className="gk-actions">
            <span className="gk-mono">{employee.lastClientAddress}</span>
            {employee.recentClientAddresses.length > 1 && (
              <span className="gk-tag gk-bad" title={employee.recentClientAddresses.join(', ')}>
                {t('employee.multiIp', { n: employee.recentClientAddresses.length })}
              </span>
            )}
          </span>
        ),
    <StatusTag t={t} enabled={employee.enabled} />,
    <span className="gk-actions">
      <button type="button" className="gk-button gk-small" onClick={() => { setEditing(employee.userId) }}>{t('common.edit')}</button>
      <button type="button" className="gk-button gk-small" onClick={() => { if (window.confirm(t('employee.resetConfirm', { name: employee.name }))) void issue('employee.resetToken', { userId: employee.userId }, employee.name) }}>{t('employee.resetCode')}</button>
      <button type="button" className={`gk-button gk-small ${employee.enabled ? 'gk-danger' : ''}`} onClick={() => { void mutate('employee.update', { userId: employee.userId, enabled: !employee.enabled }) }}>{t(employee.enabled ? 'common.disable' : 'common.enable')}</button>
    </span>,
  ])
  const edited = state.employees.find(employee => employee.userId === editing)
  return (
    <>
      <div className="gk-card">
        <div className="gk-form" style={{ marginBottom: 12 }}>
          <Field label={t('employee.filterDepartment')}>
            <select className="gk-select" value={filterDepartment} onChange={(event) => { setFilterDepartment(event.target.value) }}>
              <option value="">{t('common.all')}</option>
              {state.departments.map(department => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
          </Field>
          <Field label={t('employee.search')}>
            <input className="gk-input" value={search} placeholder={t('employee.searchPlaceholder')} onChange={(event) => { setSearch(event.target.value) }} />
          </Field>
        </div>
        <Table
          head={[t('employee.name'), t('employee.department'), t('employee.userId'), t('employee.quota'), t('employee.month'), t('employee.models'), t('employee.concurrency'), t('employee.expires'), t('employee.ip'), t('employee.status'), t('common.actions')]}
          rows={rows}
          empty={t('common.none')}
        />
      </div>
      {edited !== undefined && (
        <div className="gk-card">
          <h3>{`${t('common.edit')} · ${edited.name}`}</h3>
          <EmployeeEditor key={edited.userId} {...props} employee={edited} onDone={() => { setEditing(undefined) }} />
        </div>
      )}
      <div className="gk-card">
        <h3>{t('employee.add')}</h3>
        <form className="gk-form" onSubmit={(event) => { event.preventDefault(); const expiresAt = parseExpiryDate(expires); void issue('employee.add', { name, departmentId, ...expiresAt === null ? {} : { expiresAt } }, name).then((ok) => { if (ok) { setName(''); setExpires('') } }) }}>
          <Field label={t('employee.name')}><input className="gk-input" value={name} onChange={(event) => { setName(event.target.value) }} /></Field>
          <Field label={t('employee.department')}>
            <select className="gk-select" value={departmentId} onChange={(event) => { setDepartmentId(event.target.value) }}>
              {state.departments.map(department => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
          </Field>
          <Field label={t('employee.expires')}>
            <input className="gk-input" type="date" value={expires} onChange={(event) => { setExpires(event.target.value) }} />
          </Field>
          <button type="submit" className="gk-button gk-primary" disabled={name.trim().length === 0 || departmentId === ''}>{t('common.add')}</button>
        </form>
      </div>
    </>
  )
}

function SubjectPicker({ t, state, scope, subject, onScope, onSubject }: { t: Translate, state: ManagementState, scope: QuotaScope, subject: string, onScope(scope: QuotaScope): void, onSubject(id: string): void }) {
  const subjects = scope === 'department'
    ? state.departments.map(department => ({ id: department.id, name: department.name }))
    : state.employees.map(employee => ({ id: employee.userId, name: employee.name }))
  return (
    <>
      <Field label={t('quota.scope')}>
        <select className="gk-select" value={scope} onChange={(event) => { onScope(event.target.value as QuotaScope) }}>
          <option value="department">{t('tab.departments')}</option>
          <option value="employee">{t('tab.employees')}</option>
        </select>
      </Field>
      <Field label={t('quota.subject')}>
        <select className="gk-select" value={subject} onChange={(event) => { onSubject(event.target.value) }}>
          <option value="" />
          {subjects.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </Field>
    </>
  )
}

function QuotasTab({ t, state, mutate }: Mutations) {
  const [scope, setScope] = useState<QuotaScope>('department')
  const [subject, setSubject] = useState('')
  const [amount, setAmount] = useState('')
  const [period, setPeriod] = useState<QuotaPeriod>('month')
  const [topScope, setTopScope] = useState<QuotaScope>('department')
  const [topSubject, setTopSubject] = useState('')
  const [topAmount, setTopAmount] = useState('')
  const [note, setNote] = useState('')
  const departments = new Map(state.departments.map(department => [department.id, department.name]))
  const rows = [
    ...state.departments.filter(department => department.quota !== undefined).map(department => [t('tab.departments'), department.name, quotaText(t, department.quota), yuan(department.quota!.remainingMicros)]),
    ...state.employees.filter(employee => employee.quota !== undefined).map(employee => [t('tab.employees'), `${employee.name}（${departments.get(employee.departmentId) ?? employee.departmentId}）`, quotaText(t, employee.quota), yuan(employee.quota!.remainingMicros)]),
  ]
  return (
    <>
      <div className="gk-card">
        <h3>{t('quota.current')}</h3>
        <Table head={[t('quota.scope'), t('quota.subject'), t('department.quota'), t('quota.remaining')]} rows={rows} empty={t('common.none')} />
      </div>
      <div className="gk-card">
        <h3>{t('quota.set')}</h3>
        <form className="gk-form" onSubmit={(event) => { event.preventDefault(); void mutate('quota.set', { scope, id: subject, amount, period }) }}>
          <SubjectPicker t={t} state={state} scope={scope} subject={subject} onScope={(next) => { setScope(next); setSubject('') }} onSubject={setSubject} />
          <Field label={t('quota.amount')}><input className="gk-input" inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value) }} /></Field>
          <Field label={t('quota.period')}>
            <select className="gk-select" value={period} onChange={(event) => { setPeriod(event.target.value as QuotaPeriod) }}>
              {PERIODS.map(entry => <option key={entry} value={entry}>{t(`period.${entry}`)}</option>)}
            </select>
          </Field>
          <button type="submit" className="gk-button gk-primary" disabled={subject === '' || amount.trim() === ''}>{t('common.save')}</button>
          <button type="button" className="gk-button gk-danger" disabled={subject === ''} onClick={() => { void mutate('quota.set', { scope, id: subject }) }}>{t('quota.clear')}</button>
        </form>
      </div>
      <div className="gk-card">
        <h3>{t('quota.topUp')}</h3>
        <form className="gk-form" onSubmit={(event) => { event.preventDefault(); void mutate('quota.topUp', { scope: topScope, id: topSubject, amount: topAmount, note }).then((ok) => { if (ok) { setTopAmount(''); setNote('') } }) }}>
          <SubjectPicker t={t} state={state} scope={topScope} subject={topSubject} onScope={(next) => { setTopScope(next); setTopSubject('') }} onSubject={setTopSubject} />
          <Field label={t('quota.amount')}><input className="gk-input" inputMode="decimal" value={topAmount} onChange={(event) => { setTopAmount(event.target.value) }} /></Field>
          <Field label={t('quota.note')}><input className="gk-input" value={note} onChange={(event) => { setNote(event.target.value) }} /></Field>
          <button type="submit" className="gk-button gk-primary" disabled={topSubject === '' || topAmount.trim() === ''}>{t('common.add')}</button>
        </form>
        <p className="gk-hint">{t('quota.topUpHint')}</p>
      </div>
    </>
  )
}

function PricesTab({ t, state, mutate }: Mutations) {
  const [model, setModel] = useState('')
  const [hit, setHit] = useState('')
  const [miss, setMiss] = useState('')
  const [output, setOutput] = useState('')
  const fill = (entry: { model: string, inputCacheHit: number, inputCacheMiss: number, output: number }): void => {
    setModel(entry.model)
    setHit(String(entry.inputCacheHit))
    setMiss(String(entry.inputCacheMiss))
    setOutput(String(entry.output))
  }
  return (
    <>
      <div className="gk-card">
        <Table
          head={[t('price.model'), t('price.hit'), t('price.miss'), t('price.output'), t('common.actions')]}
          rows={state.prices.map(price => [
            <span className="gk-mono">{price.model}</span>, `¥${price.inputCacheHit}`, `¥${price.inputCacheMiss}`, `¥${price.output}`,
            <span className="gk-actions">
              <button type="button" className="gk-button gk-small" onClick={() => { fill(price) }}>{t('common.edit')}</button>
              <button type="button" className="gk-button gk-small gk-danger" onClick={() => { if (window.confirm(t('price.removeConfirm', { model: price.model }))) void mutate('price.remove', { model: price.model }) }}>{t('common.remove')}</button>
            </span>,
          ])}
          empty={t('common.none')}
        />
        <p className="gk-hint">{t('price.unit')}</p>
      </div>
      <div className="gk-card">
        <h3>{t('price.set')}</h3>
        <form className="gk-form" onSubmit={(event) => { event.preventDefault(); void mutate('price.set', { model, hit, miss, output }) }}>
          <Field label={t('price.model')}><input className="gk-input" value={model} placeholder="deepseek-flash" onChange={(event) => { setModel(event.target.value) }} /></Field>
          <Field label={t('price.hit')}><input className="gk-input" inputMode="decimal" value={hit} onChange={(event) => { setHit(event.target.value) }} /></Field>
          <Field label={t('price.miss')}><input className="gk-input" inputMode="decimal" value={miss} onChange={(event) => { setMiss(event.target.value) }} /></Field>
          <Field label={t('price.output')}><input className="gk-input" inputMode="decimal" value={output} onChange={(event) => { setOutput(event.target.value) }} /></Field>
          <button type="submit" className="gk-button gk-primary" disabled={[model, hit, miss, output].some(value => value.trim() === '')}>{t('common.save')}</button>
          <button type="button" className="gk-button" onClick={() => { void mutate('price.defaults', {}) }}>{t('price.fillDefaults')}</button>
        </form>
      </div>
    </>
  )
}

/** Range from the start of `from` to the end of `to`, both local calendar dates. */
function dateRange(from: string, to: string): { from: number, to: number } {
  const end = new Date(`${to}T00:00:00`)
  end.setDate(end.getDate() + 1)
  return { from: new Date(`${from}T00:00:00`).getTime(), to: end.getTime() }
}

function UsageTab({ t, state, call, onError }: Mutations & { onError(message: string | undefined): void }) {
  const today = new Date()
  const [from, setFrom] = useState(isoDate(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [to, setTo] = useState(isoDate(today))
  const [summary, setSummary] = useState<UsageSummary | undefined>()
  // The range shown: set on opening and by the query button, not on every date edit.
  const [shown, setShown] = useState(() => dateRange(from, to))
  useEffect(() => {
    let current = true
    call<UsageSummary>('usage.summary', shown).then((value) => {
      if (!current) return
      setSummary(value)
      onError(undefined)
    }, (failure: unknown) => {
      if (current) onError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => { current = false }
  }, [call, shown, onError])
  const exportCsv = async (): Promise<void> => {
    try {
      const { csv } = await call<{ csv: string }>('usage.csv', dateRange(from, to))
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `genyee-keyhub-usage-${from}-${to}.csv`
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure))
    }
  }
  const names = new Map<string, string>([
    ...state.employees.map(employee => [employee.userId, employee.name] as const),
    ...state.departments.map(department => [department.id, department.name] as const),
  ])
  const table = (rows: UsageSummary['employees']) => {
    const total = rows.reduce((sum, row) => sum + row.costMicros, 0)
    return (
      <Table
        head={[t('quota.subject'), t('usage.requests'), t('usage.input'), t('usage.cacheRead'), t('usage.output'), t('usage.cost')]}
        rows={[
          ...rows.map(row => [names.get(row.id) ?? row.id, row.requests, row.inputTokens, row.cacheReadTokens, row.outputTokens, yuan(row.costMicros)]),
          ...rows.length === 0 ? [] : [[t('usage.total'), '', '', '', '', yuan(total)]],
        ]}
        empty={t('common.none')}
      />
    )
  }
  return (
    <>
      <div className="gk-card">
        <form className="gk-form" onSubmit={(event) => { event.preventDefault(); setShown(dateRange(from, to)) }}>
          <Field label={t('usage.from')}><input className="gk-input" type="date" value={from} onChange={(event) => { setFrom(event.target.value) }} /></Field>
          <Field label={t('usage.to')}><input className="gk-input" type="date" value={to} onChange={(event) => { setTo(event.target.value) }} /></Field>
          <button type="submit" className="gk-button gk-primary">{t('usage.query')}</button>
          <button type="button" className="gk-button" onClick={() => { void exportCsv() }}>{t('usage.export')}</button>
        </form>
      </div>
      <div className="gk-card"><h3>{t('usage.byDepartment')}</h3>{summary !== undefined && table(summary.departments)}</div>
      <div className="gk-card"><h3>{t('usage.byEmployee')}</h3>{summary !== undefined && table(summary.employees)}</div>
    </>
  )
}

function ServiceTab({ t, state, call }: Mutations) {
  const [balance, setBalance] = useState(state.balance)
  const [copiedUpdate, setCopiedUpdate] = useState(false)
  useEffect(() => { setBalance(state.balance) }, [state.balance])
  const refresh = async (): Promise<void> => { setBalance(await call<ManagementState['balance']>('balance.refresh')) }
  const { service } = state
  const copyUpdateCode = async (): Promise<void> => {
    if (service.relayUpdateCode === undefined) return
    await navigator.clipboard.writeText(service.relayUpdateCode)
    setCopiedUpdate(true)
    setTimeout(() => { setCopiedUpdate(false) }, 2000)
  }
  let balanceText: ReactNode
  switch (balance.state) {
    case 'unknown': balanceText = t('service.balanceUnknown'); break
    case 'failed': balanceText = <span className="gk-tag gk-bad">{t('service.balanceFailed', { message: balance.message })}</span>; break
    case 'ok':
      balanceText = (
        <span className="gk-status">
          <strong>{balance.balances.map(entry => `${entry.currency === 'CNY' ? '¥' : `${entry.currency} `}${entry.total.toFixed(2)}`).join(' · ') || '—'}</strong>
          {!balance.available && <span className="gk-tag gk-bad">{t('service.balanceUnavailable')}</span>}
          {balance.available && balance.low && <span className="gk-tag gk-bad">{t('service.balanceLow', { threshold: service.lowBalanceYuan })}</span>}
          <span className="gk-hint">{t('service.balanceAt', { time: new Date(balance.at).toLocaleString() })}</span>
        </span>
      )
      break
  }
  return (
    <div className="gk-card">
      <dl className="gk-kv">
        <dt>{t('service.relay')}</dt><dd className="gk-mono">{service.relayURL}</dd>
        <dt>{t('service.fingerprint')}</dt><dd className="gk-mono">{service.fingerprint ?? t('service.plainHttp')}</dd>
        {service.relayUpdateCode !== undefined && (
          <>
            <dt>{t('service.updateCode')}</dt>
            <dd>
              <span className="gk-actions">
                <span className="gk-mono">{service.relayUpdateCode}</span>
                <button type="button" className="gk-button gk-small" onClick={() => { void copyUpdateCode() }}>{t(copiedUpdate ? 'code.copied' : 'code.copy')}</button>
              </span>
              <div className="gk-hint">{t('service.updateCodeHint')}</div>
            </dd>
          </>
        )}
        <dt>{t('service.upstream')}</dt><dd className="gk-mono">{service.upstreamBaseURL}</dd>
        <dt>{t('service.timeZone')}</dt><dd>{service.timeZone}</dd>
        <dt>{t('service.concurrency')}</dt><dd>{service.defaultMaxConcurrency}</dd>
        <dt>{t('service.version')}</dt><dd>{service.version}</dd>
        <dt>{t('service.balance')}</dt>
        <dd>
          <span className="gk-actions">{balanceText}<button type="button" className="gk-button gk-small" onClick={() => { void refresh() }}>{t('service.balanceRefresh')}</button></span>
        </dd>
      </dl>
    </div>
  )
}

function AccessCodeDialog({ t, name, code, onClose }: { t: Translate, name: string, code: string, onClose(): void }) {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
  }
  return (
    <div className="gk-overlay" role="presentation">
      <div className="gk-dialog" role="dialog" aria-modal="true" aria-label={t('code.title', { name })}>
        <h3>{t('code.title', { name })}</h3>
        <p className="gk-hint">{t('code.once')}</p>
        <div className="gk-code gk-mono" data-testid="keyhub-access-code">{code}</div>
        <div className="gk-actions">
          <button type="button" className="gk-button" onClick={() => { void copy() }}>{t(copied ? 'code.copied' : 'code.copy')}</button>
          <button type="button" className="gk-button gk-primary" onClick={onClose}>{t('code.done')}</button>
        </div>
      </div>
    </div>
  )
}
