/*
 * POST /api/v1/admin/directory-region-rules — upsert a directory→region rule
 * (mig 0089): "when a user's <attribute> = <value>, region is <R>". GLOBAL roles
 * only (cross-region placement config). Upsert keyed on (attribute, match_value)
 * so re-adding re-points the region + refreshes casing.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import { recordAuditEvent } from '../../../db/audit'
import {
  isRegionAttributeKey,
  isMatchMode,
  normalizeMatchValue,
} from '../../../../shared/placement/region-attributes'

const Body = z.object({
  attribute: z.string().refine(isRegionAttributeKey, 'unknown region attribute'),
  match_mode: z.string().refine(isMatchMode, "match_mode must be 'exact' or 'prefix'").default('exact'),
  match_value: z.string().trim().min(1).max(200),
  region_id: z.string().uuid(),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'global-finops', 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const matchValue = normalizeMatchValue(body.match_value)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const regionRows = await tx.execute<{ id: string; code: string }>(sql`
      SELECT id::text AS id, code FROM region WHERE id = ${body.region_id}::uuid LIMIT 1
    `)
    const regionRow = [...regionRows][0]
    if (!regionRow) throw createError({ statusCode: 422, statusMessage: 'Region not found' })

    const upserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO directory_region_rule (attribute, match_mode, match_value, match_value_raw, region_id, created_by, created_at)
      VALUES (${body.attribute}, ${body.match_mode}, ${matchValue}, ${body.match_value.trim()}, ${body.region_id}::uuid, ${caller.teammateId}::uuid, now())
      ON CONFLICT (attribute, match_value) DO UPDATE
        SET region_id = EXCLUDED.region_id,
            match_mode = EXCLUDED.match_mode,
            match_value_raw = EXCLUDED.match_value_raw,
            updated_at = now()
      RETURNING id::text AS id
    `)
    const row = [...upserted][0]!

    await recordAuditEvent(tx, {
      eventType: 'region-rule-set',
      actorTeammateId: caller.teammateId,
      subjectKind: 'directory_region_rule',
      subjectId: row.id,
      payload: {
        attribute: body.attribute,
        match_mode: body.match_mode,
        match_value: matchValue,
        region_id: body.region_id,
        region_code: regionRow.code,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: row.id,
      attribute: body.attribute,
      match_mode: body.match_mode,
      match_value: matchValue,
      match_value_raw: body.match_value.trim(),
      region_id: body.region_id,
      region_code: regionRow.code,
    }
  })
})
