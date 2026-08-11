/*
 * Worker-execution-health bookkeeping — writes into worker_run.
 *
 * The diagnostics freshness panel measures DATA recency and stayed green
 * while the joiner cron failed every run with a 504 (a partially-completing
 * worker still advances ts_recorded). worker_run records the OUTCOME of each
 * dispatch so a failing worker becomes visible in admin diagnostics.
 *
 * Contract for the caller (run-worker endpoint):
 *   - Bookkeeping is OBSERVABILITY. It MUST NOT break the worker. Every
 *     function here is fail-soft: it swallows its own errors and returns a
 *     sentinel (null run id) rather than throwing.
 *   - The caller still owns re-throwing the worker's own error.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { workerRun } from '../../drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

const ERROR_MAX = 500
// Stale-'running' reaper bound (ING-7): a worker wedged on a hung call (or a
// container killed mid-run) leaves its worker_run row 'running' forever, which
// diagnostics reads as perpetually in-progress rather than failed. The bound is
// deliberately generous headroom over any legitimate run so the reaper never
// false-fails a live one: the analytics poller fans out per-day × per-org ×
// pagination with 30s-timeout retries and can legitimately run for many minutes
// at month-end. 3h is well above any real worst case; a genuinely orphaned run
// simply lingers until the bound, and recordWorkerRunOutcome self-heals a run
// that completes after a (mistaken) reap. (Reviewer F1, adversarial round.)
const STALE_RUNNING_MINUTES = 180
// Cap the persisted result so the generic column can't be DoS'd by a future worker
// returning a large array. The three known result shapes are tiny scalar-count objects.
const RESULT_MAX_BYTES = 64_000

export interface WorkerRunOutcome {
  // 'skipped' = an admin has the worker disabled (mig 0090). Deliberately NOT
  // 'success': read-path-health treats a recent SUCCESS as evidence the read path
  // is alive, so recording a skip as success would let a disabled worker mask a
  // real outage.
  status: 'success' | 'failure' | 'skipped'
  durationMs: number
  rowsAffected?: number | null
  error?: string | null
  // The worker's full returned result object (any worker). Persisted verbatim if it
  // serialises under the size cap; otherwise replaced with a truncation marker. Never
  // breaks the worker (the whole write is fail-soft).
  result?: unknown
}

/** Serialise the result for jsonb storage, size-capping + swallowing unserialisable. */
function safeResult(result: unknown): unknown {
  if (result == null) return null
  try {
    const s = JSON.stringify(result)
    return s.length > RESULT_MAX_BYTES ? { truncated: true, bytes: s.length } : result
  } catch {
    return { truncated: true, reason: 'unserialisable' }
  }
}

/*
 * Insert a 'running' row and return its id. Returns null if the insert fails
 * (the bookkeeping must never block the worker) — the caller then no-ops the
 * outcome write.
 */
export async function recordWorkerRunStart(db: Db, workerName: string): Promise<string | null> {
  try {
    const [row] = await db
      .insert(workerRun)
      .values({ workerName, status: 'running' })
      .returning({ id: workerRun.id })
    return row?.id ?? null
  } catch {
    return null
  }
}

/*
 * Fail any worker_run row stuck in 'running' for longer than the bound (ING-7).
 * Called best-effort at every dispatch (run-worker endpoint) so the ledger
 * self-heals without a dedicated schedule. Fail-soft like everything here —
 * returns the number of rows reaped (0 on error).
 */
export async function reapStaleWorkerRuns(
  db: Db,
  opts: { olderThanMinutes?: number } = {},
): Promise<number> {
  const olderThanMinutes = opts.olderThanMinutes ?? STALE_RUNNING_MINUTES
  try {
    const rows = await db.execute<{ id: string }>(sql`
      UPDATE worker_run
         SET status = 'failure',
             finished_at = NOW(),
             error = ${'reaped: still running after ' + olderThanMinutes + ' minutes (wedged or killed mid-run)'}
       WHERE status = 'running'
         AND started_at < NOW() - (${olderThanMinutes} * INTERVAL '1 minute')
      RETURNING id::text AS id
    `)
    return rows.length
  } catch {
    return 0
  }
}

/*
 * Transition a previously-started run to its terminal status. No-op when
 * runId is null (the start insert failed). Fail-soft — swallows its own
 * errors so a bookkeeping failure can never break or mask the worker.
 */
export async function recordWorkerRunOutcome(
  db: Db,
  runId: string | null,
  outcome: WorkerRunOutcome,
): Promise<void> {
  if (!runId) return
  try {
    await db
      .update(workerRun)
      .set({
        status: outcome.status,
        finishedAt: new Date(),
        durationMs: outcome.durationMs,
        rowsAffected: outcome.rowsAffected ?? null,
        error: outcome.error ? outcome.error.slice(0, ERROR_MAX) : null,
        result: safeResult(outcome.result),
      })
      .where(eq(workerRun.id, runId))
  } catch {
    // Observability must not break the worker.
  }
}
