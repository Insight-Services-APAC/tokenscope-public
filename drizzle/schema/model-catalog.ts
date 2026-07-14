/*
 * model_catalog (mig 0046) — the ANALYTICS authority for model tier
 * classification (frontier | workhorse | lightweight | specialised).
 * Resolution: SUBSTRING match of model_pattern against lower(model), first
 * match by sort_order ASC. Unmatched models stay UNCLASSIFIED — detectors
 * guard on classified_ratio so unknown models never fabricate a finding.
 * Display naming remains the UI's useModelDisplay; this drives the
 * frontier-share detector and swap rationale (brief §6.2).
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core'

export const modelCatalog = pgTable('model_catalog', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  modelPattern: text('model_pattern').notNull().unique(),
  displayName: text('display_name').notNull(),
  family: text('family').notNull(),
  tier: text('tier').notNull(),
  sortOrder: integer('sort_order').notNull().default(100),
  isActive: boolean('is_active').notNull().default(true),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
