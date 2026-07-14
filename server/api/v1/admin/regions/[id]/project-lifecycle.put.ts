/*
 * PUT /api/v1/admin/regions/:id/project-lifecycle — set a REGION override for
 * the project-lifecycle cadence (D9). Region admin scoped to their own region
 * (requireRegionScope); org-wide admins any region. Audited.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { upsertLifecyclePolicy } from '../../../../../db/project-lifecycle-policy'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { translatePgConstraintError } from '../../../../../utils/pg-constraint-error'

const Body = z.object({
  grace_hours: z.number().int().min(0).max(168),
  warn_days: z.number().int().min(1).max(90),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const regionId = requireUuidParam(event, 'id', 'region id')
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    await requireRegionScope(event, regionId)
    // Existence check (API-9): without it a global-finops PUT against any
    // UUID hits the scope_id FK → 23503 → raw 500 instead of this 404.
    const regionRows = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM region WHERE id = ${regionId}::uuid LIMIT 1
    `)
    if (![...regionRows][0]) {
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
    try {
      await upsertLifecyclePolicy(tx, {
        scopeType: 'region',
        scopeId: regionId,
        graceHours: body.grace_hours,
        warnDays: body.warn_days,
        updatedBy: caller.teammateId,
      })
    } catch (err: unknown) {
      // Region hard-deleted between the check and the upsert (TOCTOU).
      translatePgConstraintError(err, {
        '23503': {
          status: 404,
          title: 'Region not found',
          detail: 'The region was deleted while saving the lifecycle policy.',
        },
      })
    }
    await recordAuditEvent(tx, {
      eventType: 'project-lifecycle-policy-updated',
      actorTeammateId: caller.teammateId,
      subjectKind: 'region',
      subjectId: regionId,
      payload: { scope: 'region', region_id: regionId, grace_hours: body.grace_hours, warn_days: body.warn_days },
      ipAddress: ip,
      userAgent: ua,
    })
    return { scope: 'region', region_id: regionId, grace_hours: body.grace_hours, warn_days: body.warn_days }
  })
})
