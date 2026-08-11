/*
 * reporting_snapshot (mig 0128) — what a calendar month looked like when it was
 * recorded. Replaces `finance_period`.
 *
 * A RECORD, NOT A LOCK. Ingestion, provider re-polls and governance recompute
 * all proceed on a recorded month exactly as on any other; a month that
 * subsequently moves reports its delta against this row. Absence of a row means
 * the month has never been recorded, which is not a state anything branches on.
 *
 * `basis` and `snapshot_version` exist so a delta can REFUSE to subtract when
 * the two figures answer different questions. The CHECK on `basis` and the
 * first-of-month CHECK live in the migration — Drizzle cannot render them.
 *
 * See server/governance/reporting-snapshot.ts and
 * docs/design/close-is-a-snapshot.md.
 */
import { pgTable, date, numeric, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { teammate } from './identity'

export const reportingSnapshot = pgTable('reporting_snapshot', {
  periodMonth: date('period_month').primaryKey(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by').references(() => teammate.id),
  basis: text('basis').notNull().default('project-homed'), // 'person-placed' | 'project-homed'
  snapshotVersion: smallint('snapshot_version').notNull().default(1),
  attributedUsd: numeric('attributed_usd', { precision: 14, scale: 6 }).notNull().default('0'),
  chargeableUsd: numeric('chargeable_usd', { precision: 14, scale: 6 }).notNull().default('0'),
  exemptUsd: numeric('exempt_usd', { precision: 14, scale: 6 }).notNull().default('0'),
})
