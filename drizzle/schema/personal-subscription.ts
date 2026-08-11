/*
 * personal_subscription_declaration (mig 0105) — teammate self-declared
 * personal-subscription usage (ADR-0011 D3/D4, design §4.3). See
 * server/api/v1/me/personal-subscription.{get,put}.ts and
 * server/usage/over-emission-detection.ts (the corroboration carve-out).
 *
 * CONSTRAINT LIVES IN THE MIGRATION (0105), NOT this model: the partial
 * unique index (one ACTIVE row per (teammate, tool)) is hand-written SQL
 * Drizzle can't render.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, numeric, timestamp } from 'drizzle-orm/pg-core'
import { teammate } from './identity'

export const personalSubscriptionDeclaration = pgTable('personal_subscription_declaration', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => teammate.id),
  tool: text('tool').notNull(),
  subscriptionType: text('subscription_type').notNull(),
  monthlyCostUsd: numeric('monthly_cost_usd', { precision: 10, scale: 2 }).notNull(),
  declaredAt: timestamp('declared_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})
