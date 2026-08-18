/*
 * POST /api/v1/auth/logout — clears the override sidecar cookie.
 *
 * The OIDC session itself is cleared by nuxt-oidc-auth's own logout
 * endpoint (/auth/<provider>/logout); the UI navigates there after
 * calling this. This handler is responsible only for tearing down the
 * sandbox persona-override sidecar so the next sign-in starts clean.
 *
 * Always responds 200, even when no override was active.
 */
import { defineEventHandler } from 'h3'
import { assertSameOrigin } from '../../../auth/csrf'
import { tryAuth } from '../../../utils/auth'
import { clearPersonaOverrideCookie } from '../../../utils/persona-override-cookie'
import { withRequestRls } from '../../../db/request-rls'
import { recordAuditEvent } from '../../../db/audit'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await tryAuth(event)
  clearPersonaOverrideCookie(event)
  if (session) {
    // Inside the `if (session)` the caller IS authenticated, so withRequestRls's
    // internal requireAuth resolves the same session tryAuth just cached on the
    // event — no second lookup, and the audit INSERT carries an RLS identity.
    await withRequestRls(event, (tx) =>
      recordAuditEvent(tx, {
        eventType: 'logout',
        actorTeammateId: session.teammateId,
        actorSystem: 'dev-login',
        subjectKind: 'teammate',
        subjectId: session.teammateId,
        payload: {},
      }),
    )
  }
  return { ok: true }
})
