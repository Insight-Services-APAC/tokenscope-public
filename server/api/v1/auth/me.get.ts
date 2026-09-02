/*
 * GET /api/v1/auth/me — current session probe.
 *
 * Always responds 200; an unauthenticated request returns
 * `{ authenticated: false }` so the client can branch without a 4xx
 * round-trip on first load. Auth happens lazily via tryAuth() —
 * OIDC decryption + DB enrichment (and optional sandbox persona
 * override) all on demand, no ts_session bridge to maintain.
 */
import { consola } from 'consola'
import { defineEventHandler } from 'h3'
import { tryAuth } from '../../../utils/auth'
import { DEMO_PERSONAS } from '../../../../shared/auth/roles'
import { withRequestRls } from '../../../db/request-rls'
import {
  reportingNavFromRoleAlone,
  resolveReportingNav,
  type ReportingNav,
} from '../../../auth/nav-visibility'

export default defineEventHandler(async (event) => {
  const session = await tryAuth(event)
  if (!session) return { authenticated: false as const }

  /*
   * The Reporting nav verdict rides the session probe the app already awaits,
   * replacing two blocking header fetches (see server/auth/nav-visibility.ts).
   * A reporting role is answered from the role alone, so the common admin path
   * opens no transaction at all — an unauthenticated probe already returned
   * above, so this never runs without a session.
   *
   * CAUGHT, because THIS ROUTE ALWAYS ANSWERS 200 (see the header). Adding DB
   * work to a probe whose whole contract is "never fails" would let a
   * transaction or query error turn the session itself into a 500 — and the
   * session is what every page waits on, so one failed ownership read would
   * take down navigation entirely. Previously these reads lived in separate
   * header requests that could fail alone.
   *
   * The fallback FAILS CLOSED: no verdict means the entry does not render. It
   * cannot grant access — the route behind it does its own authorization — so
   * the worst case is a reachable page briefly missing from the nav, which is
   * the right side to err on and is moot anyway while the database is failing.
   */
  let reporting: ReportingNav = { visible: false, scope: null }
  try {
    reporting =
      reportingNavFromRoleAlone(session.role) ??
      (await withRequestRls(event, (tx) =>
        resolveReportingNav(event, tx, session.teammateId, session.role),
      ))
  } catch (err) {
    // The Error OBJECT, not a string of it — consola renders the stack, and this
    // route degrades SILENTLY, so the log is the only evidence it happened.
    // Stringifying threw the stack away and left "Error", which cannot
    // distinguish a database outage from a bug in the resolver. Same shape as
    // classifyProbeError (server/utils/redact-probe-error.ts). Server-side only;
    // nothing here reaches the caller.
    consola.error(
      '[auth/me] reporting-nav verdict failed — degrading closed',
      err instanceof Error ? err : String(err),
    )
  }

  const persona = DEMO_PERSONAS.find((p) => p.email === session.email)
  return {
    authenticated: true,
    teammateId: session.teammateId,
    email: session.email,
    displayName: session.displayName,
    role: session.role,
    regionId: session.regionId,
    orgPath: session.orgPath,
    landing: persona?.landing ?? '/',
    reporting,
    ...(session.impersonatorEmail ? { impersonatorEmail: session.impersonatorEmail } : {}),
    ...(session.impersonatedAt ? { impersonatedAt: session.impersonatedAt } : {}),
  } as const
})
