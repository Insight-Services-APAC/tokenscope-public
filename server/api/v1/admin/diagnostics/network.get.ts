/*
 * GET /api/v1/admin/diagnostics/network — holistic private-link / DNS route
 * validator. Resolves every private-link FQDN the dev app depends on (Postgres,
 * Redis, Key Vault, the full Azure Monitor/AMPLS set) FROM INSIDE the app, with
 * public-vs-private classification + TCP reachability, plus a copy-paste IT
 * report. The app is the only client inside the VNet perimeter, so this is the
 * only place this can be checked.
 *
 * RBAC: admin / global-finops (platform-admin passes). No secrets exposed — only
 * host:port + resolved IPs — so any admin can troubleshoot the deployment.
 * Read-only (DNS + raw TCP).
 */
import { defineEventHandler, createError } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { runNetworkCheck } from '../../../../azure/network-check'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  try {
    return await runNetworkCheck()
  } catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: `network check failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
})
