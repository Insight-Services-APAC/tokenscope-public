/*
 * GET /api/v1/me/projects — the projects the caller is a current member of.
 * Powers the quick-assign picker on the untagged-sessions surface (you can only
 * assign a session to a project you're assigned to).
 */
import { defineEventHandler } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { getMyProjects } from '../../../utils/me-queries'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const projects = await withRequestRls(event, (tx) =>
    getMyProjects(tx as unknown as PostgresJsDatabase<Record<string, unknown>>, session.teammateId),
  )
  return { projects }
})
