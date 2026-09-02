/*
 * telemetry-recovery worker — drains the admin widened-read queue (mig 0093).
 *
 * WHAT IT RECOVERS. `azure-monitor-read` reads each instance bounded by the
 * reader's OUTER scan window, which defaults to 7 days. Telemetry that was
 * ingested longer ago than that — the shape of the joiner dead-zone incident,
 * where weeks of already-ingested spend sat unjoined — is simply not reachable by
 * the scheduled tick. The reader has always accepted a wider `lookbackDays` (up to
 * 90, the longest retention we provision); nothing an admin could touch ever
 * passed it.
 *
 * THE TWO NON-NEGOTIABLE PAIRINGS, both enforced here rather than documented:
 *   1. deepRescan — a widened read WITHOUT it is near-useless and fails SILENTLY.
 *      The per-instance watermark bounds each read to events newer than the last
 *      attributed one, and after a deploy that watermark is already fresh, so the
 *      query scans 90 days and returns almost nothing while every progress field
 *      reads green. This worker always passes deepRescan.
 *   2. scope — a widened read of the whole fleet is a self-DoS, not a recovery.
 *      Requests carry an explicit instance list; there is no unscoped path.
 * (The same two rules are enforced for the signed HMAC body in run-worker-opts.ts.
 *  Two call sites, one rule — if you change one, change the other.)
 *
 * WHY IT IS RESUMABLE. The run-worker HTTP endpoint sits behind a ~120s gateway
 * (observed: a 187s slice 504'd while its handler kept running and held the
 * single-flight lock, so every later call 409s). A widened read across a set of
 * instances will exceed that. So, exactly as reconciliation-backfill does for
 * provider pulls, this claims one request and processes it in SLICES within a
 * wall-clock budget, persisting cursor_index after each slice. A budget-exhausted
 * invocation returns 'running' and the next cron tick resumes from the cursor. No
 * single invocation is long.
 *
 * SAFE TO RUN ALONGSIDE THE SCHEDULED JOINER. Each worker holds its OWN
 * single-flight lock, so this and azure-monitor-read can overlap on the same
 * instance. That is fine and deliberate: the joiner's write is
 * onConflictDoNothing against the dedup index, so a doubly-read event is written
 * once. Recovery must not have to wait for a quiet moment.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { runReadJoiner } from './azure-monitor-reader'
import { getTelemetryReader, type TelemetryReader } from '../azure/reader'
import { consola } from 'consola'

type Db = PostgresJsDatabase<typeof schema>

/*
 * Instances per slice.
 *
 * The bound is DATA VOLUME. run-worker-opts.ts sizes a single signed widened run
 * at 50 instances x 90 days (~4,500 instance-days, about 1.3x the unattended daily
 * deep pass the gateway demonstrably tolerates). A slice here is an order of
 * magnitude smaller — 5 x 90d = 450 instance-days — because it must fit inside a
 * BUDGET with room to spare, not merely inside the ceiling. The budget then packs
 * as many slices as fit, so a small recovery still drains in one tick.
 */
export const RECOVERY_CHUNK_INSTANCES = 5

/** Per-invocation budget (ms). Checked AFTER a slice, so a claim always progresses. */
export const RECOVERY_BUDGET_MS = 30_000

export interface TelemetryRecoveryResult {
  claimed: number
  requestId: string | null
  status: 'succeeded' | 'failed' | 'running' | null
  instancesProcessed: number
  rowsWritten: number
  errors: number
  /**
   * The window the reader ACTUALLY applied, read back from the reader rather than
   * recomputed. Evidence, not a restatement of intent: the whole failure mode this
   * feature addresses is a run that reports success while having silently applied
   * a narrower window than asked for.
   */
  lookbackDaysApplied: number | null
}

interface ClaimedRecovery extends Record<string, unknown> {
  id: string
  instance_ids: string[]
  lookback_days: number
  cursor_index: number
}

