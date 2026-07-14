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
import { getDb } from '../../../db'
import { recordAuditEvent } from '../../../db/audit'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await tryAuth(event)
  clearPersonaOverrideCookie(event)
  if (session) {
    await recordAuditEvent(getDb(), {
      eventType: 'logout',
      actorTeammateId: session.teammateId,
      actorSystem: 'dev-login',
      subjectKind: 'teammate',
      subjectId: session.teammateId,
      payload: {},
    })
  }
  return { ok: true }
})
