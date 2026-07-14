/*
 * PATCH /api/v1/admin/users/:id/org-unit { org_unit_id } — move a
 * teammate to another cost centre WITHIN their existing region.
 *
 * Why this is distinct from the region PATCH: this is an intra-region
 * move. It changes which cost centre the teammate's spend rolls up to,
 * but NOT what they can see — their region scope and org_path-derived
 * visibility are unchanged. So, unlike PATCH .../region (which re-scopes
 * a teammate and therefore bumps revoked_at to force a re-login), this
 * endpoint must NOT bump revoked_at: the teammate's live sessions stay
 * valid.
 *
 * Admin / global-finops only. A region admin is bound to the teammate's
 * own region (load the teammate first, then requireRegionScope to it).
 * The target org_unit must be ACTIVE (retired_at IS NULL) and in the
 * teammate's region — 422 otherwise.
 */
import { defineEventHandler, createError, getRouterParam, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { assertOrgUnitInRegion } from '../../../../../db/org-units'

const Body = z.object({
  org_unit_id: z.string().uuid(),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)

  const idParse = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!idParse.success) throw createError({ statusCode: 400, statusMessage: 'Invalid teammate id' })
  const teammateId = idParse.data
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const targetRows = await tx.execute<{
      id: string
      region_id: string
      org_unit_id: string
      email: string
    }>(sql`
      SELECT id::text AS id, region_id::text AS region_id, org_unit_id::text AS org_unit_id, email
      FROM teammate WHERE id = ${teammateId}::uuid LIMIT 1
    `)
    const target = [...targetRows][0]
    if (!target) throw createError({ statusCode: 404, statusMessage: 'Teammate not found' })

    // Region admin is bound to the teammate's region.
    await requireRegionScope(event, target.region_id)

    // Target unit must be active and in the teammate's region.
    await assertOrgUnitInRegion(tx, {
      orgUnitId: body.org_unit_id,
      regionId: target.region_id,
      mustBeActive: true,
      statusMessage: 'org_unit is not an active unit in the teammate region',
      data: {
        type: 'https://tokenscope.example.com/errors/unprocessable',
        title: 'Unprocessable',
        status: 422,
        detail: 'org_unit_id must reference an active org unit in the teammate\'s region.',
      },
    })

    await recordAuditEvent(tx, {
      eventType: 'teammate-org-unit-changed',
      actorTeammateId: caller.teammateId,
      actorSystem: 'admin-ui',
      subjectKind: 'teammate',
      subjectId: target.id,
      payload: {
        targetEmail: target.email,
        region_id: target.region_id,
        previousOrgUnitId: target.org_unit_id,
        newOrgUnitId: body.org_unit_id,
        sessionsRevoked: false,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    // Intra-region move: change org_unit_id only. Do NOT touch revoked_at. Clear the
    // manager-chain placement provenance — an admin move overrides the derivation, so
    // region-reenrichment must not re-derive this teammate back to the chain's unit.
    await tx.execute(sql`
      UPDATE teammate
      SET org_unit_id = ${body.org_unit_id}::uuid,
          metadata = (coalesce(metadata, '{}'::jsonb) - 'placedVia' - 'placedOwnerOid' - 'placedAt')
      WHERE id = ${target.id}::uuid
    `)

    return { id: target.id, org_unit_id: body.org_unit_id }
  })
})
