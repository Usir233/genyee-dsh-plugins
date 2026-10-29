/** Settings section of the employee role: save the access code and show the connection to the admin relay. */
import { useCallback, useEffect, useState } from 'react'
import { yuan } from './AdminPage.tsx'
import type { ChannelCall, Translate } from './host.ts'
import type { EmployeeConnection, QuotaView } from './types.ts'

/** Props of {@link EmployeeSection}. */
export interface EmployeeSectionProps {
  readonly t: Translate
  /** Caller of the employee channel. */
  readonly call: ChannelCall
}

function quotaLine(t: Translate, key: string, quota: QuotaView): string {
  return t(key, { remaining: yuan(quota.remainingMicros), period: t(`period.${quota.period}`), allowance: yuan(quota.allowanceMicros) })
}

/**
 * The employee settings section.
 * @param props - translation and the employee channel.
 * @returns the section.
 */
export function EmployeeSection({ t, call }: EmployeeSectionProps) {
  const [connection, setConnection] = useState<EmployeeConnection | undefined>()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const run = useCallback(async (endpoint: string, payload: object = {}) => {
    setBusy(true)
    try {
      setConnection(await call<EmployeeConnection>(endpoint, payload))
      setError(undefined)
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      return false
    } finally {
      setBusy(false)
    }
  }, [call])
  useEffect(() => { void run('status') }, [run])

  const status = connection?.status
  return (
    <section className="gk-section" aria-label={t('employeeSection.title')}>
      <h2>{t('employeeSection.title')}</h2>
      <p>{t('employeeSection.description')}</p>
      {connection !== undefined && (
        <div className="gk-card gk-status" data-testid="keyhub-connection">
          <span className={`gk-tag ${connection.connected ? 'gk-ok' : 'gk-bad'}`}>
            <span className="gk-dot" />
            {t(connection.connected ? 'employeeSection.connected' : 'employeeSection.notConnected')}
          </span>
          {connection.relayURL !== undefined && <span className="gk-mono">{connection.relayURL}</span>}
          {connection.message !== undefined && <span role="alert">{connection.message}</span>}
          {status !== undefined && (
            <>
              <strong>{t('employeeSection.who', { name: status.employee, department: status.department })}</strong>
              <span>{status.models.length === 0 ? t('employeeSection.noModels') : t('employeeSection.models', { models: status.models.join(', ') })}</span>
              {status.quota.employee !== undefined && <span>{quotaLine(t, 'employeeSection.employeeQuota', status.quota.employee)}</span>}
              {status.quota.department !== undefined && <span>{quotaLine(t, 'employeeSection.departmentQuota', status.quota.department)}</span>}
              {status.quota.employee === undefined && status.quota.department === undefined && <span>{t('employeeSection.noQuota')}</span>}
            </>
          )}
        </div>
      )}
      {error !== undefined && <div className="gk-notice gk-error" role="alert">{error}</div>}
      <label className="gk-field">
        <span>{t('employeeSection.code')}</span>
        <textarea className="gk-textarea" value={code} placeholder={t('employeeSection.codePlaceholder')} spellCheck={false} autoComplete="off" onChange={(event) => { setCode(event.target.value) }} />
      </label>
      {connection?.configured === true && <p className="gk-hint">{t('employeeSection.codeStored')}</p>}
      <div className="gk-actions">
        <button type="button" className="gk-button gk-primary" disabled={busy || code.trim().length === 0} onClick={() => { void run('accessCode.save', { code }).then((ok) => { if (ok) setCode('') }) }}>{t('employeeSection.save')}</button>
        <button type="button" className="gk-button" disabled={busy} onClick={() => { void run('status') }}>{t('employeeSection.check')}</button>
        {connection?.configured === true && <button type="button" className="gk-button gk-danger" disabled={busy} onClick={() => { void run('accessCode.clear') }}>{t('employeeSection.clear')}</button>}
      </div>
    </section>
  )
}
