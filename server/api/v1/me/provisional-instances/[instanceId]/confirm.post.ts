/*
 * POST /api/v1/me/provisional-instances/{instanceId}/confirm — explicit,
 * audited confirm-on-auth merge (emit-on-install, slice 5;
 * docs/design/emit-on-install-provisional-attribution.md §Flows 3).
 *
 * The ONLY path that promotes a provisional instance to 'confirmed'. requireAuth
 * gives the authenticated real teammate; confirmProvisionalInstance does the
 * transactional merge AND enforces THE anti-laundering gate (the instance's
 * claimed_email MUST equal the session email → otherwise 403). 404 on an unknown
 * instance / one already confirmed for someone else (no existence leak).
 *
 * Display-only: confirmation never moves money (finance is gated on `reconciled`,
 * the provider bill). This just upgrades the person's pre-bill OTel usage to
 * 'confirmed' and folds the shadow teammate away.
 */
import { defineEventHandler, getHeader, getRequestIP } from 'h3'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { requireAuth } from '../../../../../auth/rbac'
import { confirmProvisionalInstance } from '../../../../../auth/confirm-instance'
import { getDb } from '../../../../../db'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const instanceId = requireUuidParam(event, 'instanceId', 'instance id')

  // Best-effort audit context (must never crash the merge).
  let ip: string | null = null
  try {
    ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  } catch {
    // Best-effort — `ip` stays null from the initializer.
  }
  const ua = getHeader(event, 'user-agent') ?? null

  const result = await confirmProvisionalInstance(getDb(), {
    realTeammateId: session.teammateId,
    realTeammateEmail: session.email,
    instanceId,
    ipAddress: ip,
    userAgent: ua,
  })

  return {
    id: result.instanceId,
    confirmed: true,
    already_confirmed: result.alreadyConfirmed,
  }
})