export async function runTelemetryRecovery(
  db: Db,
  opts?: {
    now?: Date
    runId?: string | null
    budgetMs?: number
    /**
     * Reader factory seam. Production passes nothing and gets the configured
     * reader; tests inject a stub. Takes lookbackDays so the injected reader is
     * built the same way the real one is — a seam that ignored the window would
     * make the tests unable to catch the exact bug this worker exists to prevent.
     */
    readerFor?: (lookbackDays: number) => TelemetryReader
  },
): Promise<TelemetryRecoveryResult> {
  const now = opts?.now ?? new Date()
  const runId = opts?.runId ?? null
  const budgetMs = opts?.budgetMs ?? RECOVERY_BUDGET_MS
  const readerFor = opts?.readerFor ?? ((lookbackDays: number) => getTelemetryReader({ lookbackDays }))

  // Claim a request: prefer an in-progress 'running' row (continue it) over a
  // fresh 'pending' one, so a partially-drained campaign finishes before a new one
  // starts. SKIP LOCKED + the per-worker dispatch lock keep this single-flight.
  const claimedRows = await db.execute<ClaimedRecovery>(sql`
    UPDATE telemetry_recovery_request
       SET status = 'running',
           claimed_at = now(),
           started_at = COALESCE(started_at, now()),
           run_id = ${runId},
           error = NULL
     WHERE id = (
       SELECT id FROM telemetry_recovery_request
        WHERE status IN ('pending', 'running')
        ORDER BY (status = 'running') DESC, requested_at
          FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING id::text AS id,
              instance_ids::text[] AS instance_ids,
              lookback_days,
              cursor_index
  `)
  const req = claimedRows[0]
  if (!req) {
    return {
      claimed: 0,
      requestId: null,
      status: null,
      instancesProcessed: 0,
      rowsWritten: 0,
      errors: 0,
      lookbackDaysApplied: null,
    }
  }

  const ids = [...req.instance_ids]
  let cursor = Math.max(0, Math.min(Number(req.cursor_index) || 0, ids.length))
  let processedThisRun = 0
  let rowsThisRun = 0
  let errorsThisRun = 0
  let lookbackDaysApplied: number | null = null

  try {
    /*
     * WALL CLOCK, deliberately — not the injectable `now`.
     *
     * The budget bounds REAL elapsed time so the run finishes inside the
     * ~120s gateway ceiling; it is not a business timestamp. Deriving the
     * deadline from `now` while checking it against Date.now() mixes two
     * clocks: an injected `now` in the past (any test, or a future caller
     * passing a fixed clock) makes the very first check exceed the deadline,
     * so the worker drains ZERO slices and still reports a clean, resumable
     * run — a silent no-op wearing a green tick. `now` keeps its job of
     * stamping rows; this measures duration.
     */
    const deadline = Date.now() + budgetMs
    /*
     * ONE reader for the whole run, not one per slice.
     *
     * The Azure client/credential memo is PER READER INSTANCE. `getTelemetryReader`
     * now returns one instance per config (reader.ts memoisedReader), so a per-slice
     * call would resolve to the same reader anyway — but `readerFor` is injectable
     * and a test double need not memoise, so the hoist stays: one reader, one
     * credential handshake per run.
     *
     * Safe to hoist: `req.lookback_days` is a column of this request row and does
     * not change while we drain it, so the applied window still cannot drift from
     * the requested one — the property the per-slice build was protecting.
     */
    const reader = readerFor(req.lookback_days)
    while (cursor < ids.length) {
      const slice = ids.slice(cursor, cursor + RECOVERY_CHUNK_INSTANCES)
      const result = await runReadJoiner(db, reader, {
        sessionIds: slice,
        // See the header: without this the watermark silently bounds the widened
        // read to almost nothing while every progress field still reads green.
        deepRescan: true,
        // EQUIVALENT MUTANT, deliberately kept (mutation sweep: this line
        // survives). Nothing downstream reads it on this path — the JoinResult is
        // consumed here, not persisted as azure-monitor-read's worker_run.result,
        // and the recovery request row is the authoritative scope record. It stays
        // because it is TRUE (these ids came from an operator, not the scheduled
        // selection) and because passing the joiner a false statement to save one
        // line is how a future reader of that result gets misled.
        scoped: true,
        now,
      })
      // Read back what the reader APPLIED (it clamps), never what we asked for.
      lookbackDaysApplied = result.lookbackDaysApplied ?? lookbackDaysApplied
      rowsThisRun += result.attributionRowsWritten
      errorsThisRun += result.errors
      // Advance by the SLICE size, not by result.sessionsProcessed: the joiner
      // legitimately skips ids its own gates exclude (purged, revoked teammate),
      // and advancing by the processed count would park the cursor on a skipped id
      // forever — an infinite campaign that never finishes.
      cursor += slice.length
      processedThisRun += slice.length

      await db.execute(sql`
        UPDATE telemetry_recovery_request
           SET cursor_index = ${cursor},
               instances_processed = ${cursor},
               rows_written = rows_written + ${result.attributionRowsWritten},
               errors = errors + ${result.errors},
               claimed_at = now()
         WHERE id = ${req.id}::uuid
      `)
      if (Date.now() >= deadline) break // budget spent — resume next invocation
    }

    if (cursor >= ids.length) {
      await db.execute(sql`
        UPDATE telemetry_recovery_request
           SET status = 'succeeded', finished_at = now()
         WHERE id = ${req.id}::uuid
      `)
      return {
        claimed: 1,
        requestId: req.id,
        status: 'succeeded',
        instancesProcessed: processedThisRun,
        rowsWritten: rowsThisRun,
        errors: errorsThisRun,
        lookbackDaysApplied,
      }
    }
    // Budget exhausted mid-campaign — stay 'running'; the next tick resumes.
    return {
      claimed: 1,
      requestId: req.id,
      status: 'running',
      instancesProcessed: processedThisRun,
      rowsWritten: rowsThisRun,
      errors: errorsThisRun,
      lookbackDaysApplied,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db.execute(sql`
      UPDATE telemetry_recovery_request
         SET status = 'failed', finished_at = now(), error = ${message.slice(0, 2000)}
       WHERE id = ${req.id}::uuid
    `)
    consola.warn(`[telemetry-recovery] request ${req.id} failed: ${message}`)
    return {
      claimed: 1,
      requestId: req.id,
      status: 'failed',
      instancesProcessed: processedThisRun,
      rowsWritten: rowsThisRun,
      errors: errorsThisRun,
      lookbackDaysApplied,
    }
  }
}
