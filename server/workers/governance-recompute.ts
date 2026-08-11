/*
 * governance-recompute worker — the periodic, UNSCOPED counterpart to the
 * inline scoped recompute triggered by a billing PATCH (design §4.1: "Open:
 * verdict recomputed from current billing on each run"). Catches rows a
 * scoped call never touched: brand-new ingest before a governance-key
 * backfill resolved them, or a governance-key resweep that just un-parked
 * previously-unresolved rows.
 *
 * Bounded + resumable (design §8.4): loops recomputeGovernanceVerdicts in
 * fixed-size batches within a wall-clock budget, mirroring
 * reconciliation-backfill.ts's BUDGET_MS pattern. Cron/HMAC-only — NOT in
 * UI_TRIGGERABLE_WORKER_NAMES (a money-adjacent bulk UPDATE is the wrong
 * one-click blast radius, per that registry's own stated bar).
 *
 * NO CROSS-INVOCATION CURSOR (deliberate, unlike reconciliation-backfill.ts's
 * persisted cursor_date): the candidate set here is "still-OPEN actual_spend
 * rows", which is naturally small and recent — closed periods are structurally
 * excluded, and a normal finance cadence closes each month soon after it ends.
 * This is NOT the historical-backfill worker (that is
 * governance-key-backfill.ts, whose job IS the full historical backlog); this
 * worker's job is keeping the last one-or-two open months converged with
 * current governance. Each invocation re-scans the open set from the start,
 * which converges quickly and is idempotent to repeat. If the open set ever
 * grows unexpectedly large, one invocation still makes full forward progress
 * within its own budget (the in-run cursor below) — the only cost of no
 * cross-invocation cursor is redundant re-scanning next tick, never incorrect
 * results.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { recomputeGovernanceVerdicts, RECOMPUTE_DEFAULT_BATCH } from '../governance/recompute'

type Db = PostgresJsDatabase<typeof schema>

/** Per-invocation budget — stays well under the run-worker HTTP gateway ceiling
 *  (see reconciliation-backfill.ts's identical rationale). */
export const GOVERNANCE_RECOMPUTE_BUDGET_MS = 25_000

export interface GovernanceRecomputeResult {
  batches: number
  scanned: number
  updated: number
  hasMore: boolean
}

export async function runGovernanceRecompute(
  db: Db,
  opts?: { budgetMs?: number; batchSize?: number },
): Promise<GovernanceRecomputeResult> {
  const budgetMs = opts?.budgetMs ?? GOVERNANCE_RECOMPUTE_BUDGET_MS
  const limit = opts?.batchSize ?? RECOMPUTE_DEFAULT_BATCH
  const deadline = Date.now() + budgetMs

  let batches = 0
  let scanned = 0
  let updated = 0
  let hasMore = true
  let afterDate: string | undefined
  let afterId: string | undefined
  while (hasMore) {
    const r = await db.transaction((tx) => recomputeGovernanceVerdicts(tx, { limit, afterDate, afterId }))
    batches += 1
    scanned += r.scanned
    updated += r.updated
    hasMore = r.hasMore
    afterDate = r.lastDate
    afterId = r.lastId
    if (Date.now() >= deadline) break // resume next invocation
  }
  return { batches, scanned, updated, hasMore }
}
