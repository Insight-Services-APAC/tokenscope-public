/*
 * POST /api/v1/admin/report-access — grant a report-access permission to one
 * teammate (mig 0129, replaces the three-mode admin dial's write side, task
 * #19).
 *
 * ORG-WIDE ONLY (A4): `requireRole(event, 'global-finops')` — platform-admin
 * passes any requireRole gate; no 'admin' write access and no re-narrow step
 * (unlike the retired report-visibility.put.ts, which re-narrowed
 * admin|global-finops down to platform-admin|global-finops — this endpoint's
 * ROLE GATE already IS that narrower set).
 *
 * EXPIRY LIFECYCLE (A5, fixes the re-grant deadlock): the partial unique
 * index only excludes an ACTIVE row (revoked_at IS NULL), so a grant that
 * merely EXPIRED (revoked_at still NULL) would 409 every re-grant attempt
 * forever, with no explanation, until an admin explicitly revoked the dead
 * row first. BEFORE inserting, this endpoint supersedes exactly that blocker
 * — an expired, still-`revoked_at IS NULL` row for the SAME
 * (teammate, permission) — with its own audit event, so a genuinely LIVE
 * duplicate still 409s (the unique index), but a merely-expired one never
 * blocks forever.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { readValidated } from '../../../../utils/validated-body'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { translatePgConstraintError } from '../../../../utils/pg-constraint-error'
import { reportAccessGrant } from '../../../../../drizzle/schema'
import { ReportAccessGrantBody } from '../../../../../shared/schemas/report-access'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'global-finops')
  assertSameOrigin(event)
  const body = await readValidated(event, ReportAccessGrantBody)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // "In the future" is judged by the DATABASE clock, inside the same
    // transaction that enforces expiry at read time (`expires_at > now()`) —
    // the application clock can disagree with it, and a pre-transaction check
    // could pass an expiry that has already elapsed by insert time.
    if (body.expires_at) {
      const [fresh] = [
        ...(await tx.execute<{ ok: boolean }>(sql`
          SELECT ${body.expires_at}::timestamptz > now() AS ok`)),
      ]
      if (!fresh?.ok) {
        throw createError({
          statusCode: 400,
          statusMessage: 'Invalid expiry',
          data: {
            type: 'https://tokenscope.example.com/errors/validation',
            title: 'Invalid expiry',
            status: 400,
            detail: 'expires_at must be in the future.',
          },
        })
      }
    }
    const targetRows = await tx.execute<{
      id: string
      email: string
      is_active: boolean
      provisional: boolean
    }>(sql`
      SELECT id::text AS id, email, is_active, provisional
      FROM teammate WHERE id = ${body.teammate_id}::uuid LIMIT 1
    `)
    const target = [...targetRows][0]
    if (!target) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Teammate not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Teammate not found',
          status: 404,
          detail: 'No teammate matches that id.',
        },
      })
    }
    if (!target.is_active || target.provisional) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Teammate not eligible',
        data: {
          type: 'https://tokenscope.example.com/errors/validation',
          title: 'Teammate not eligible',
          status: 400,
          detail:
            'Report-access grants require an active, confirmed teammate (not deactivated or provisional).',
        },
      })
    }

    // A5: supersede an EXPIRED (but not yet revoked) blocker for this exact
    // (teammate, permission) before inserting — see the module header. A LIVE
    // duplicate (no expiry, or expiry still in the future) is untouched here
    // and still 409s below via the partial unique index.
    const superseded = await tx.execute<{ id: string }>(sql`
      UPDATE report_access_grant
         SET revoked_at = now(), revoked_by = ${caller.teammateId}::uuid
       WHERE teammate_id = ${body.teammate_id}::uuid
         AND permission = ${body.permission}
         AND revoked_at IS NULL
         AND expires_at IS NOT NULL AND expires_at <= now()
       RETURNING id::text AS id
    `)
    const supersededRow = [...superseded][0]
    if (supersededRow) {
      await recordAuditEvent(tx, {
        eventType: 'report-access-revoked',
        actorTeammateId: caller.teammateId,
        subjectKind: 'teammate',
        subjectId: body.teammate_id,
        payload: {
          before: { permission: body.permission },
          after: { revoked_at: new Date().toISOString() },
          context: {
            grant_id: supersededRow.id,
            teammate_id: body.teammate_id,
            reason: 'expired-superseded',
          },
        },
        ipAddress: ip,
        userAgent: ua,
      })
    }

    let created:
      | {
          id: string
          teammateId: string
          permission: string
          grantedBy: string | null
          grantedAt: Date
          expiresAt: Date | null
        }
      | undefined
    try {
      ;[created] = await tx
        .insert(reportAccessGrant)
        .values({
          teammateId: body.teammate_id,
          permission: body.permission,
          grantedBy: caller.teammateId,
          ...(body.expires_at ? { expiresAt: new Date(body.expires_at) } : {}),
        })
        .returning()
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23505': {
          title: 'Already granted',
          detail: `This teammate already holds an active ${body.permission} grant.`,
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'report-access-granted',
      actorTeammateId: caller.teammateId,
      subjectKind: 'teammate',
      subjectId: body.teammate_id,
      payload: {
        before: null,
        after: {
          permission: body.permission,
          expires_at: body.expires_at ?? null,
          teammate_email: target.email,
        },
        context: { teammate_id: body.teammate_id },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: created!.id,
      teammate_id: created!.teammateId,
      permission: created!.permission,
      granted_by: created!.grantedBy,
      granted_at: created!.grantedAt,
      expires_at: created!.expiresAt,
    }
  })
})
