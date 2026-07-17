/*
 * report_visibility_setting (mig 0087) — the single-row, admin-configurable
 * report-visibility policy (task #19). One logical row (`key = 'policy'`); `mode`
 * is one of REPORT_VISIBILITY_MODES. Absent row ⇒ 'standard' (fail-closed on
 * upgrade). The enforcement lives in shared/auth/report-visibility.ts +
 * server/auth/report-scope.ts.
 *
 * CONSTRAINTS LIVE IN THE MIGRATION (0087), NOT this model: the `key = 'policy'`
 * and `mode IN (...)` CHECKs and the RLS policies are hand-written SQL Drizzle
 * can't render. Migrations here are hand-authored and applied by drizzle/migrate.ts
 * — do NOT `drizzle-kit generate` against this model and ship its output, or those
 * guarantees are silently dropped.
 */
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'
import { teammate } from './identity'

export const reportVisibilitySetting = pgTable('report_visibility_setting', {
  key: text('key').primaryKey().default('policy'),
  mode: text('mode').notNull(),
  updatedBy: uuid('updated_by').references(() => teammate.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
