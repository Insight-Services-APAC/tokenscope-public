/*
 * GET /api/v1/admin/diagnostics/attribution-gaps — devices that are emitting but
 * whose spend is not being attributed.
 *
 * This is the OPERATOR SURFACE for the silent-attribution outage class. It
 * exists because the answer to "which devices are affected?" used to live only
 * as a SQL query in a runbook, and nobody can run SQL against Dev/production —
 * so in practice the question could not be answered at all during an incident.
 * If a check matters enough to run, it belongs in the product.
 *
 * It calls the SAME predicate the attribution-gap worker alerts on
 * (findAttributionGaps), deliberately: a diagnostics list that disagreed with
 * the alerting rule would be worse than no list, because an operator would trust
 * it to decide whether an alert is real.
 *
 * RBAC: admin / global-finops, matching the rest of diagnostics. Read-only.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { findAttributionGaps } from '../../../../workers/attribution-gap'
import { classifyProbeError } from '../../../../utils/redact-probe-error'

const querySchema = z.object({
  // Both knobs are exposed so an operator can widen the lens mid-incident
  // (e.g. gapHours=6 right after a suspected regression) without a deploy.
  gapHours: z.coerce.number().positive().max(24 * 90).optional(),
  liveHours: z.coerce.number().positive().max(24 * 90).optional(),
})

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin', 'global-finops')
  const q = await getValidatedQuery(event, (v) => querySchema.parse(v))

  return withRequestRls(event, async (db) => {
    try {
      const instances = await findAttributionGaps(db, {
        gapHours: q.gapHours,
        liveHours: q.liveHours,
        // Region-scoped `admin` sees only their region's gaps; global-finops /
        // platform-admin keep the estate-wide list. MUST default to null (not
        // omitted) when the caller isn't region-scoped — the worker calls this
        // same function with no regionId at all, and narrowing it unconditionally
        // would re-create the silent-attribution outage this endpoint exists to
        // diagnose.
        regionId: session.role === 'admin' ? session.regionId : null,
      })
      return {
        reachable: true,
        gapHours: q.gapHours ?? null, // null = the worker's default
        liveHours: q.liveHours ?? null,
        count: instances.length,
        instances,
      }
    } catch (err) {
      // Mirrors the other diagnostics probes: a failed probe reports itself
      // rather than 500-ing the page, so one bad query never blinds the rest.
      // NOT unit-tested (mutation sweep: these lines survive) — reaching it needs
      // a mid-request DB failure, which no harness here can force without
      // breaking the shared test database. The sibling probes in index.get.ts
      // carry the same untested defensive shape; the risk is a degraded error
      // message, never a wrong answer, since the success path is fully asserted.
      const { reason, correlationId } = classifyProbeError(err, 'diagnostics:attribution-gaps')
      return {
        reachable: false,
        error: reason,
        errorCorrelationId: correlationId,
        count: 0,
        instances: [],
      }
    }
  })
})
