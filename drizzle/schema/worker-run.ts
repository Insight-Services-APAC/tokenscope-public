/*
 * worker_run — per-dispatch execution-health ledger for the worker
 * scheduler.
 *
 * Motivation: the diagnostics freshness panel measures DATA recency
 * (max ts_recorded) and so reports "flowing" green even when a worker
 * cron is FAILING every run (a partially-completing worker still
 * advances the ledger). This table records the OUTCOME of each worker
 * dispatch so the operator can see a worker that is failing even while
 * data still trickles in. Written by the run-worker HTTP endpoint
 * (server/api/v1/internal/run-worker/[name].post.ts) — one row per
 * dispatch, transitioned running → success | failure.
 *
 * Index (worker_name, started_at DESC) backs the latest-per-worker read
 * in the diagnostics endpoint (DISTINCT ON / window function). Index
 * (started_at) backs the all-workers trailing-24 h duty-cycle summary
 * (mig 0137; docs/design/performance-observability-baseline.md O4) —
 * the name-leading index cannot serve that range scan.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, timestamp, index, jsonb } from 'drizzle-orm/pg-core'

export const workerRun = pgTable(
  'worker_run',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workerName: text('worker_name').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    // 'running' | 'success' | 'failure'
    status: text('status').notNull(),
    durationMs: integer('duration_ms'),
    rowsAffected: integer('rows_affected'),
    // Truncated (~500 chars) failure message — never a secret. Nullable.
    error: text('error'),
    // Region scoping is not relevant for most workers; nullable.
    regionId: uuid('region_id'),
    // The worker's full returned result object (generic). Size-capped + fail-soft on
    // write (server/workers/run-health.ts). Powers the per-run drill-down: scopes
    // run/errored, disposition counts, skipped lines, etc. Nullable (legacy rows).
    result: jsonb('result'),
  },
  (t) => [
    index('worker_run_name_started_idx').on(t.workerName, t.startedAt.desc()),
    index('worker_run_started_at_idx').on(t.startedAt),
  ],
)
