/*
 * DELETE /api/v1/admin/reconciliation/orgs/{id} — hard-delete a provider_org.
 *
 * provider_org is a LEAF in the FK graph (the reconciliation/attribution paths
 * resolve an org by its (provider, external_org_id) text key at read time — they
 * do NOT hold an FK to provider_org.id), so a hard delete orphans no rows. It
 * only de-registers the org: future events carrying that organization.id fall
 * back to the 'unknown' lane (telemetry-only) until it is re-onboarded. Historical
 * reconciliation/attribution records are untouched (they pin their own ids/text).
 *
 * RBAC: requireRole(admin, global-finops) + assertSameOrigin. Audited. Unknown
 * id → 404; malformed id → 400 (requireUuidParam).
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'

interface DeletedRow extends Record<string, unknown> {
  provider: string
  external_org_id: string
  display_name: string
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'provider-org id')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // DELETE … RETURNING is the atomic exists-check (no TOCTOU between a SELECT
    // and the delete); zero rows → 404.
    const deleted = await tx.execute<DeletedRow>(sql`
      DELETE FROM provider_org WHERE id = ${id}::uuid
      RETURNING provider, external_org_id, display_name
    `)
    const row = [...deleted][0]
    if (!row) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Provider org not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Provider org not found',
          status: 404,
          detail: 'No provider_org matches the supplied id.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'provider-org-deleted',
      actorTeammateId: caller.teammateId,
      subjectKind: 'provider-org',
      subjectId: id,
      payload: {
        provider: row.provider,
        external_org_id: row.external_org_id,
        display_name: row.display_name,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id, deleted: true }
  })
})
