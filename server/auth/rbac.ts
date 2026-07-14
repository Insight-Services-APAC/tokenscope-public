/*
 * RBAC — requireRole / requireRegionScope.
 *
 * Per AGENTS.md §Conventions: app-level gate runs first, RLS is the
 * DB-side ground truth. requireRole returns 403 with the RFC-9457
 * Problem-Details body. Audit-on-denial belongs in the per-actor inbox
 * dispatcher (Epic 7) so it can route the alert.
 *
 * Async now: requireAuth/tryAuth resolve from OIDC + DB enrichment
 * (see server/utils/auth.ts). The per-event cache there means
 * multiple rbac calls in the same handler share one DB lookup.
 *
 * Naming: `requireAuth` is re-exported from utils/auth for ergonomic
 * imports — `import { requireRole, requireAuth } from '../auth/rbac'`
 * stays a one-line idiom in handlers.
 */
import { createError, type H3Event } from 'h3'
import { requireAuth as utilsRequireAuth, type Session } from '../utils/auth'
import { isRole, isPlatformAdmin, type Role } from '../../shared/auth/roles'

export const requireAuth = utilsRequireAuth

export async function requireRole(event: H3Event, ...allowed: Role[]): Promise<Session> {
  const session = await utilsRequireAuth(event)
  // platform-admin is the cross-region super-admin — satisfies every gate.
  if (isPlatformAdmin(session.role)) return session
  if (!isRole(session.role) || !allowed.includes(session.role)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      data: {
        type: 'https://tokenscope.example.com/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: `Role '${session.role}' is not permitted for this endpoint (need one of: ${allowed.join(', ')}).`,
      },
    })
  }
  return session
}

/*
 * requireRegionScope — admin-role callers are bounded to their home
 * region; global-finops / platform-admin are region-unbounded. Apply
 * before reading region-scoped resources to keep the cross-region
 * check uniform across the admin endpoints.
 *
 * Explicit allowlist with a fail-closed default (CORE-3): any role NOT
 * listed here (developer / manager / finance / a future addition) is
 * DENIED rather than silently granted unbounded region scope — this
 * helper must not depend on every caller remembering requireRole.
 */
export async function requireRegionScope(event: H3Event, regionId: string): Promise<Session> {
  const session = await utilsRequireAuth(event)
  if (isPlatformAdmin(session.role) || session.role === 'global-finops') return session
  if (session.role === 'admin') {
    if (session.regionId !== regionId) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: {
          type: 'https://tokenscope.example.com/errors/region-scope',
          title: 'Region scope mismatch',
          status: 403,
          detail: 'Region admin scope does not include this region.',
        },
      })
    }
    return session
  }
  // Default DENY: unrecognized / unlisted roles get no region scope.
  throw createError({
    statusCode: 403,
    statusMessage: 'Forbidden',
    data: {
      type: 'https://tokenscope.example.com/errors/region-scope',
      title: 'Region scope mismatch',
      status: 403,
      detail: `Role '${session.role}' has no region-scoped access.`,
    },
  })
}

export type { Session }
