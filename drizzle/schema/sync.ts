import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core'
import { teammate } from './identity'

export const syncConflict = pgTable('sync_conflict', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  connectorId: text('connector_id').notNull(),
  targetTable: text('target_table').notNull(),
  targetPk: uuid('target_pk').notNull(),
  manualRowSnapshot: jsonb('manual_row_snapshot').notNull(),
  syncRowPayload: jsonb('sync_row_payload').notNull(),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  resolution: text('resolution').notNull().default('pending'),
  decidedBy: uuid('decided_by').references(() => teammate.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  auditEventId: uuid('audit_event_id'),
  notes: text('notes'),
})
