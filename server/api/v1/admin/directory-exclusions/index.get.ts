/*
 * GET /api/v1/admin/directory-exclusions — list the directory-exclusion
 * patterns (mig 0083). Admin config: accounts whose UPN matches a pattern are
 * hidden from people-pickers and refused on assign (privileged/service
 * accounts). Readable by any admin-family role; org-wide edit lives in the
 * POST/DELETE siblings.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<{
      id: string
      pattern: string
      note: string | null
      created_at: string
    }>(sql`
      SELECT id::text AS id, pattern, note, created_at::text AS created_at
        FROM directory_exclusion_pattern
       ORDER BY lower(pattern)
    `)
    return { patterns: [...rows] }
  })
})
