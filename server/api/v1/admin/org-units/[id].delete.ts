/*
 * DELETE /api/v1/admin/org-units/:id — RETIRE (soft-delete) an org unit
 * (admin org-units tab, design-notes §Screen 5).
 *
 * Why soft, not hard: an org unit accrues history through the projects
 * and teammates that reference it, and through audit rows that name it as
 * a subject. Hard-deleting would orphan that history (and break the
 * FK references). So this sets retired_at = now() and leaves the row in
 * place; mig 0022 added the column for exactly this. A retired unit drops
 * out of pickers but its past attribution stays attributable.
 *
 * Refuse (409) when retiring would strand live structure or references:
 *   - it still has ACTIVE child units (any descendant with retired_at NULL),
 *   - it is referenced by any ACTIVE (non-retired) project (cost_owning_unit_id);
 *     a retired project must not pin its cost centre alive forever (R1 M3),
 *   - it is the home of any ACTIVE teammate (org_unit_id, is_active = true).
 * The 409 detail carries the counts so the admin knows what to clear first.
 *
 * Admin / global-finops only; a region admin is bound to the unit's own
 * region (load first, then requireRegionScope).
 */
import { defineEventHandler, createError, getRouterParam, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { activeProjectPredicate } from '../../../../db/project-predicates'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)

  const idParse = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!idParse.success) throw createError({ statusCode: 400, statusMessage: 'Invalid org unit id' })
  const unitId = idParse.data
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const existingRows = await tx.execute<{
      id: string
      region_id: string
      code: string
      path: string
      retired_at: string | null
    }>(sql`
      SELECT id::text AS id, region_id::text AS region_id, code, path::text AS path, retired_at
      FROM org_unit WHERE id = ${unitId}::uuid LIMIT 1
    `)
    const existing = [...existingRows][0]
    if (!existing) throw createError({ statusCode: 404, statusMessage: 'Org unit not found' })

    await requireRegionScope(event, existing.region_id)

    if (existing.retired_at) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Org unit is already retired',
        data: {
          type: 'https://tokenscope.example.com/errors/conflict',
          title: 'Conflict',
          status: 409,
          detail: `Org unit '${existing.code}' is already retired.`,
        },
      })
    }

    // Count what still depends on this unit. Active descendants are anything
    // under this path (path <@ thisPath) excluding the unit itself, with
    // retired_at NULL.
    const blockerRows = await tx.execute<{
      active_children: string
      project_refs: string
      active_teammates: string
    }>(sql`
      SELECT
        (SELECT COUNT(*) FROM org_unit
           WHERE path <@ ${existing.path}::ltree AND path <> ${existing.path}::ltree AND retired_at IS NULL)::text
          AS active_children,
        (SELECT COUNT(*) FROM project WHERE cost_owning_unit_id = ${unitId}::uuid
           AND ${activeProjectPredicate('project')})::text
          AS project_refs,
        (SELECT COUNT(*) FROM teammate WHERE org_unit_id = ${unitId}::uuid AND is_active = TRUE)::text
          AS active_teammates
    `)
    const blockers = [...blockerRows][0]!
    const activeChildren = Number(blockers.active_children)
    const projectRefs = Number(blockers.project_refs)
    const activeTeammates = Number(blockers.active_teammates)

    if (activeChildren > 0 || projectRefs > 0 || activeTeammates > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Org unit still has dependents',
        data: {
          type: 'https://tokenscope.example.com/errors/conflict',
          title: 'Conflict',
          status: 409,
          detail:
            `Cannot retire org unit '${existing.code}': it still has ` +
            `${activeChildren} active child unit(s), ${projectRefs} project(s), and ` +
            `${activeTeammates} active teammate(s). Reassign or retire these first.`,
        },
      })
    }

    await tx.execute(sql`
      UPDATE org_unit SET retired_at = NOW() WHERE id = ${unitId}::uuid
    `)
    const retiredRows = await tx.execute<{ retired_at: string }>(sql`
      SELECT retired_at::text AS retired_at FROM org_unit WHERE id = ${unitId}::uuid LIMIT 1
    `)
    const retiredAt = [...retiredRows][0]!.retired_at

    await recordAuditEvent(tx, {
      eventType: 'org-unit-retired',
      actorTeammateId: caller.teammateId,
      actorSystem: 'admin-ui',
      subjectKind: 'org-unit',
      subjectId: existing.id,
      payload: {
        code: existing.code,
        path: existing.path,
        region_id: existing.region_id,
        retired_at: retiredAt,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id: existing.id, retired_at: retiredAt }
  })
})
