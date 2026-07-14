/*
 * usage-reconciliation worker — recomputes the per-(teammate, day, tool)
 * "unaccounted usage" (provider API truth − OTel captured) over a trailing window,
 * so a developer's "My usage" reflects the COMPLETE provider truth and the un-enrolled
 * delta is taggable day-by-day. See docs/design/provider-billing-attribution-model.md §A.
 *
 * Trailing 35-day window (crosses the month boundary, absorbs late OTel arrivals); the
 * upsert is idempotent and tag-preserving, so re-running only refreshes the amounts.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { reconcileUnaccountedUsage, type ReconcileUnaccountedResult } from '../usage/unaccounted-reconciliation'
import { detectOverEmission, type OverEmissionResult } from '../usage/over-emission-detection'

type Db = PostgresJsDatabase<typeof schema>

const TRAILING_DAYS = 35

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export interface UsageReconciliationResult {
  unaccounted: ReconcileUnaccountedResult
  overEmission: OverEmissionResult
}

export async function runUsageReconciliation(
  db: Db,
  opts?: { now?: Date },
): Promise<UsageReconciliationResult> {
  const now = opts?.now ?? new Date()
  const endDate = utcDay(now)
  const start = new Date(now)
  start.setUTCDate(start.getUTCDate() - (TRAILING_DAYS - 1))
  const startDate = utcDay(start)
  // Two sides of the same API-vs-OTel reconciliation: under (usage OTel missed → taggable)
  // and over (uncorroborated OTel excess → flagged for the dev to review).
  const unaccounted = await reconcileUnaccountedUsage(db, { startDate, endDate })
  const overEmission = await detectOverEmission(db, { startDate, endDate })
  return { unaccounted, overEmission }
}
