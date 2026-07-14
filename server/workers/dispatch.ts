/*
 * dispatchWorker — the shared worker-run CORE that BOTH trigger surfaces run
 * identically:
 *   - the HMAC-signed machine-to-machine cron endpoint (run-worker/[name]), and
 *   - the admin-authed UI trigger (admin/workers/[name]/run).
 *
 * Callers own AUTH + entry resolution + opts parsing (they differ: HMAC vs
 * session+safelist). This owns everything that MUST be identical between them so
 * the two paths can never drift:
 *   - ING-3 single-flight: at most one concurrent run per worker name. A UI
 *     trigger firing while the cron is mid-run (or an HMAC replay) gets a clean
 *     409 no-op instead of a duplicate run (double-priced Copilot spans, dup
 *     inbox items). The lock is advisory + auto-released.
 *   - ING-7 self-healing ledger: reap any worker_run stuck in 'running' so
 *     diagnostics shows a failure, not a perpetual runner.
 *   - worker_run start/outcome bookkeeping (best-effort; never breaks the worker),
 *     and NEVER swallowing the worker's own error.
 */
import { createError } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Sql } from 'postgres'
import type * as schema from '../../drizzle/schema'
import { acquireWorkerDispatchLock } from './dispatch-lock'
import type { WorkerEntry, WorkerRunContext } from './registry'
import { reapStaleWorkerRuns, recordWorkerRunStart, recordWorkerRunOutcome } from './run-health'

// The dispatch lock reserves a raw connection off `$client`, so this needs the same
// intersection type dispatch-lock.ts uses (the bare PostgresJsDatabase omits it).
type Db = PostgresJsDatabase<typeof schema> & { $client: Sql }

export interface WorkerDispatchResult {
  worker: string
  duration_ms: number
  result: unknown
}

/*
 * Dispatch ONE already-resolved worker entry. Throws a 409 ProblemDetails when the
 * per-worker lock is already held; re-throws the worker's own error (after recording
 * a 'failure' outcome) so the caller surfaces it. The entry + opts are the caller's
 * responsibility to resolve/validate — this never looks a name up or checks a
 * safelist (that is auth-surface, and it differs per trigger).
 */
export async function dispatchWorker(
  db: Db,
  entry: WorkerEntry,
  opts?: WorkerRunContext['opts'],
): Promise<WorkerDispatchResult> {
  // ING-3: at most one concurrent run per worker name. A concurrent dispatch
  // (scheduler overlap/retry, manual + cron, or an HMAC replay inside the ±300 s
  // window) gets a 409 no-op and the caller simply tries again next tick.
  const lock = await acquireWorkerDispatchLock(db, entry.name)
  if (!lock.acquired) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Conflict',
      data: {
        type: 'https://tokenscope.example.com/errors/worker-already-running',
        title: 'Worker already running',
        status: 409,
        detail: `Worker '${entry.name}' is already being dispatched; this dispatch is a no-op.`,
      },
    })
  }

  try {
    // ING-7: fail any worker_run stuck in 'running' (a wedged HTTP call or a
    // container killed mid-run) so diagnostics shows a failure. Best-effort.
    await reapStaleWorkerRuns(db)

    const startedAt = Date.now()
    // Best-effort: a bookkeeping failure must not block the worker.
    const runId = await recordWorkerRunStart(db, entry.name)

    let result: unknown
    try {
      // Pass the run id so workers that write the reconciliation ledger can stamp
      // reconciliation_record.run_id, plus any parsed per-dispatch opts (e.g.
      // deepRescan). Both are ignored by workers that don't need them.
      result = await entry.run(db, { runId, opts })
    } catch (err) {
      const durationMs = Date.now() - startedAt
      await recordWorkerRunOutcome(db, runId, {
        status: 'failure',
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      })
      // Never swallow the worker's own error.
      throw err
    }

    const durationMs = Date.now() - startedAt
    await recordWorkerRunOutcome(db, runId, {
      status: 'success',
      durationMs,
      rowsAffected: extractRowsAffected(result),
      result,
    })

    return { worker: entry.name, duration_ms: durationMs, result }
  } finally {
    await lock.release()
  }
}

/*
 * Best-effort extraction of a "rows written" count from a worker result. Worker
 * results are heterogeneous — different workers expose different count fields — so
 * we probe a small set of known keys and return the first numeric one. Null when
 * none is present (the column is nullable).
 *
 * Deliberately EXCLUDES `sessionsProcessed`: that's the count of instances SCANNED,
 * not rows WRITTEN. Including it made a 0-write tick (e.g. the joiner scanned 50
 * sessions but wrote nothing new) record a misleading positive rowsAffected. A true
 * zero-write tick should record null/0, not the scan count.
 */
export function extractRowsAffected(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  for (const key of ['attributionRowsWritten', 'rowsAffected', 'rowsWritten', 'alertsDispatched', 'itemsEmitted']) {
    const v = r[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}
