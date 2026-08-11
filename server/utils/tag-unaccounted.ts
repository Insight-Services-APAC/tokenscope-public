/*
 * tagUnaccountedTx — the shared "tag a per-day unaccounted-usage record"
 * primitive, the §A sibling of tagSessionTx. Extracted from
 * POST /api/v1/me/unaccounted/{id}/assign so that endpoint and the bulk
 * worklist action drive the SAME logic (ownership → ended-budget → membership →
 * update → audit).
 *
 * The unit here is a reconciled (teammate, day, tool) record — provider API
 * truth OTel never captured — not a conversation. Everything else matches the
 * session contract: uuid = attribute to a budget, null = back to unallocated,
 * activity string = label, activity null = clear, omitted axis = preserve.
 * See docs/design/provider-billing-attribution-model.md §A.
 *
 * MUST run inside a transaction: the FOR UPDATE ownership read, the gates, the
 * update and the audit are one atomic unit. Throws createError (403/404/409).
 */
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { recordAuditEvent } from '../db/audit'
import { endedProjectExpr } from '../db/project-predicates'
import type { TagAxes } from './tag-session'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export interface TagUnaccountedResult {
  id: string
  tagged: true
}

export async function tagUnaccountedTx(
  tx: Tx,
  teammateId: string,
  recordId: string,
  axes: TagAxes,
  opts: { actorSystem?: string } = {},
): Promise<TagUnaccountedResult> {
  const { setProject, projectVal, setActivity, activityVal } = axes

  // 1. Ownership — the record must belong to THIS teammate (explicit, not RLS).
  const owned = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM unaccounted_usage
    WHERE id = ${recordId}::uuid AND teammate_id = ${teammateId}::uuid
    FOR UPDATE
  `)
  if ([...owned].length === 0) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found or not yours' })
  }

  // 2. Membership gate — only when SETTING a non-null project (tag proposes,
  //    membership disposes; identical rule to the session assign).
  if (setProject && projectVal !== null) {
    // MEMBERSHIP FIRST (mirrors tag-session.ts's server-api-app:idor:0005
    // fix — same defect here, weaker payload: no code was ever disclosed, but
    // a non-member could still learn a specific project id's ended/live state
    // before proving membership). project_assignment.project_id is a FK onto
    // project, so "a live assignment exists" ⇒ "the project exists" — this
    // one check also stands in for a not-found check.
    const member = await tx.execute(sql`
      SELECT 1 FROM project_assignment
      WHERE project_id = ${projectVal}::uuid AND teammate_id = ${teammateId}::uuid AND effective @> now()
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

    // Don't let a dev tag usage to an ENDED budget (the session path rejects
    // this too). FOR UPDATE for the same reason tagSessionTx takes it: without
    // the lock a concurrent end_date PATCH can slip the project into "ended"
    // between this check and the write below, and the day lane would accept a
    // tag the session lane rejects for the identical action. Only reached for
    // a CONFIRMED member now (membership checked above).
    const [target] = await tx.execute<{ ended: boolean }>(sql`
      SELECT ${endedProjectExpr('p')} AS ended
        FROM project p WHERE p.id = ${projectVal}::uuid
       FOR UPDATE
    `)
    if (target?.ended) {
      throw createError({ statusCode: 409, statusMessage: 'That budget has ended; pick an active one.' })
    }
  }

  // 3. Update only the supplied axes; stamp the tag provenance. A tag is a
  //    DECISION, so it supersedes a prior dismissal (mig 0094) — the record
  //    leaves the "dismissed" bucket the moment it is attributed or labelled.
  const sets = [
    sql`tagged_at = now()`,
    sql`tagged_by = ${teammateId}::uuid`,
    // Both dismissal columns clear together: a snapshot outliving its dismissal
    // is dead data a future reader could misread as "what this was waved through at".
    sql`dismissed_at = NULL`,
    sql`dismissed_cost_usd = NULL`,
  ]
  if (setProject) sets.push(sql`project_id = ${projectVal}::uuid`)
  if (setActivity) sets.push(sql`activity = ${activityVal}`)
  await tx.execute(sql`UPDATE unaccounted_usage SET ${sql.join(sets, sql`, `)} WHERE id = ${recordId}::uuid`)

  await recordAuditEvent(tx, {
    eventType: 'unaccounted-usage-tagged',
    actorTeammateId: teammateId,
    ...(opts.actorSystem ? { actorSystem: opts.actorSystem } : {}),
    subjectKind: 'unaccounted-usage',
    subjectId: recordId,
    payload: {
      ...(setProject ? { project_id: projectVal } : {}),
      ...(setActivity ? { activity: activityVal } : {}),
    },
  })

  return { id: recordId, tagged: true }
}
