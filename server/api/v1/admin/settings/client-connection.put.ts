/*
 * PUT /api/v1/admin/settings/client-connection — set the "Client connection"
 * policy the connect dialog renders from (#415, mig 0151). Platform-admin only:
 * it decides which marketplace every developer on the deployment is told to
 * install from. Audited with the before and after values.
 */
import { defineEventHandler, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import {
  getClientConnectionPolicy,
  lockClientConnectionPolicy,
  upsertClientConnectionPolicy,
  toWire,
} from '../../../../db/client-connection'
import { ClientConnectionBody, type ClientConnectionPolicy } from '../../../../../shared/connect'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, ClientConnectionBody)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  const next: ClientConnectionPolicy = {
    marketplaceSource: body.marketplace_source,
    marketplaceRef: body.marketplace_ref,
    marketplaceName: body.marketplace_name,
    claudePlugin: body.claude_plugin,
    copilotPlugin: body.copilot_plugin,
    enabledClients: body.enabled_clients,
    supportUrl: body.support_url,
  }

  return await withRequestRls(event, async (tx) => {
    // BEFORE reading `before`: two concurrent saves would otherwise both audit
    // the same prior value, and the second's `before` would not be the first's
    // `after`.
    await lockClientConnectionPolicy(tx)
    const before = await getClientConnectionPolicy(tx)
    const row = await upsertClientConnectionPolicy(tx, next, caller.teammateId)
    await recordAuditEvent(tx, {
      eventType: 'client-connection-policy-updated',
      actorTeammateId: caller.teammateId,
      subjectKind: 'platform',
      payload: { before: toWire(before), after: toWire(row) },
      ipAddress: ip,
      userAgent: ua,
    })
    return { configured: true, ...toWire(row), updated_by: row.updatedBy, updated_at: row.updatedAt }
  })
})
