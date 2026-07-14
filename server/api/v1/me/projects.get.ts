/*
 * GET /api/v1/me/projects — the projects the caller is a current member of.
 * Powers the quick-assign picker on the untagged-sessions surface (you can only
 * assign a session to a project you're assigned to).
 */
import { defineEventHandler } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { requireAuth } from '../../../auth/rbac'
import { getDb } from '../../../db'
import { getMyProjects } from '../../../utils/me-queries'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const db = getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>
  const projects = await getMyProjects(db, session.teammateId)
  return { projects }
})
