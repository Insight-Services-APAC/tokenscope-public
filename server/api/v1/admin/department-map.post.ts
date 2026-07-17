/*
 * POST /api/v1/admin/department-map — set (upsert) a department → region
 * mapping (region derivation, mig 0068). admin / global-finops.
 *
 * The primary region-derivation signal: an unplaced user's Entra
 * `department` homes them in their real region. The map is org-wide curated
 * config (not region-scoped) — adding a mapping is a deliberate placement
 * policy, so it is intentionally not bounded to the caller's region.
 *
 * Keyed on department_lower = trim().lower() of the supplied department, so
 * the lookup is case-insensitive; the original casing is kept for display.
 * Upsert on the department_lower PK: ON CONFLICT DO UPDATE re-points an
 * existing department to the new region (and refreshes the display casing +
 * updated_at).
 *
 * Money policy (design doc fix #6): mapping a department to the Global/Shared
 * region (code 'global-shared') is ALLOWED but is a deliberate "this whole
 * department is a shared function regardless of reporting line" assertion —
 * not a hard block. The UI discourages mapping a geo-correlated department to
 * Global/Shared; mis-derivation lands in that region's unattributed holding
 * bucket and is admin-correctable.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import { recordAuditEvent } from '../../../db/audit'

const Body = z.object({
  department: z.string().trim().min(1).max(200),
  region_id: z.string().uuid(),
})

export default defineEventHandler(async (event) => {
  // Org-wide cross-region placement config → GLOBAL roles only (per design). A
  // region-admin must not route another region's unplaced spend via the dept map.
  const caller = await requireRole(event, 'global-finops', 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const departmentLower = body.department.trim().toLowerCase()
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const regionRows = await tx.execute<{ id: string; code: string }>(sql`
      SELECT id::text AS id, code FROM region WHERE id = ${body.region_id}::uuid LIMIT 1
    `)
    const regionRow = [...regionRows][0]
    if (!regionRow) {
      throw createError({ statusCode: 422, statusMessage: 'Region not found' })
    }

    // Upsert a department-attribute rule in directory_region_rule (mig 0089),
    // keyed on the normalised value. ON CONFLICT re-points to the new region and
    // refreshes display casing + updated_at. (Legacy back-compat endpoint — the
    // generalised rules API manages any attribute.)
    const upserted = await tx.execute<{ department_lower: string }>(sql`
      INSERT INTO directory_region_rule (attribute, match_mode, match_value, match_value_raw, region_id, created_by, created_at)
      VALUES ('department', 'exact', ${departmentLower}, ${body.department.trim()}, ${body.region_id}::uuid, ${caller.teammateId}::uuid, now())
      ON CONFLICT (attribute, match_value) DO UPDATE
        SET region_id = EXCLUDED.region_id,
            match_value_raw = EXCLUDED.match_value_raw,
            updated_at = now()
      RETURNING match_value AS department_lower
    `)
    const row = [...upserted][0]!

    await recordAuditEvent(tx, {
      eventType: 'department-map-set',
      actorTeammateId: caller.teammateId,
      subjectKind: 'directory_region_rule',
      subjectId: null,
      payload: {
        department: body.department.trim(),
        department_lower: row.department_lower,
        region_id: body.region_id,
        region_code: regionRow.code,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      department: body.department.trim(),
      department_lower: row.department_lower,
      region_id: body.region_id,
      region_code: regionRow.code,
    }
  })
})
