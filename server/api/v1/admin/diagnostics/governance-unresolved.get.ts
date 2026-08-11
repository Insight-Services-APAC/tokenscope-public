/*
 * GET /api/v1/admin/diagnostics/governance-unresolved — the operator surface
 * for the governance-unresolved bucket (design §4.0 point 3 / §8.4): rows
 * whose provider_org_id / provider_enterprise_id could not be resolved.
 * Showback-visible always; NEVER chargeable while unresolved. Every bucket is
 * a state to resolve, never a permanent sink — remediation is "register/link
 * the org", recheck is the POST action below.
 *
 * RBAC: global-finops ONLY (mirrors ab-decomposition.get.ts — estate-wide,
 * money-adjacent diagnostics).
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { classifyProbeError } from '../../../../utils/redact-probe-error'

interface UnresolvedSourceRow extends Record<string, unknown> {
  source: string
  cnt: string
  cost_usd: string
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'global-finops')
  return withRequestRls(event, async (tx) => {
    try {
      const [actualSpendPending, actualSpendUnresolved, reconRecordPending, reconRecordUnresolved, pendingPlacementUnresolved] =
        await Promise.all([
          tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM actual_spend WHERE governance_key_status IS NULL`),
          tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM actual_spend WHERE governance_key_status = 'unresolved'`),
          tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM reconciliation_record WHERE governance_key_status IS NULL`),
          tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM reconciliation_record WHERE governance_key_status = 'unresolved'`),
          tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM pending_placement WHERE placed_at IS NULL AND provider_org_id IS NULL`),
        ])

      // The actual money-impact view: unresolved-governance actual_spend rows,
      // grouped by source (the remediation clue — which org/enterprise string
      // needs registering/linking), with the showback dollars they represent.
      const bySource = await tx.execute<UnresolvedSourceRow>(sql`
        SELECT source, count(*)::text AS cnt, COALESCE(SUM(cost_usd), 0)::text AS cost_usd
        FROM actual_spend
        WHERE governance_key_status = 'unresolved' OR provider_org_id IS NULL
        GROUP BY source
        ORDER BY SUM(cost_usd) DESC
        LIMIT 50
      `)

      return {
        reachable: true,
        actualSpend: {
          pendingBackfill: Number(actualSpendPending[0]?.n ?? 0),
          parkedUnresolved: Number(actualSpendUnresolved[0]?.n ?? 0),
        },
        reconciliationRecord: {
          pendingBackfill: Number(reconRecordPending[0]?.n ?? 0),
          parkedUnresolved: Number(reconRecordUnresolved[0]?.n ?? 0),
        },
        pendingPlacement: {
          unresolved: Number(pendingPlacementUnresolved[0]?.n ?? 0),
        },
        bySource: bySource.map((r) => ({ source: r.source, count: Number(r.cnt), costUsd: r.cost_usd })),
        remediation:
          'Register or link the provider_org / provider_enterprise for each listed source, then POST /api/v1/admin/diagnostics/governance-unresolved/recheck to resweep immediately (or wait for the next governance-key-backfill run).',
      }
    } catch (err) {
      const { reason, correlationId } = classifyProbeError(err, 'diagnostics:governance-unresolved')
      return { reachable: false, error: reason, errorCorrelationId: correlationId }
    }
  })
})
