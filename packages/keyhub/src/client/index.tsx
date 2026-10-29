/**
 * Browser half of `@genyee/dsh-keyhub`: the management page (admin role) and the access-code settings section
 * (employee role). Each appears only when the Host serves its role's command route.
 */
import { AdminPage } from './AdminPage.tsx'
import { EmployeeSection } from './EmployeeSection.tsx'
import type { ClientContext } from './host.ts'
import { channel, postCommand, RouteUnavailableError } from './host.ts'
import { en, NS, zh } from './locale.ts'
import { STYLES } from './styles.ts'

/** `ADMIN_ROUTE` of `src/admin/rpc.ts`, relative to the application root. */
const ADMIN_ROUTE = 'api/genyee-keyhub/admin'
/** `EMPLOYEE_ROUTE` of `src/employee/rpc.ts`, relative to the application root. */
const EMPLOYEE_ROUTE = 'api/genyee-keyhub/employee'
const PANEL_ID = 'genyee-keyhub'
/** Probe attempts while the Host is unreachable, and the pause between them. */
const PROBE_ATTEMPTS = 5
const PROBE_PAUSE_MS = 2000

export const inject = ['slots', 'locale']

/** Sidebar glyph: a key. */
function KeyIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="15" r="4" />
      <path d="M10.85 12.15 19 4M15.5 7.5 18 10M17.5 5.5 20 8" />
    </svg>
  )
}

/**
 * Whether the Host serves a route: a command result of any kind means yes, a non-command answer means no.
 * @returns `true` when the route answered.
 */
async function serves(path: string, endpoint: string): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await postCommand(path, endpoint, {})
      return true
    } catch (error) {
      if (error instanceof RouteUnavailableError) return false
      // A network failure: the Host may be restarting; retry a few times before giving up.
      if (attempt >= PROBE_ATTEMPTS) return false
      await new Promise(resolve => setTimeout(resolve, PROBE_PAUSE_MS))
    }
  }
}

/**
 * Register the page and the section for the roles this Host runs.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'keyhub: locale')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = '@genyee/dsh-keyhub'
    style.textContent = STYLES
    document.head.append(style)
    return () => { style.remove() }
  }, 'keyhub: styles')
  const t = ctx.locale.bind(NS)
  const callAdmin = channel(ADMIN_ROUTE)
  const callEmployee = channel(EMPLOYEE_ROUTE)

  ctx.effect(() => {
    let active = true
    void serves(ADMIN_ROUTE, 'state').then((admin) => {
      if (!active || !admin) return
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ call: callAdmin }) }, AdminPage as never))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, locale: NS, label: () => t('panel') }, KeyIcon as never))
    })
    void serves(EMPLOYEE_ROUTE, 'status').then((employee) => {
      if (!active || !employee) return
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: PANEL_ID, order: 30, locale: NS, label: () => t('employeeSection.title'), inject: () => ({ call: callEmployee }) }, EmployeeSection as never))
    })
    return () => { active = false }
  }, 'keyhub: role probe')
}
