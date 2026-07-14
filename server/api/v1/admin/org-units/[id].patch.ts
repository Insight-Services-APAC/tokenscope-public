/*
 * PATCH /api/v1/admin/org-units/:id — edit an org unit's descriptive
 * fields (admin org-units tab, design-notes §Screen 5).
 *
 * Scope of this endpoint: only the safe, descriptive fields —
 * display_name, unit_type, is_cost_owning_unit. It must NEVER mutate
 * parent_id, code, or path. RE-PARENTING (moving a unit + its subtree to a
 * new parent) lives in its own endpoint — POST .../org-units/:id/move —
 * which does the LTREE subtree re-path in one statement (within-region).
 * code/path renames remain out of scope (code is a stable key).
 *
 * Admin / global-finops only; a region admin is bound to the unit's own
 * region (we load the unit first, then requireRegionScope to it).
 */
import { defineEventHandler, createError, getRouterParam, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'

const Body = z
  .object({
    display_name: z.string().min(1).max(200).optional(),
    unit_type: z.string().min(1).max(40).optional(),
    is_cost_owning_unit: z.boolean().optional(),
  })
  .refine(
    (b) => b.display_name !== undefined || b.unit_type !== undefined || b.is_cost_owning_unit !== undefined,
    { message: 'At least one field must be provided' },
  )

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)

  const idParse = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!idParse.success) throw createError({ statusCode: 400, statusMessage: 'Invalid org unit id' })
  const unitId = idParse.data
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const existingRows = await tx.execute<{
      id: string
      region_id: string
      code: string
      display_name: string
      unit_type: string
      is_cost_owning_unit: boolean
    }>(sql`
      SELECT id::text AS id, region_id::text AS region_id, code, display_name, unit_type, is_cost_owning_unit
      FROM org_unit WHERE id = ${unitId}::uuid LIMIT 1
    `)
    const existing = [...existingRows][0]
    if (!existing) throw createError({ statusCode: 404, statusMessage: 'Org unit not found' })

    // Region admin is bound to the unit's region.
    await requireRegionScope(event, existing.region_id)

    // Build the dynamic SET list from only the provided fields.
    const sets: SQL[] = []
    if (body.display_name !== undefined) sets.push(sql`display_name = ${body.display_name}`)
    if (body.unit_type !== undefined) sets.push(sql`unit_type = ${body.unit_type}`)
    if (body.is_cost_owning_unit !== undefined) sets.push(sql`is_cost_owning_unit = ${body.is_cost_owning_unit}`)

    const updatedRows = await tx.execute<{
      id: string
      code: string
      display_name: string
      unit_type: string
      is_cost_owning_unit: boolean
    }>(sql`
      UPDATE org_unit
      SET ${sql.join(sets, sql`, `)}
      WHERE id = ${unitId}::uuid
      RETURNING id::text AS id, code, display_name, unit_type, is_cost_owning_unit
    `)
    const updated = [...updatedRows][0]
    if (!updated) throw createError({ statusCode: 500, statusMessage: 'org unit update returned no row' })

    await recordAuditEvent(tx, {
      eventType: 'org-unit-updated',
      actorTeammateId: caller.teammateId,
      actorSystem: 'admin-ui',
      subjectKind: 'org-unit',
      subjectId: updated.id,
      payload: {
        code: updated.code,
        region_id: existing.region_id,
        changes: {
          ...(body.display_name !== undefined
            ? { display_name: { from: existing.display_name, to: updated.display_name } }
            : {}),
          ...(body.unit_type !== undefined
            ? { unit_type: { from: existing.unit_type, to: updated.unit_type } }
            : {}),
          ...(body.is_cost_owning_unit !== undefined
            ? { is_cost_owning_unit: { from: existing.is_cost_owning_unit, to: updated.is_cost_owning_unit } }
            : {}),
        },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: updated.id,
      code: updated.code,
      display_name: updated.display_name,
      unit_type: updated.unit_type,
      is_cost_owning_unit: updated.is_cost_owning_unit,
    }
  })
})
