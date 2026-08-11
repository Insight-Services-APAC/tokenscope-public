import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core'
import { teammate } from './identity'

/*
 * telemetry_recovery_request (mig 0093) — the admin-reachable WIDENED READ queue.
 *
 * The reader's `lookbackDays` lever (default 7, max 90) is what recovers
 * already-ingested telemetry older than a week. It used to be reachable only via
 * a signed HMAC worker body, so a backlog older than seven days could not be
 * recovered from the product — and a signed re-run without the lever recovers
 * seven days while reporting success indistinguishably from a full recovery.
 *
 * An admin enqueues "re-read these instances at N days"; the telemetry-recovery
 * worker claims the row and drains it in slices within a wall-clock budget,
 * persisting cursorIndex so the next invocation resumes. That is what keeps a
 * 90-day recovery clear of the ~120s worker gateway ceiling. App-gated (no RLS).
 */
export const telemetryRecoveryRequest = pgTable(
  'telemetry_recovery_request',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** The instances to re-read, in order; consumed positionally by cursorIndex. */
    instanceIds: uuid('instance_ids').array().notNull(),
    /** The reader's OUTER scan bound for this recovery (1..90). */
    lookbackDays: integer('lookback_days').notNull(),
    /** Resume point: how many of instanceIds are fully processed. */
    cursorIndex: integer('cursor_index').notNull().default(0),

    status: text('status').notNull().default('pending'), // pending|running|succeeded|failed
    /** Operator's note — why this recovery was run. */
    reason: text('reason'),
    requestedBy: uuid('requested_by').references(() => teammate.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Outcome — so "did it recover anything" is answerable from the row, not inferred. */
    instancesProcessed: integer('instances_processed').notNull().default(0),
    rowsWritten: integer('rows_written').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    error: text('error'),
    runId: uuid('run_id'),
  },
  (t) => [index('telemetry_recovery_request_claim_idx').on(t.status, t.requestedAt)],
)
