/*
 * directory_exclusion_pattern (mig 0083) — admin-configurable UPN glob patterns
 * for directory accounts that must never become teammates (privileged/service
 * accounts). Portable/open-source: the org edits this data; nothing is
 * hardcoded. Matched accounts are excluded from people-pickers, refused on
 * assign, and (opt-in) retro-cleaned. Matcher: server/utils/directory-exclusions.ts.
 *
 * CONSTRAINTS LIVE IN THE MIGRATION (0083), NOT this model: the
 * lower(pattern) unique index and the RLS policies are hand-written SQL that
 * Drizzle can't render. Do NOT `drizzle-kit generate` against this model and
 * ship its output, or those guarantees are silently dropped.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'
import { teammate } from './identity'

export const directoryExclusionPattern = pgTable('directory_exclusion_pattern', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  pattern: text('pattern').notNull(),
  note: text('note'),
  createdBy: uuid('created_by').references(() => teammate.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
