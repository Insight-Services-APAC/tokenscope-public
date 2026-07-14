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
})

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
