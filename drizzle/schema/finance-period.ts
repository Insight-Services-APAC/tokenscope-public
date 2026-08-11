/*
 * finance_period (mig 0102) — per-calendar-month finance close state.
 * See server/governance/finance-period.ts for the close/reopen/restate
 * service and drizzle/migrations/0102_finance_period.sql for the CHECK
 * constraints (state enum, period_month first-of-month) Drizzle can't render.
 */
import { pgTable, date, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { teammate } from './identity'

export const financePeriod = pgTable('finance_period', {
  periodMonth: date('period_month').primaryKey(),
  state: text('state').notNull().default('open'), // 'open' | 'closed'
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by').references(() => teammate.id),
  reopenedAt: timestamp('reopened_at', { withTimezone: true }),
  reopenedBy: uuid('reopened_by').references(() => teammate.id),
  reopenReason: text('reopen_reason'),
  restatedAt: timestamp('restated_at', { withTimezone: true }),
  restatedBy: uuid('restated_by').references(() => teammate.id),
  restateReason: text('restate_reason'),
})
