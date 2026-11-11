/*
 * What each GitHub coverage state means, in the reader's words (#587).
 *
 * ONE SOURCE for the alert's title (server/reconciliation/coverage-alerts.ts)
 * and its drawer body (app/components/inbox/drawer-copy.ts), so the two can no
 * longer disagree: the body once said "no longer connected" under a title that
 * said "installed". Plain words only; "cost-owning unit" is internal for a
 * Business Unit.
 */
export const COVERAGE_STATE_WORDS: Readonly<Record<string, string>> = {
  mislinked: 'linked to a different enterprise in TokenScope',
  'coverage-unknown': "not classifiable: TokenScope lost permission to read it, or another app is installed",
  stale: 'no longer a member of this enterprise on GitHub, but still set up in TokenScope',
  'not-installed': 'a member of this enterprise without the TokenScope reconciliation app installed',
  suspended: 'installed, but its app installation is suspended',
  'not-onboarded': 'installed, but has no Business Unit to bill to',
  connected: 'connected',
}

export function coverageStateWords(state: string | null | undefined): string {
  return (state && COVERAGE_STATE_WORDS[state]) || 'not fully connected'
}

/**
 * The title of an organisation's coverage alert. The server writes it, and the
 * inbox rebuilds it from the alert's own facts when it shows one, so an alert
 * stored before a wording change reads the current words (#591).
 */
export function coverageOrgGapSubject(org: string, enterpriseExternalId: string, state: string | null | undefined): string {
  return `GitHub org '${org}' (${enterpriseExternalId}) is ${coverageStateWords(state)}`
}
