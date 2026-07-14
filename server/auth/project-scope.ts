/*
 * project-scope — app-level authorization for project-targeted writes
 * (member assignment, allocation create, per-dev split).
 *
 * Mirrors the allocation read predicate (server/auth/allocation-scope.ts)
 * but for handlers that resolve a project up front and then mutate it:
 *   - admin          → bound to the project's region (requireRegionScope)
 *   - manager        → the project's cost-owning unit must be within the
 *                      caller's org subtree (cou.path <@ session.orgPath)
 *   - global-finops  → unbounded
 *
 * This is the live gate; RLS is inert at runtime (owner DB connection)
 * until Epic 10's non-owner role lands. See allocation-scope.ts.
 */
import { createError, type H3Event } from 'h3'
import { requireAuth, requireRegionScope } from './rbac'
import { isPlatformAdmin } from '../../shared/auth/roles'

export interface ProjectScope {
  regionId: string
  /** ltree path of the project's cost-owning unit. */
  couPath: string
}

/** True if `path` is a descendant of (or equal to) `ancestor` in ltree terms. */
function isWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor + '.')
}

export async function assertProjectScope(event: H3Event, project: ProjectScope): Promise<void> {
  const session = await requireAuth(event)
  if (session.role === 'admin') {
    // Region admin: bound to the project's region.
    await requireRegionScope(event, project.regionId)
    return
  }
  if (session.role === 'manager') {
    if (!isWithin(project.couPath, session.orgPath)) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: {
          type: 'https://tokenscope.example.com/errors/project-scope',
          title: 'Project outside org scope',
          status: 403,
          detail: "This project's cost-owning unit is not within your org subtree.",
        },
      })
    }
    return
  }
  // global-finops / platform-admin are org-wide by design.
  if (session.role === 'global-finops' || isPlatformAdmin(session.role)) {
    return
  }
  // Default DENY (CORE-3): any role not explicitly listed above gets no
  // project-write scope — never rely on upstream requireRole alone.
  throw createError({
    statusCode: 403,
    statusMessage: 'Forbidden',
    data: {
      type: 'https://tokenscope.example.com/errors/project-scope',
      title: 'Forbidden',
      status: 403,
      detail: `Role '${session.role}' is not permitted to act on this project.`,
    },
  })
}
