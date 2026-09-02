/*
 * The Reporting nav entry — where the server's verdict becomes a link.
 *
 * Split out of AppHeader so it can be tested without mounting the whole chrome.
 * An external review noted the relocation of this decision to the server left
 * the CLIENT half unproven: server tests stay green if the header inverts the
 * verdict, drops the deep-link, or renders the entry unconditionally. This is
 * the half those tests can reach.
 *
 * It decides NOTHING about access. `visible` is resolved server-side
 * (server/auth/nav-visibility.ts) and this only renders it.
 */

/** The server's verdict, as it arrives on the session (`MeResponse.reporting`). */
export interface ReportingVerdict {
  visible: boolean
  scope: 'cost-centre' | null
}

export interface NavLink {
  to: string
  label: string
  disabled?: boolean
}

/**
 * The Reporting entry for a caller, or `null` when it must not render.
 *
 * FAILS CLOSED on an absent verdict — still loading, unauthenticated, or a
 * session probe whose verdict degraded. Never flash a link the caller may not
 * hold; the alternative (render, then retract) is worse than arriving late.
 *
 * `scope` deep-links a non-role owner to their P&L, which is the affordance the
 * retired Business-Unit P&L entry gave — a bare `/reporting` would open their
 * default scope instead. When it is null the shell self-lands on its own
 * `defaultScope`, so no scope may be hardcoded here.
 */
export function reportingNavEntry(verdict: ReportingVerdict | null | undefined): NavLink | null {
  if (!verdict?.visible) return null
  return {
    to: verdict.scope ? `/reporting?scope=${verdict.scope}` : '/reporting',
    label: 'Reporting',
  }
}

/**
 * Splice the Reporting entry into a role's base links: after the personal
 * views, before Admin (which stays last).
 */
export function withReportingEntry(
  base: readonly NavLink[],
  verdict: ReportingVerdict | null | undefined,
): NavLink[] {
  const entry = reportingNavEntry(verdict)
  if (!entry) return [...base]
  const adminIdx = base.findIndex((l) => l.to === '/admin')
  return adminIdx === -1
    ? [...base, entry]
    : [...base.slice(0, adminIdx), entry, ...base.slice(adminIdx)]
}
