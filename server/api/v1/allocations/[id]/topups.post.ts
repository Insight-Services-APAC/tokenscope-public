/*
 * POST /api/v1/allocations/{id}/topups — append a top-up row.
 *
 * Per design-notes §Screen 4 + mvp-final-epic.md §Epic 12:
 *   - Append-only (never overwrites the focused baseline row)
 *   - Inserts a new allocation row with allocation_kind='top-up',
 *     same scope_type+scope_id as the focused row, with the supplied
 *     budget and effective range
 *   - Writes an audit_event recording the actor + reason
 *   - CSRF guarded
 */
import {
  defineEventHandler,
  createError,
  readValidatedBody,
  getRequestIP,
  getHeader,
} from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../../auth/rbac'
import { allocationScopePredicate } from '../../../../auth/allocation-scope'
import { isPlatformAdmin } from '../../../../../shared/auth/roles'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { requireUuidParam } from '../../../../utils/require-uuid-param'
import { BudgetUsdSchema, EffectiveRangeSchema } from '../../../../utils/allocation-validation'
import { translatePgConstraintError } from '../../../../utils/pg-constraint-error'
import { allocation } from '../../../../../drizzle/schema'
import { recordAuditEvent } from '../../../../db/audit'

const PostBody = z.object({
  budget_usd: BudgetUsdSchema,
  effective: EffectiveRangeSchema,
  reason: z.string().min(1).max(500).optional(),
})

interface BaseRow {
  scope_type: string
  scope_id: string
  teammate_id: string | null
}

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  // J2: budget authority is role OR relationship. Org roles keep the
  // existing scope-predicate path; everyone else must be a
  // currently-effective PM of the allocation's project (checked against
  // the base row below, AFTER it resolves — the project id lives there).
  const hasOrgRole =
    isPlatformAdmin(session.role) ||
    session.role === 'manager' ||
    session.role === 'admin' ||
    session.role === 'global-finops'

  const id = requireUuidParam(event, 'id', 'allocation id')

  const body = await readValidatedBody(event, (data) => PostBody.parse(data))
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // Look up the focused row to inherit its scope. Two gates, a true OR
    // (R1 F4): org roles try the scope predicate first; the PM
    // relationship is then tried for EVERYONE on a miss — so a
    // manager-role PM of a project outside their org subtree isn't
    // locked out of a project a developer-role PM could top up. The PM
    // arm is one combined query (relationship proven inside it), so a
    // non-role caller costs exactly one round-trip whether the id
    // exists or not — no timing oracle on the allocation id space.
    // Per-dev-cap rows (teammate_id NOT NULL) are excluded from the PM
    // arm and 400-ed on the org arm (R1 F15): a top-up minted from a
    // per-dev focus would silently widen to the whole project pool.
    const pmArm = () =>
      tx.execute<BaseRow & Record<string, unknown>>(sql`
        SELECT a.scope_type, a.scope_id::text AS scope_id, a.teammate_id::text AS teammate_id
        FROM allocation a
        WHERE a.id = ${id}::uuid
          AND a.scope_type = 'project'
          AND a.teammate_id IS NULL
          AND EXISTS (
            SELECT 1 FROM project_assignment pa
            WHERE pa.project_id = a.scope_id
              AND pa.teammate_id = ${session.teammateId}::uuid
              AND pa.role = 'manager'
              AND pa.effective @> now()
          )
        LIMIT 1
      `)

    let base: (BaseRow & Record<string, unknown>) | undefined
    let via: 'role' | 'project-manager' = 'project-manager'
    if (hasOrgRole) {
      const scoped = await tx.execute<BaseRow & Record<string, unknown>>(sql`
        SELECT scope_type, scope_id::text AS scope_id, teammate_id::text AS teammate_id
        FROM allocation
        WHERE id = ${id}::uuid
          AND ${allocationScopePredicate('allocation')}
        LIMIT 1
      `)
      base = [...scoped][0]
      if (base) via = 'role'
      else base = [...(await pmArm())][0]
    } else {
      base = [...(await pmArm())][0]
    }
    if (!base) {
      // Out-of-scope or non-existent — same 404, and we never reach the
      // INSERT below, so a manager cannot top up another org's allocation.
      throw createError({ statusCode: 404, statusMessage: 'Focused allocation not found' })
    }
    if (base.scope_type !== 'project') {
      throw createError({
        statusCode: 400,
        statusMessage: 'Top-ups are only supported for project-scope allocations',
      })
    }
    if (base.teammate_id !== null) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Top-ups apply to the project pool — focus the baseline, not a per-developer cap',
      })
    }

    // 1) audit_event first (FK target for the new allocation row).
    const evt = await recordAuditEvent(tx, {
      eventType: 'allocation-topup-added',
      actorTeammateId: session.teammateId,
      subjectKind: 'allocation',
      subjectId: id,
      payload: {
        after: {
          budget_usd: body.budget_usd,
          effective: body.effective,
          allocation_kind: 'top-up',
        },
        context: {
          focused_allocation_id: id,
          scope_type: base.scope_type,
          scope_id: base.scope_id,
          reason: body.reason ?? null,
          // J2: which gate admitted the actor — org role vs PM relationship.
          via,
        },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    // 2) Append the top-up allocation row. Top-ups STACK (mig 0052): the
    //    allocation no-overlap EXCLUDE applies to baselines only, and
    //    fetchProjectAllocation sums every baseline + top-up covering now(),
    //    so multiple top-ups for the same period simply add up — adding more
    //    budget to a month that already has a top-up is the normal flow.
    //    The try/catch is now defensive: a top-up can no longer trip 23P01
    //    by design, but an unexpected constraint race still surfaces as a
    //    clean 409 rather than a raw 500.
    let topup: { id: string } | undefined
    try {
      ;[topup] = await tx
        .insert(allocation)
        .values({
          scopeType: base.scope_type,
          scopeId: base.scope_id,
          budgetUsd: body.budget_usd,
          effective: body.effective,
          allocationKind: 'top-up',
          createdBy: session.teammateId,
          auditEventId: evt.id,
          source: 'manual',
          isPinned: true,
        })
        .returning({ id: allocation.id })
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23P01': {
          title: 'Could not append the top-up',
          detail:
            'A concurrent write conflicted with this top-up. Reload the allocation and try again.',
        },
      })
    }

    return {
      id: topup!.id,
      audit_event_id: evt.id,
      appended_at: new Date().toISOString(),
    }
  })
})
