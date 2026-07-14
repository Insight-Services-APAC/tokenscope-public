/*
 * GET /api/v1/admin/regions/{id}/leaders — list a region's ACTIVE leaders
 * (region derivation, mig 0068). admin (region-scoped) / global-finops.
 *
 * A region leader is the manager-walk fallback target: an unplaced user's
 * manager chain is walked up to the nearest ancestor that is a leader, and
 * that leader's region homes the user. Soft-revoke mirrors cou_owner —
 * "active" is revoked_at IS NULL.
 */
import { defineEventHandler, createError } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const id = requireUuidParam(event, 'id', 'region id')

  return await withRequestRls(event, async (tx) => {
    const regionRows = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM region WHERE id = ${id}::uuid LIMIT 1
    `)
    const regionRow = [...regionRows][0]
    if (!regionRow) {
      throw createError({ statusCode: 404, statusMessage: 'Region not found' })
    }
    await requireRegionScope(event, id)

    const rows = await tx.execute<{
      id: string
      leader_oid: string
      leader_email: string
      kind: string
      display_name: string | null
    }>(sql`
      SELECT id::text AS id, leader_oid, leader_email, kind, display_name
      FROM region_leader
      WHERE region_id = ${id}::uuid AND revoked_at IS NULL
      ORDER BY added_at ASC
    `)

    return {
      leaders: [...rows].map((r) => ({
        id: r.id,
        leader_oid: r.leader_oid,
        leader_email: r.leader_email,
        kind: r.kind,
        display_name: r.display_name,
      })),
    }
  })
})
