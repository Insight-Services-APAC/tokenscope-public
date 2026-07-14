/*
 * tagSessionTx — the shared "tag / re-tag a Claude conversation" primitive,
 * extracted from POST /api/v1/me/sessions/{sid}/assign so BOTH the web Re-tag
 * dialog and the agentic MCP `tag_session` tool drive the SAME logic:
 *
 *   - project_id: uuid  → assign / re-point to a BUDGET (a project of any type —
 *                         billable / pursuit / internal; membership-gated)
 *   - project_id: null  → move OFF budget (unallocated)
 *   - activity:   string→ tag an activity (the orthogonal categorisation axis)
 *   - activity:   null  → clear the activity
 *
 * This is TAGGING (categorising spend), never BUDGET ALLOCATION (admin-only).
 *
 * MUST run inside a transaction — the ownership read, the ended-target FOR UPDATE,
 * the boundary-preserving ledger UPDATE, the session_assignment write, and the
 * audit are one atomic unit. Ownership is AR-based (explicit teammate_id filters,
 * not RLS), so it is identical whether called from the cookie path or the bearer
 * path. Throws createError (403/404/409) on ownership / ended-target / membership.
 */
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { recordAuditEvent } from '../db/audit'
import { endedProjectExpr } from '../db/project-predicates'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export interface TagAxes {
  /** Whether the project axis is being SET (true) or preserved (false). */
  setProject: boolean
  /** The target project id when setProject (null = move off budget). */
  projectVal: string | null
  /** Whether the activity axis is being SET (true) or preserved (false). */
  setActivity: boolean
  /** The activity label when setActivity (null = clear). */
  activityVal: string | null
}

export interface TagResult {
  assigned: true
  session_id: string
  project_id: string | null
  project_code: string | null
  activity: string | null
  attribution: 'updated'
}

