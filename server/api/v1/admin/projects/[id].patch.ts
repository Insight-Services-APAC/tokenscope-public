/*
 * PATCH /api/v1/admin/projects/:id — edit a project (admin-project-lifecycle,
 * Screen 5 admin Projects tab).
 *
 * Admin / global-finops only; a region admin is bounded to the project's own
 * region (requireRegionScope, applied after we read region_id inside the tx).
 *
 * All body fields are optional but at least one must be present (zod refine).
 * If cost_owning_unit_id is supplied it must be an ACTIVE (retired_at IS NULL)
 * org_unit in the SAME region as the project — same COU rule as
 * projects.post.ts, plus the soft-retire guard so spend can't be parked on a
 * retired cost centre. The UPDATE is built dynamically from the fields the
 * caller actually sent.
 */
import { defineEventHandler, createError, getRouterParam, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { assertOrgUnitInRegion } from '../../../../db/org-units'

const Body = z
  .object({
    display_name: z.string().min(1).max(200).optional(),
    client_facing_name: z.string().min(1).max(200).optional(),
    type: z.enum(['billable', 'pursuit', 'internal']).optional(),
    cost_owning_unit_id: z.string().uuid().optional(),
    // Finance-system WBS code. A non-empty string sets it; null or '' clears it.
    wbs_code: z
      .union([
        z.string().trim().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'invalid WBS code'),
        z.literal(''),
        z.null(),
      ])
      .optional(),
    is_authorised: z.boolean().optional(),
    // Project end (D1). An ISO timestamp sets the end (now = "retire now",
    // a future value = a planned end); null clears it (re-open / un-end).
    // Setting end_date is NOT retroactive over already-frozen attribution rows
    // — only future events spill (D2). See docs/design/project-lifecycle.md.
    end_date: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  })

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)

  const parsedId = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!parsedId.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid project id',
      data: {
        type: 'https://tokenscope.example.com/errors/invalid-input',
        title: 'Invalid project id',
        status: 400,
        detail: 'Expected a canonical UUID in the URL path.',
      },
    })
  }
  const projectId = parsedId.data

  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const existing = await tx.execute<{ id: string; region_id: string }>(sql`
      SELECT id::text AS id, region_id::text AS region_id
      FROM project WHERE id = ${projectId}::uuid LIMIT 1
    `)
    const projectRow = [...existing][0]
    if (!projectRow) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Project not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Project not found',
          status: 404,
          detail: 'No project matches the supplied id (or RLS denied access).',
        },
      })
    }

    // Region-scope check — admin caller cannot mutate a project outside
    // their home region. (global-finops is unbounded.)
    await requireRegionScope(event, projectRow.region_id)

    // If reassigning the cost-owning unit it must exist, be ACTIVE
    // (retired_at IS NULL) AND live in the project's region.
    if (body.cost_owning_unit_id !== undefined) {
      await assertOrgUnitInRegion(tx, {
        orgUnitId: body.cost_owning_unit_id,
        regionId: projectRow.region_id,
        mustBeActive: true,
        statusMessage: 'cost_owning_unit_id is not an active org unit in this region',
        data: {
          type: 'https://tokenscope.example.com/errors/unprocessable',
          title: 'Invalid cost-owning unit',
          status: 422,
          detail:
            'cost_owning_unit_id must reference an active (not retired) org unit in the project\'s region.',
        },
      })
    }

    // Build the UPDATE dynamically from the provided fields only.
    const sets: SQL[] = []
    const changed: Record<string, unknown> = {}
    if (body.display_name !== undefined) {
      sets.push(sql`display_name = ${body.display_name}`)
      changed.display_name = body.display_name
    }
    if (body.client_facing_name !== undefined) {
      sets.push(sql`client_facing_name = ${body.client_facing_name}`)
      changed.client_facing_name = body.client_facing_name
    }
    if (body.wbs_code !== undefined) {
      // '' / null both clear it; a value sets it.
      const wbs = body.wbs_code ? body.wbs_code : null
      sets.push(wbs === null ? sql`wbs_code = NULL` : sql`wbs_code = ${wbs}`)
      changed.wbs_code = wbs
    }
    if (body.type !== undefined) {
      sets.push(sql`type = ${body.type}`)
      changed.type = body.type
    }
    if (body.cost_owning_unit_id !== undefined) {
      sets.push(sql`cost_owning_unit_id = ${body.cost_owning_unit_id}::uuid`)
      changed.cost_owning_unit_id = body.cost_owning_unit_id
    }
    if (body.is_authorised !== undefined) {
      sets.push(sql`is_authorised = ${body.is_authorised}`)
      changed.is_authorised = body.is_authorised
    }
    if (body.end_date !== undefined) {
      sets.push(
        body.end_date === null ? sql`end_date = NULL` : sql`end_date = ${body.end_date}::timestamptz`,
      )
      changed.end_date = body.end_date
    }

    const updated = await tx.execute<{
      id: string
      code: string
      display_name: string
      type: string
      cost_owning_unit_id: string
      is_authorised: boolean
      end_date: string | null
    }>(sql`
      UPDATE project
      SET ${sql.join(sets, sql`, `)}
      WHERE id = ${projectId}::uuid
      RETURNING id::text AS id, code, display_name, type,
                cost_owning_unit_id::text AS cost_owning_unit_id, is_authorised,
                end_date::text AS end_date
    `)
    const updatedRow = [...updated][0]!

    await recordAuditEvent(tx, {
      eventType: 'project-updated',
      actorTeammateId: caller.teammateId,
      subjectKind: 'project',
      subjectId: projectId,
      payload: {
        region_id: projectRow.region_id,
        changed,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: updatedRow.id,
      code: updatedRow.code,
      display_name: updatedRow.display_name,
      type: updatedRow.type,
      cost_owning_unit_id: updatedRow.cost_owning_unit_id,
      is_authorised: updatedRow.is_authorised,
      end_date: updatedRow.end_date,
    }
  })
})
