/*
 * POST /api/v1/admin/regions — create a region (admin-region-lifecycle).
 *
 * platform-admin ONLY. Regions are the top of the org hierarchy and the
 * unit that scopes every admin/global-finops query, so creating one is a
 * cross-region act reserved for the super-admin. requireRole(event,
 * 'platform-admin') correctly 403s a region admin AND global-finops — only
 * platform-admin passes (via the super-admin bypass in requireRole).
 *
 * `code` is the stable region key (the finance-scope filter hardcodes codes
 * like 'apac'); it must be a slug. The table has a UNIQUE constraint on code
 * (mig 0022) — we pre-check for a clean 409 instead of a raw constraint error.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import { recordAuditEvent } from '../../../db/audit'
import { readValidated, lowercaseSlug } from '../../../utils/validated-body'
import { region } from '../../../../drizzle/schema'

const Body = z.object({
  // Lowercase slug — "GlobalIT" is auto-lowercased to "globalit" rather than rejected.
  code: lowercaseSlug({ min: 2, max: 40, label: 'Region code' }),
  display_name: z.string().min(1).max(120),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // Unique code guard (the table has a UNIQUE constraint; pre-check for
    // a clean 409 instead of a raw constraint error).
    const dupe = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM region WHERE code = ${body.code} LIMIT 1
    `)
    if ([...dupe][0]) {
      throw createError({
        statusCode: 409,
        statusMessage: `Region code '${body.code}' already exists`,
        data: {
          type: 'https://tokenscope.example.com/errors/conflict',
          title: 'Region code already exists',
          status: 409,
          detail: `Region code '${body.code}' already exists — codes are unique.`,
        },
      })
    }

    const [created] = await tx
      .insert(region)
      .values({
        code: body.code,
        displayName: body.display_name,
      })
      .returning({ id: region.id, code: region.code, displayName: region.displayName })

    await recordAuditEvent(tx, {
      eventType: 'region-created',
      actorTeammateId: caller.teammateId,
      subjectKind: 'region',
      subjectId: created!.id,
      payload: {
        code: body.code,
        display_name: body.display_name,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id: created!.id, code: created!.code, display_name: created!.displayName }
  })
})
