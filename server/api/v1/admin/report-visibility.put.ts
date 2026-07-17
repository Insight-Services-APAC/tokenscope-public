/*
 * PUT /api/v1/admin/report-visibility — set the org-wide report-visibility mode
 * (mig 0087). ONE knob deciding which /reports scopes each persona sees; three
 * named presets, default 'standard' = today's RBAC byte-for-byte.
 *
 * Authority mirrors the directory-exclusion policy + the platform-baseline
 * governance dials (#121 write pattern): the admin|global-finops role gate is
 * RE-NARROWED to platform-admin|global-finops, because this is ORG-WIDE config,
 * not a region admin's to set. assertSameOrigin (CSRF) + zod-validated body
 * (the mode literal from the shared source of truth) + before/after audit.
 *
 * Single logical row (key='policy'); repeated PUTs upsert it. subjectKind
 * 'platform' — the change is org-wide, not region-scoped.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { isPlatformAdmin } from '../../../../shared/auth/roles'
import { withRequestRls } from '../../../db/request-rls'
import { recordAuditEvent } from '../../../db/audit'
import { ReportVisibilityPutBody } from '../../../../shared/schemas/report-visibility'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  // Org-wide config — not a region admin's to set (mirrors the platform dial
  // baseline + the directory-exclusion policy).
  if (!(isPlatformAdmin(caller.role) || caller.role === 'global-finops')) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      data: {
        type: 'https://tokenscope.example.com/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail:
          'The report-visibility policy is org-wide config; requires platform-admin or global-finops.',
      },
    })
  }
  assertSameOrigin(event)
  const body = await readValidated(event, ReportVisibilityPutBody)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // Before-image for the audit trail. Absent row ⇒ the effective mode today
    // is 'standard' (no seed row on a fresh upgrade).
    const beforeRows = await tx.execute<{ mode: string }>(sql`
      SELECT mode FROM report_visibility_setting WHERE key = 'policy' LIMIT 1
    `)
    const before = [...beforeRows][0]?.mode ?? 'standard'

    await tx.execute(sql`
      INSERT INTO report_visibility_setting (key, mode, updated_by, updated_at)
      VALUES ('policy', ${body.mode}, ${caller.teammateId}::uuid, now())
      ON CONFLICT (key)
      DO UPDATE SET mode       = EXCLUDED.mode,
                    updated_by = EXCLUDED.updated_by,
                    updated_at = now()
    `)

    await recordAuditEvent(tx, {
      eventType: 'report-visibility-changed',
      actorTeammateId: caller.teammateId,
      subjectKind: 'platform',
      payload: { before, after: body.mode },
      ipAddress: ip,
      userAgent: ua,
    })

    return { mode: body.mode }
  })
})
