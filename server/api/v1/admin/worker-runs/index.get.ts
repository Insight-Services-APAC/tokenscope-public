/*
 * GET /api/v1/admin/worker-runs — paginated worker-execution history.
 *
 * RBAC: requireRole(admin, global-finops). ADMIN-GLOBAL (no region clamp):
 * worker_run.region_id is never set by the dispatch path, so worker execution is an
 * operational/global signal (matches the Diagnostics panel), not region data.
 *
 * The Diagnostics page shows the LATEST run per worker (RAG health); this is the
 * history + drill-down it lacks. Per-run `warnings` are derived from the persisted
 * result (scopes errored, credentials missing, lines skipped); the full result object
 * is on the [id] detail endpoint, not the list.
 *
 * Filters: worker, status. Pagination: limit (default 50, max 200) + offset.
 *
 * `?summary=24h` returns `{ summary: [...] }` INSTEAD of the run list — an
 * aggregate has no pagination and mixing the two shapes would make every list
 * consumer carry a mode it never requested. Per-worker duty-cycle aggregates
 * over runs STARTED in the trailing 24 h
 * (docs/design/performance-observability-baseline.md O4, dr-M8): terminal
 * completed runs count — status 'success' or 'failure' (the design says
 * "error"; 'failure' is this ledger's spelling) with finished_at set;
 * 'skipped' rows and still-running rows (finished_at NULL) are excluded.
 * A reaped run (run-health.ts) is a 'failure' with NULL duration_ms: its
 * finished_at - started_at span IS its p50/max/busy contribution (r3-M3 —
 * the reap stamps finished_at at reap time, so the span is the wedge, and a
 * worker wedged for hours must show hours, never 0). Served by the
 * (started_at) index (mig 0137).
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { deriveRunWarnings } from '../../../../reconciliation/run-warnings'

const Query = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  worker: z.string().max(120).optional(),
  status: z.enum(['running', 'success', 'failure']).optional(),
  // '24h' is the only window O4 specifies; a literal keeps the contract closed.
  summary: z.literal('24h').optional(),
})

interface SummaryRow extends Record<string, unknown> {
  worker_name: string
  runs: number
  p50_ms: number | null
  max_ms: number | null
  busy_ms: number
}

interface Row extends Record<string, unknown> {
  id: string
  worker_name: string
  status: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  rows_affected: number | null
  has_error: boolean
  result: unknown
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const query = await getValidated(event, Query)

  if (query.summary) {
    // Population per dr-M8 (see header): started in the trailing 24 h, finished,
    // terminal 'success' | 'failure'. p50 via percentile_cont (interpolating —
    // an even-count set yields the midpoint, not a member). A REAPED run
    // (failure with finished_at stamped at reap but duration_ms NULL) uses
    // finished_at - started_at (r3-M3): a worker wedged for hours must show
    // as hours of busy time, never 0.
    const summaryRows = await withRequestRls(event, async (tx) => {
      const rows = await tx.execute<SummaryRow>(sql`
        SELECT wr.worker_name,
               COUNT(*)::int AS runs,
               ROUND(percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY COALESCE(wr.duration_ms,
                   EXTRACT(EPOCH FROM (wr.finished_at - wr.started_at)) * 1000)
               ))::int AS p50_ms,
               MAX(COALESCE(wr.duration_ms,
                 EXTRACT(EPOCH FROM (wr.finished_at - wr.started_at)) * 1000))::int AS max_ms,
               COALESCE(SUM(COALESCE(wr.duration_ms,
                 EXTRACT(EPOCH FROM (wr.finished_at - wr.started_at)) * 1000)), 0)::int AS busy_ms
        FROM worker_run wr
        WHERE wr.started_at >= NOW() - INTERVAL '24 hours'
          AND wr.finished_at IS NOT NULL
          AND wr.status IN ('success', 'failure')
        GROUP BY wr.worker_name
        ORDER BY wr.worker_name
      `)
      return [...rows]
    })
    return {
      summary: summaryRows.map((r) => ({
        workerName: r.worker_name,
        runs: r.runs,
        p50Ms: r.p50_ms,
        maxMs: r.max_ms,
        busyMs: r.busy_ms,
      })),
    }
  }

  const workerClause = query.worker ? sql`AND wr.worker_name = ${query.worker}` : sql``
  const statusClause = query.status ? sql`AND wr.status = ${query.status}` : sql``

  const { rows, total } = await withRequestRls(event, async (tx) => {
    const dataRows = await tx.execute<Row>(sql`
      SELECT wr.id::text AS id,
             wr.worker_name,
             wr.status,
             wr.started_at,
             wr.finished_at,
             wr.duration_ms,
             wr.rows_affected,
             (wr.error IS NOT NULL) AS has_error,
             wr.result
      FROM worker_run wr
      WHERE TRUE
        ${workerClause}
        ${statusClause}
      ORDER BY wr.started_at DESC, wr.id DESC
      LIMIT ${query.limit} OFFSET ${query.offset}
    `)
    const countRows = await tx.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total
      FROM worker_run wr
      WHERE TRUE
        ${workerClause}
        ${statusClause}
    `)
    return { rows: [...dataRows], total: Number([...countRows][0]?.total ?? 0) }
  })

  return {
    runs: rows.map((r) => ({
      id: r.id,
      worker: r.worker_name,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.duration_ms,
      rowsAffected: r.rows_affected,
      hasError: r.has_error,
      warnings: deriveRunWarnings(r.result),
    })),
    total,
    limit: query.limit,
    offset: query.offset,
  }
})
