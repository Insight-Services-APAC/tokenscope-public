/*
 * activity_type — the hybrid activity vocabulary's suggestion list (mig 0020).
 *
 * A NULL region_id is a global/standard entry; a region-scoped entry is that
 * region's own addition. The value stored on session_assignment /
 * attribution_record is a plain string: matching a published label aggregates
 * firm-wide, a free-form value stays a personal label (the hybrid model — see
 * docs/design/activity-tagging-attribution.md). This table is just the picker's
 * suggestion source, not a foreign-key constraint on what can be stored.
 *
 * Migration 0020 is the source of truth (hand-written SQL); this mirrors it.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, boolean, integer, timestamp } from 'drizzle-orm/pg-core'
import { region } from './identity'

export const activityType = pgTable('activity_type', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  // NULL = global/standard; set = a region's own addition.
  regionId: uuid('region_id').references(() => region.id),
  label: text('label').notNull(),
  isStandard: boolean('is_standard').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
// Uniqueness (case-insensitive, NULL region folded to one global scope) is an
// expression index created in migration 0020 — drizzle can't express it, so the
// migration is the source of truth and it's intentionally omitted here.
