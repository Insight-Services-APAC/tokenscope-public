import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, date, integer, timestamp, index } from 'drizzle-orm/pg-core'
import { teammate } from './identity'

/*
 * reconciliation_backfill_request (mig 0074) — the on-demand backfill queue.
 *
 * An admin enqueues "pull provider usage for this org/enterprise from start_date to today"; the
 * reconciliation-backfill worker claims a pending (or stale-running) row, runs the adapter pull +
 * engine + §A reconcile over the window, and stamps status/rows_written. App-gated (no RLS).
 */
export const reconciliationBackfillRequest = pgTable(
  'reconciliation_backfill_request',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    provider: text('provider').notNull(), // 'anthropic' | 'github'
    targetKind: text('target_kind').notNull(), // 'org' | 'enterprise'
    externalRef: text('external_ref').notNull(), // external_org_id | enterprise external_id (lowercase)
    displayName: text('display_name'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    cursorDate: date('cursor_date'), // resume point: pulled through cursor_date - 1; NULL until first claim

    status: text('status').notNull().default('pending'), // pending|running|succeeded|failed
    requestedBy: uuid('requested_by').references(() => teammate.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }), // last-touched heartbeat (observability)
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    rowsWritten: integer('rows_written').notNull().default(0),
    error: text('error'),
    runId: uuid('run_id'),
  },
  (t) => [index('reconciliation_backfill_request_claim_idx').on(t.status, t.requestedAt)],
)
