/*
 * reconciliation-backfill worker — drains the on-demand backfill queue (mig 0074/0075).
 *
 * The steady-state reconciliation-sync pulls only [yesterday, today]. This worker lets an admin
 * pull a HISTORICAL window for one credential scope so §A surfaces unaccounted usage for older days.
 *
 * RESUMABLE BY DAY CHUNK: a GitHub pull is per-seat-PER-DAY, so a wide window (days × seats) blows
 * past any single request budget. The worker therefore pulls the window in CHUNK_DAYS-day slices
 * within a wall-clock BUDGET, persisting cursor_date after each slice; if the budget runs out it
 * returns with status still 'running' and the NEXT invocation resumes from cursor_date. When the
 * cursor passes end_date the window is fully pulled, so it runs the §A reconcile over the whole
 * window and marks 'succeeded'. Single-flight via the per-worker dispatch lock; chunks are
 * idempotent (engine + actual_spend/reconciliation_record upserts), so a crash mid-slice just
 * re-pulls that slice. Claims an in-progress 'running' row preferentially (continue before start).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { runReconcileEngine } from '../reconciliation/engine'
import { ADAPTER_FACTORIES } from '../reconciliation/adapters/registry'
import { resolveOrgCredential, resolveEnterpriseCredential, type ResolvedCredential } from '../reconciliation/credentials'
import {
  GOV_RECONCILIATION_EPSILON_USD,
  GOV_RECONCILIATION_LAG_BUFFER_HOURS,
  resolveGovernanceSettings,
} from '../utils/governance-settings'
import { reconcileUnaccountedUsage } from '../usage/unaccounted-reconciliation'
import { detectOverEmission } from '../usage/over-emission-detection'

type Db = PostgresJsDatabase<typeof schema>

/*
 * Slice sizing — load-bearing. The worker runs via the run-worker HTTP endpoint behind the
 * gateway, whose response timeout (~120s observed: a 187s slice 504'd; an 81s sync run returned
 * cleanly) is a HARD ceiling on an invocation. A GitHub pull is per-seat-PER-DAY, so one DAY for a
 * 54-seat enterprise is ~40s. CHUNK_DAYS=1 keeps the slice (the smallest re-pullable unit) well
 * under the ceiling for enterprises up to ~150 seats; the BUDGET then packs as many day-slices as
 * fit ~30s before returning, so small enterprises drain fast and large ones stay safe. A single
 * DAY that exceeds the gateway (a very large enterprise) is the ceiling of this HTTP-triggered
 * model — the follow-up is to run the worker IN-PROCESS in the job container (bounded by the
 * 30-min replica timeout, no gateway). The cron drains the queue incrementally either way.
 */
export const BACKFILL_CHUNK_DAYS = 1
/** Per-invocation pulling budget (ms). After each slice, stop once exceeded — stays well under the gateway. */
export const BACKFILL_BUDGET_MS = 30_000

export interface ReconcileBackfillResult {
  claimed: number
  requestId: string | null
  status: 'succeeded' | 'failed' | 'running' | null
  rowsWritten: number
}

