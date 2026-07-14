/*
 * POST /api/v1/me/unaccounted/{id}/assign  { project_id?, activity? } — tag a per-day
 * "unaccounted usage" record (the provider API truth that OTel didn't capture; see
 * docs/design/provider-billing-attribution-model.md §A). Same correction primitive as a
 * session tag, but the unit is a (teammate, day, tool) reconciled record, not a
 * conversation:
 *   - project_id: uuid → attribute this day's unaccounted usage to a project budget
 *                        (membership-gated, same rule as sessions)
 *   - project_id: null → move it back to unallocated ("needs tagging")
 *   - activity: string → tag the activity axis; null = clear; omitted = preserve
 *
 * Ownership is explicit (the record's teammate_id must be the caller's). At least one
 * field must be present. Atomic: ownership read + membership gate + update + audit.
 */
import { createError, defineEventHandler, readValidatedBody, getRouterParam } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { getDb } from '../../../../../db'
import { recordAuditEvent } from '../../../../../db/audit'
import { endedProjectExpr } from '../../../../../db/project-predicates'

const Body = z
  .object({
    project_id: z.string().uuid().nullable().optional(),
    activity: z.union([z.string().trim().min(1).max(64), z.null()]).optional(),
  })
  .refine((b) => b.project_id !== undefined || b.activity !== undefined, {
    message: 'Provide project_id and/or activity (or null to clear).',
  })

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const idParsed = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!idParsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid record id' })
  const id = idParsed.data
  const body = await readValidatedBody(event, (d) => Body.parse(d))
  const db = getDb()

  return await db.transaction(async (tx) => {
    // 1. Ownership — the record must belong to THIS teammate (explicit, not RLS).
    const owned = await tx.execute<{ project_id: string | null; activity: string | null }>(sql`
      SELECT project_id::text AS project_id, activity FROM unaccounted_usage
      WHERE id = ${id}::uuid AND teammate_id = ${session.teammateId}::uuid
      FOR UPDATE
    `)
    const cur = [...owned][0]
    if (!cur) {
      throw createError({ statusCode: 404, statusMessage: 'Record not found or not yours' })
    }

    const setProject = Object.prototype.hasOwnProperty.call(body, 'project_id')
    const setActivity = Object.prototype.hasOwnProperty.call(body, 'activity')

    // 2. Membership gate — only when SETTING a non-null project (tag proposes, membership
    //    disposes; identical rule to the session assign).
    if (setProject && body.project_id != null) {
      // Don't let a dev tag usage to an ENDED budget (the session path rejects this too).
      const ended = await tx.execute(sql`
        SELECT 1 FROM project p WHERE p.id = ${body.project_id}::uuid AND ${endedProjectExpr('p')} LIMIT 1
      `)
      if (ended.length > 0) {
        throw createError({ statusCode: 409, statusMessage: 'That budget has ended; pick an active one.' })
      }
      const member = await tx.execute(sql`
        SELECT 1 FROM project_assignment
        WHERE project_id = ${body.project_id}::uuid AND teammate_id = ${session.teammateId}::uuid AND effective @> now()
        LIMIT 1
      `)
      if (member.length === 0) {
        throw createError({
          statusCode: 403,
          statusMessage: 'Forbidden',
          data: {
            type: 'https://tokenscope.example.com/errors/not-a-member',
            title: 'Not a member of this budget',
            status: 403,
            detail: 'You can only assign usage to budgets you are a member of.',
          },
        })
      }
    }

    // 3. Update only the supplied axes; stamp the tag provenance.
    const sets = [sql`tagged_at = now()`, sql`tagged_by = ${session.teammateId}::uuid`]
    if (setProject) sets.push(sql`project_id = ${body.project_id ?? null}::uuid`)
    if (setActivity) sets.push(sql`activity = ${body.activity ?? null}`)
    await tx.execute(sql`UPDATE unaccounted_usage SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid`)

    await recordAuditEvent(tx, {
      eventType: 'unaccounted-usage-tagged',
      actorTeammateId: session.teammateId,
      subjectKind: 'unaccounted-usage',
      subjectId: id,
      payload: {
        ...(setProject ? { project_id: body.project_id ?? null } : {}),
        ...(setActivity ? { activity: body.activity ?? null } : {}),
      },
    })

    return { id, tagged: true }
  })
})
