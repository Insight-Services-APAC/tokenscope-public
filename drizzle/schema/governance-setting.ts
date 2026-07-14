/*
 * governance_setting (mig 0049) — platform-settable, region-overridable
 * thresholds ("dials") for the live detection mechanisms: the velocity spike
 * flag and the reconciliation gap/epsilon/lag dials. Keyed rows (one per
 * (key, scope)) rather than a column-per-dial table, with a typed
 * value_numeric — NOT jsonb. Scope precedence region → platform; the
 * migration seeds one platform row per key as the editable baseline.
 * Canonical key names + bounds live in server/utils/governance-settings.ts.
 *
 * CONSTRAINTS LIVE IN THE MIGRATION (0049), NOT this model: the scope-shape
 * CHECK and the two partial-unique indexes (one platform row per key, one
 * row per (key, region)) are hand-written SQL that Drizzle can't render.
 * Migrations here are hand-authored and applied by drizzle/migrate.ts — do
 * NOT run `drizzle-kit generate` against this model and ship its output, or
 * those integrity guarantees are silently dropped.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, numeric, timestamp } from 'drizzle-orm/pg-core'
import { region, teammate } from './identity'

export const governanceSetting = pgTable('governance_setting', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  key: text('key').notNull(), // e.g. 'velocity.spike_threshold'
  scopeType: text('scope_type').notNull(), // 'platform' | 'region'
  scopeId: uuid('scope_id').references(() => region.id), // NULL for platform
  valueNumeric: numeric('value_numeric').notNull(),
  updatedBy: uuid('updated_by').references(() => teammate.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