interface ClaimedRequest extends Record<string, unknown> {
  id: string
  provider: 'anthropic' | 'github'
  external_ref: string
  start_date: string
  end_date: string
  cursor_date: string
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export async function runReconciliationBackfill(
  db: Db,
  opts?: { now?: Date; runId?: string | null; budgetMs?: number },
): Promise<ReconcileBackfillResult> {
  const now = opts?.now ?? new Date()
  const runId = opts?.runId ?? null
  const budgetMs = opts?.budgetMs ?? BACKFILL_BUDGET_MS

  // Claim a request: prefer an in-progress 'running' row (continue it) over a fresh 'pending' one.
  // SKIP LOCKED + the per-worker dispatch lock keep this single-flight. cursor_date defaults to
  // start_date on the first claim; started_at is set once.
  const claimedRows = await db.execute<ClaimedRequest>(sql`
    UPDATE reconciliation_backfill_request
    SET status = 'running', claimed_at = now(), started_at = COALESCE(started_at, now()),
        cursor_date = COALESCE(cursor_date, start_date), run_id = ${runId}, error = NULL
    WHERE id = (
      SELECT id FROM reconciliation_backfill_request
      WHERE status IN ('pending', 'running')
      ORDER BY (status = 'running') DESC, requested_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id::text AS id, provider, external_ref,
              start_date::text AS start_date, end_date::text AS end_date, cursor_date::text AS cursor_date
  `)
  const req = claimedRows[0]
  if (!req) return { claimed: 0, requestId: null, status: null, rowsWritten: 0 }

  try {
    const dials = await resolveGovernanceSettings(db, [GOV_RECONCILIATION_EPSILON_USD, GOV_RECONCILIATION_LAG_BUFFER_HOURS])
    const epsilonUsd = dials[GOV_RECONCILIATION_EPSILON_USD]
    const lagBufferHours = dials[GOV_RECONCILIATION_LAG_BUFFER_HOURS]

    // Resolve the credential + build the adapter once (mirrors reconciliation-sync per provider).
    let credential: ResolvedCredential | null
    let adapter: ReturnType<NonNullable<typeof ADAPTER_FACTORIES.github>>
    if (req.provider === 'anthropic') {
      const factory = ADAPTER_FACTORIES.anthropic
      if (!factory) throw new Error('no anthropic adapter registered')
      credential = await resolveOrgCredential(db, { provider: 'anthropic', externalOrgId: req.external_ref })
      if (!credential) throw new Error(`no resolvable credential for anthropic org '${req.external_ref}'`)
      adapter = factory(db, { externalRef: req.external_ref, credential, apiKind: credential.apiKind ?? null })
    } else {
      const factory = ADAPTER_FACTORIES.github
      if (!factory) throw new Error('no github adapter registered')
      credential = await resolveEnterpriseCredential(db, { provider: 'github', externalId: req.external_ref })
      if (!credential) throw new Error(`no resolvable credential for github enterprise '${req.external_ref}'`)
      adapter = factory(db, { externalRef: req.external_ref, credential })
    }

    // PULL PHASE: advance cursor_date through end_date in CHUNK_DAYS slices. The budget LIMITS how
    // many slices a claim does, but the check is AFTER a slice so a claim ALWAYS makes ≥1 slice of
    // progress — even if pre-loop latency already ate the budget (otherwise a slow claim could
    // livelock: pull nothing, return 'running', repeat forever).
    let cursor = req.cursor_date
    let rowsThisRun = 0
    const deadline = now.getTime() + budgetMs
    while (cursor <= req.end_date) {
      const chunkEnd = addDays(cursor, BACKFILL_CHUNK_DAYS - 1)
      const sliceEnd = chunkEnd < req.end_date ? chunkEnd : req.end_date
      const lines = await adapter.pull({ startDate: cursor, endDate: sliceEnd })
      const r = await runReconcileEngine(db, lines, { now, runId, epsilonUsd, lagBufferHours })
      rowsThisRun += r.recordsWritten
      cursor = addDays(sliceEnd, 1) // persisted below (AFTER the write) so a crash resumes from here
      await db.execute(sql`
        UPDATE reconciliation_backfill_request
        SET cursor_date = ${cursor}::date, rows_written = rows_written + ${r.recordsWritten}, claimed_at = now()
        WHERE id = ${req.id}::uuid`)
      if (Date.now() >= deadline) break // budget spent — resume the rest next invocation
    }

    if (cursor > req.end_date) {
      // WINDOW COMPLETE: close the §A loop over the whole window so older days surface as
      // unaccounted / over-emission, then mark succeeded.
      const window = { startDate: req.start_date, endDate: req.end_date }
      await reconcileUnaccountedUsage(db, window)
      // Historical backfills still compute integrity signals, but must not
      // flood a teammate's current inbox with one personal-subscription prompt
      // for every old month traversed by an administrative replay.
      await detectOverEmission(db, { ...window, dispatchPersonalPrompts: false })
      await db.execute(sql`UPDATE reconciliation_backfill_request SET status = 'succeeded', finished_at = now() WHERE id = ${req.id}::uuid`)
      return { claimed: 1, requestId: req.id, status: 'succeeded', rowsWritten: rowsThisRun }
    }
    // Budget exhausted before the window finished — leave 'running'; the next invocation resumes.
    return { claimed: 1, requestId: req.id, status: 'running', rowsWritten: rowsThisRun }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db.execute(sql`
      UPDATE reconciliation_backfill_request SET status = 'failed', finished_at = now(), error = ${message.slice(0, 2000)}
      WHERE id = ${req.id}::uuid`)
    console.warn(`[reconciliation-backfill] request ${req.id} (${req.provider}:${req.external_ref}) failed: ${message}`)
    return { claimed: 1, requestId: req.id, status: 'failed', rowsWritten: 0 }
  }
}
