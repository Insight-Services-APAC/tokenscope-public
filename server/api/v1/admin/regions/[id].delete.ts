/*
 * DELETE /api/v1/admin/regions/:id — hard-delete a region
 * (admin-region-lifecycle).
 *
 * platform-admin ONLY. A hard DELETE is only permitted when the region is
 * EMPTY — no org_unit, teammate, or project references it. Those tables FK
 * onto region.id, so deleting a referenced region would either fail at the
 * constraint or (worse) orphan attributed spend. We refuse with a 409 that
 * names the counts so the operator knows exactly what to reassign/remove
 * first. Unlike org_unit (soft-retire via retired_at), region has no
 * retire path — it's either empty-and-deletable or it stays.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { requireUuidParam } from '../../../../utils/require-uuid-param'
import { translatePgConstraintError } from '../../../../utils/pg-constraint-error'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)

  const regionId = requireUuidParam(event, 'id', 'region id')

  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const existing = await tx.execute<{ id: string; code: string }>(sql`
      SELECT id::text AS id, code FROM region WHERE id = ${regionId}::uuid LIMIT 1
    `)
    const regionRow = [...existing][0]
    if (!regionRow) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Region not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Region not found',
          status: 404,
          detail: 'No region matches the supplied id.',
        },
      })
    }

    // Count EVERY table that FKs onto region.id. Only a fully empty region may
    // be deleted. Missing any of these would let the DELETE hit a raw FK
    // constraint and 500 instead of returning this clean 409 (adversarial R1
    // M2). activity_type is the trap: it is region-scoped but independent of
    // teammates/units/projects, so a region can hold one with all other counts
    // zero. attribution_record + instance_attestation also FK region_id.
    // directory_region_rule + region_leader (mig 0068 → 0089) also FK region_id
    // with a NO-ACTION posture (never CASCADE — that would silently drop curated
    // region-derivation config and re-scope spend). Without them here, deleting
    // a region that still has a region rule or an (active OR revoked) leader
    // 500s on a raw 23503 instead of returning this clean 409.
    const counts = await tx.execute<{
      org_units: string
      teammates: string
      projects: string
      activity_types: string
      attribution_records: string
      instance_attestations: string
      region_rules: string
      region_leaders: string
    }>(sql`
      SELECT
        (SELECT COUNT(*) FROM org_unit WHERE region_id = ${regionId}::uuid)::text AS org_units,
        (SELECT COUNT(*) FROM teammate WHERE region_id = ${regionId}::uuid)::text AS teammates,
        (SELECT COUNT(*) FROM project WHERE region_id = ${regionId}::uuid)::text AS projects,
        (SELECT COUNT(*) FROM activity_type WHERE region_id = ${regionId}::uuid)::text AS activity_types,
        (SELECT COUNT(*) FROM attribution_record WHERE region_id = ${regionId}::uuid)::text AS attribution_records,
        (SELECT COUNT(*) FROM instance_attestation WHERE region_id = ${regionId}::uuid)::text AS instance_attestations,
        (SELECT COUNT(*) FROM directory_region_rule WHERE region_id = ${regionId}::uuid)::text AS region_rules,
        (SELECT COUNT(*) FROM region_leader WHERE region_id = ${regionId}::uuid)::text AS region_leaders
    `)
    const c = [...counts][0]!
    const orgUnits = Number(c.org_units)
    const teammates = Number(c.teammates)
    const projects = Number(c.projects)
    const activityTypes = Number(c.activity_types)
    const attributionRecords = Number(c.attribution_records)
    const instanceAttestations = Number(c.instance_attestations)
    const regionRules = Number(c.region_rules)
    const regionLeaders = Number(c.region_leaders)
    const total =
      orgUnits +
      teammates +
      projects +
      activityTypes +
      attributionRecords +
      instanceAttestations +
      regionRules +
      regionLeaders

    if (total > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Region is not empty',
        data: {
          type: 'https://tokenscope.example.com/errors/conflict',
          title: 'Region is not empty',
          status: 409,
          detail:
            `Region has ${orgUnits} org units, ${teammates} teammates, ${projects} projects, ` +
            `${activityTypes} activity types, ${attributionRecords} attribution records, ` +
            `${instanceAttestations} instances, ${regionRules} region rules, ` +
            `${regionLeaders} region leaders — reassign or remove them first.`,
        },
      })
    }

    // TOCTOU (API-11): a referencing row can be created between the
    // emptiness counts above and this DELETE. The NO-ACTION FKs then
    // reject the delete with 23503 — translate to the same clean 409 the
    // pre-check gives (the projects/[id].delete house pattern).
    try {
      await tx.execute(sql`DELETE FROM region WHERE id = ${regionId}::uuid`)
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23503': {
          title: 'Region gained references concurrently',
          detail:
            'A row referencing this region was created while deleting. Reassign or remove it first, then retry.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'region-deleted',
      actorTeammateId: caller.teammateId,
      subjectKind: 'region',
      subjectId: regionId,
      payload: {
        code: regionRow.code,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id: regionId, deleted: true }
  })
})
