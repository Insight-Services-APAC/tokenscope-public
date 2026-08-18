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
 *
 * NO RLS LANE — a CROSS-IDENTITY merge, tracked as an explicit residue in
 * scripts/check-handler-rls-context.mjs. `confirmProvisionalInstance` re-points
 * the SHADOW teammate's rows onto the real one, including an
 * `UPDATE attribution_record` (a PHASE-1 FORCE table) matched on
 * `teammate_id = <the shadow>`. Run under the CONFIRMING user's context that
 * UPDATE would silently match FEWER rows — the shadow sits in a default
 * region/org placement, so the region policy hides its history — and the merge
 * would report success while leaving the pre-confirm spend orphaned on a
 * teammate that the next statement then retires. That is design §3's
 * silent-failure class exactly, and it is strictly worse than the context-less
 * version, which at least ERRORS under FORCE. The correct fix is the same
 * SECURITY DEFINER shape the provisional LIST needs (a migration, out of this
 * story's scope); until it exists, failing loudly is the safer residue.
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
