/*
 * GET /api/v1/auth/me — current session probe.
 *
 * Always responds 200; an unauthenticated request returns
 * `{ authenticated: false }` so the client can branch without a 4xx
 * round-trip on first load. Auth happens lazily via tryAuth() —
 * OIDC decryption + DB enrichment (and optional sandbox persona
 * override) all on demand, no ts_session bridge to maintain.
 */
import { defineEventHandler } from 'h3'
import { tryAuth } from '../../../utils/auth'
import { DEMO_PERSONAS } from '../../../../shared/auth/roles'

export default defineEventHandler(async (event) => {
  const session = await tryAuth(event)
  if (!session) return { authenticated: false as const }

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
    ...(session.impersonatorEmail ? { impersonatorEmail: session.impersonatorEmail } : {}),
    ...(session.impersonatedAt ? { impersonatedAt: session.impersonatedAt } : {}),
  } as const
})
