/*
 * POST /api/v1/auth/stop-impersonating — clear the persona-override
 * sidecar cookie so the next request returns to the real OIDC
 * identity.
 *
 * Wave-V counterpart to dev-login.post.ts's override path. Conditions:
 *   - tryAuth must return a session
 *   - session.impersonatorOid must be set (the override stamp; without
 *     it there's no override to clear)
 *
 * Behaviour change vs the legacy ts_session model: we no longer mint a
 * "real admin" session here — we just clear the override sidecar, and
 * tryAuth on the next request falls back to the OIDC identity (which
 * IS the real admin). Single source of truth, one cookie to drop.
 */
import { createError, defineEventHandler } from 'h3'
import { assertSameOrigin } from '../../../auth/csrf'
import { tryAuth } from '../../../utils/auth'
import { clearPersonaOverrideCookie } from '../../../utils/persona-override-cookie'
import { withRequestRls } from '../../../db/request-rls'
import { recordAuditEvent } from '../../../db/audit'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await tryAuth(event)
  if (!session) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthenticated',
      data: {
        type: 'https://tokenscope.example.com/errors/unauthenticated',
        title: 'Unauthenticated',
        status: 401,
        detail: 'Sign in before calling stop-impersonating.',
      },
    })
  }

  if (!session.impersonatorOid || !session.impersonatorEmail) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Not in override mode',
      data: {
        type: 'https://tokenscope.example.com/errors/not-impersonating',
        title: 'Not in override mode',
        status: 400,
        detail: 'The current session is not in persona-override mode; nothing to restore.',
      },
    })
  }

  // Audit BEFORE clearing — fail-closed on audit-insert failure, the
  // override stays intact for retry. The session here is the IMPERSONATED
  // persona (the override is still live), which is exactly the identity the
  // audit row names as actor, so withRequestRls's context matches the row.
  await withRequestRls(event, (tx) =>
    recordAuditEvent(tx, {
      eventType: 'persona-impersonation-end',
      actorTeammateId: session.teammateId,
      actorSystem: 'stop-impersonating',
      subjectKind: 'teammate',
      subjectId: session.teammateId,
      payload: {
        actualOid: session.impersonatorOid,
        actualEmail: session.impersonatorEmail,
        restoredFromTeammateId: session.teammateId,
        impersonatedAt: session.impersonatedAt ?? null,
      },
    }),
  )

  clearPersonaOverrideCookie(event)

  return { ok: true, landing: '/admin' }
})