export async function tagSessionTx(
  tx: Tx,
  teammateId: string,
  conversationId: string,
  axes: TagAxes,
  opts: { actorSystem: string },
): Promise<TagResult> {
  const { setProject, projectVal, setActivity, activityVal } = axes

  // Serialize concurrent tags of the SAME conversation by the SAME teammate. There
  // are now TWO writers — the web Re-tag dialog AND the agentic MCP tag_session
  // tool — which can fire together. Without this, both capture the same stale
  // current-state snapshot below and the session_assignment ON CONFLICT upsert can
  // stamp a stale PRESERVED axis (e.g. A sets project while B clears activity → B's
  // upsert reverts A's project). An advisory xact lock orders them; released at
  // commit/rollback. A hashtext collision only ever over-serializes (harmless).
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${conversationId} || '|' || ${teammateId}::text))`)

  // Ownership: the conversation must have attribution_record rows for ME (the
  // joiner writes them from the unspoofable attestation, incl. itemised
  // unallocated rows).
  const [owned] = await tx.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n
    FROM attribution_record
    WHERE claude_session_id = ${conversationId} AND teammate_id = ${teammateId}::uuid
  `)
  if (!owned || Number(owned.n) === 0) {
    throw createError({ statusCode: 403, statusMessage: 'Session does not belong to you, or is not recorded yet' })
  }

  // Current state for the PRESERVED axes (CORE-1). The session_assignment row is
  // the DECISION RECORD — after a boundary-preserving re-tag (D2a) the ledger
  // legitimately holds rows split between an ENDED project X and successor Y, so
  // the old MAX(project_id::text) snapshot picked an arbitrary (textually
  // largest) project and could silently revert the session to the ended one on
  // an activity-only tag. No assignment row yet → fall back to the ledger, but
  // only over rows NOT frozen to an ended project (the same rows a re-tag moves).
  const [assignment] = await tx.execute<{ project_id: string | null; activity: string | null }>(sql`
    SELECT project_id::text AS project_id, activity
    FROM session_assignment
    WHERE claude_session_id = ${conversationId} AND teammate_id = ${teammateId}::uuid
    LIMIT 1
  `)
  let currentProject: string | null
  let currentActivity: string | null
  if (assignment) {
    currentProject = assignment.project_id ?? null
    currentActivity = assignment.activity ?? null
  } else {
    const [ledger] = await tx.execute<{ project_id: string | null; activity: string | null }>(sql`
      SELECT MAX(ar.project_id::text) AS project_id, MAX(ar.activity) AS activity
      FROM attribution_record ar
      WHERE ar.claude_session_id = ${conversationId} AND ar.teammate_id = ${teammateId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM project px
           WHERE px.id = ar.project_id AND ${endedProjectExpr('px')}
        )
    `)
    currentProject = ledger?.project_id ?? null
    currentActivity = ledger?.activity ?? null
  }

  // Budget gate + lookup — only when SETTING a non-null project.
  let cou: string | null = null
  let projCode: string | null = null
  if (setProject && projectVal !== null) {
    // FOR UPDATE: lock the target so a concurrent end_date PATCH can't slip the
    // project into "ended" between this check and the UPDATE below.
    const [p] = await tx.execute<{ code: string; cost_owning_unit_id: string; end_date: string | null }>(sql`
      SELECT code, cost_owning_unit_id::text AS cost_owning_unit_id, end_date::text AS end_date
      FROM project WHERE id = ${projectVal}::uuid LIMIT 1
      FOR UPDATE
    `)
    if (!p) throw createError({ statusCode: 404, statusMessage: 'Budget not found' })
    if (p.end_date !== null && new Date(p.end_date).getTime() <= Date.now()) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Budget has ended',
        data: {
          type: 'https://tokenscope.example.com/errors/conflict',
          title: 'Budget has ended',
          status: 409,
          detail: `Budget '${p.code}' has ended and can't receive new tags. Re-tag to its successor instead.`,
        },
      })
    }
    projCode = p.code
    cou = p.cost_owning_unit_id
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
          detail: 'You can only assign sessions to budgets you are a member of.',
        },
      })
    }
  }

  // Apply to the ledger. BOUNDARY PRESERVATION (D2a): do NOT move rows already
  // frozen to an ENDED project — those are X's legitimate pre-end earnings; a
  // re-tag to successor Y moves only the unallocated/active-project rows.
  // ts_recorded = now() on every ledger mutation: "when this row was
  // (re)written". The aggregate-rollup worker keys its recompute set on
  // ts_recorded, so bumping it here is what re-keys a re-tagged
  // conversation's days into attribution_aggregate — covering EVERY tag
  // path (project move, activity-only, full clear) with one signal.
  if (setProject) {
    await tx.execute(sql`
      UPDATE attribution_record ar
         SET project_id = ${projectVal}::uuid, cost_owning_unit_id = ${cou}::uuid,
             ts_recorded = now()
       WHERE ar.claude_session_id = ${conversationId} AND ar.teammate_id = ${teammateId}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM project px
            WHERE px.id = ar.project_id AND ${endedProjectExpr('px')}
         )
    `)
  }
  if (setActivity) {
    await tx.execute(sql`
      UPDATE attribution_record SET activity = ${activityVal}, ts_recorded = now()
       WHERE claude_session_id = ${conversationId} AND teammate_id = ${teammateId}::uuid
    `)
  }

  // Record the decision in session_assignment, preserving the untouched axis from
  // the LEDGER's current state. If BOTH axes end up null, delete the row rather
  // than violate the project-or-activity CHECK.
  const finalProject = setProject ? projectVal : currentProject
  const finalActivity = setActivity ? activityVal : currentActivity
  if (finalProject === null && finalActivity === null) {
    await tx.execute(sql`
      DELETE FROM session_assignment
      WHERE claude_session_id = ${conversationId} AND teammate_id = ${teammateId}::uuid
    `)
  } else {
    await tx.execute(sql`
      INSERT INTO session_assignment (claude_session_id, teammate_id, project_id, activity, source)
      VALUES (${conversationId}, ${teammateId}::uuid, ${finalProject}::uuid, ${finalActivity}, 'manual')
      ON CONFLICT (claude_session_id, teammate_id) DO UPDATE SET
        project_id = ${finalProject}::uuid, activity = ${finalActivity}, source = 'manual', created_at = now()
    `)
  }

  // audit_event.subject_id is UUID, but a Claude session.id is TEXT (a UUID in
  // practice, but not enforced anywhere in the ingest chain). Guard the cast so a
  // non-UUID conversation id can NEVER abort the whole tag transaction with a
  // 22P02 — the MCP tool lets an agent drive arbitrary session_id strings. The id
  // is preserved in the payload regardless of shape.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)
  await recordAuditEvent(tx, {
    eventType: 'session-tagged',
    actorTeammateId: teammateId,
    actorSystem: opts.actorSystem,
    subjectKind: 'session',
    subjectId: isUuid ? conversationId : null,
    payload: { claude_session_id: conversationId, project_id: finalProject, project_code: projCode, activity: finalActivity },
  })

  return {
    assigned: true,
    session_id: conversationId,
    project_id: finalProject,
    project_code: projCode,
    activity: finalActivity,
    attribution: 'updated',
  }
}
