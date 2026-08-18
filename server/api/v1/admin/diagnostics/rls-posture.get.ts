/*
 * GET /api/v1/admin/diagnostics/rls-posture — the RLS capability probe.
 *
 * WHY THIS ENDPOINT EXISTS. Enabling RLS enforcement
 * (docs/design/rls-enforcement.md) needs a NON-OWNER database role, and the plan
 * for creating it rests on a claim nobody has checked: that the migration
 * runner's Azure Flexible Server `administratorLogin` is a member of
 * `azure_pg_admin` and can therefore run `CREATE ROLE`. That is read off Azure's
 * documentation, not off our instance. Nobody can reach the dev database from
 * outside it (VNet + private endpoints), so the measurement has to be taken from
 * inside the app and read back out here.
 *
 * READ-ONLY. The probe runs three `SELECT`s against pg_catalog — four once the
 * app role exists. It provisions
 * nothing, enables nothing and disables nothing — design §9's runbook is a
 * different change.
 *
 * RBAC: platform-admin ONLY, matching network.get.ts and otel-logs.get.ts. The
 * response names database roles, the table owner, and precisely which security
 * controls are and are not in force — infrastructure and control-state, not
 * region-scoped operational data. A region-scoped `admin` and global-finops both
 * get a 403, which the diagnostics page renders as a calm scoped-out note.
 *
 * The probe module lives in `scripts/` because the entrypoint pre-flight also
 * runs it at boot and the runtime image ships no `server/` directory — the same
 * arrangement as `scripts/preflight.ts`, which this route's siblings import.
 */
import { defineEventHandler, createError } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { classifyProbeError } from '../../../../utils/redact-probe-error'
import { RLS_APP_ROLE, RLS_BOOTSTRAP_TABLE_NAMES } from '../../../../db/rls-bootstrap'
import { probeRlsPosture, type RlsPostureReport } from '../../../../../scripts/preflight-rls'

export default defineEventHandler(async (event): Promise<RlsPostureReport> => {
  await requireRole(event, 'platform-admin')
  try {
    // On the REQUEST lane, deliberately. Every query the probe runs reads
    // pg_catalog, which no policy governs, so the lane changes no answer — but
    // it keeps this handler off `scripts/check-handler-rls-context.mjs`'s
    // allowlist, and it means the connection being measured is the one requests
    // actually use.
    return await withRequestRls(event, (tx) =>
      probeRlsPosture(tx, {
        appRole: RLS_APP_ROLE,
        bootstrapTables: RLS_BOOTSTRAP_TABLE_NAMES,
      }),
    )
  } catch (err) {
    const { reason, correlationId } = classifyProbeError(err, 'diagnostics:rls-posture')
    throw createError({
      statusCode: 502,
      statusMessage: `rls posture probe failed: ${reason}`,
      data: { correlationId },
    })
  }
})
