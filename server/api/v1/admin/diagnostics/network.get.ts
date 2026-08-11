/*
 * GET /api/v1/admin/diagnostics/network — holistic private-link / DNS route
 * validator. Resolves every private-link FQDN the dev app depends on (Postgres,
 * Redis, Key Vault, the full Azure Monitor/AMPLS set) FROM INSIDE the app, with
 * public-vs-private classification + TCP reachability, plus a copy-paste IT
 * report. The app is the only client inside the VNet perimeter, so this is the
 * only place this can be checked.
 *
 * RBAC: platform-admin ONLY — matching otel-logs.get.ts:48. This returns
 * private IPs, internal host:port pairs and reachability for every provisioned
 * dependency (infrastructure topology, not per-region operational data), which
 * is the same class of exposure otel-logs.get.ts is gated on. A region-scoped
 * `admin` now gets a 403 here (see diagnostics.vue's calm scoped-out card,
 * mirroring the OTel card's treatment) — the rest of the diagnostics page is
 * unaffected. Read-only (DNS + raw TCP).
 */
import { defineEventHandler, createError } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { runNetworkCheck } from '../../../../azure/network-check'
import { classifyProbeError } from '../../../../utils/redact-probe-error'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'platform-admin')
  try {
    return await runNetworkCheck()
  } catch (err) {
    const { reason, correlationId } = classifyProbeError(err, 'diagnostics:network-check')
    throw createError({
      statusCode: 502,
      statusMessage: `network check failed: ${reason}`,
      data: { correlationId },
    })
  }
})
