/*
 * governance_cutover_state (mig 0104) — singleton (id=1) whole-system
 * GitHub-heuristic -> governance-data cutover state machine. See
 * server/governance/cutover.ts for preflight/activate/rollback, and
 * drizzle/migrations/0104_governance_cutover_state.sql for the status CHECK
 * and the provider_org billing-lock trigger Drizzle can't render.
 */
import { pgTable, smallint, text, jsonb, timestamp, uuid } from 'drizzle-orm/pg-core'
import { teammate } from './identity'

export const governanceCutoverState = pgTable('governance_cutover_state', {
  id: smallint('id').primaryKey().default(1),
  // 'not_started' | 'preflight_verified' | 'activated' | 'rolled_back'
  status: text('status').notNull().default('not_started'),
  preflightSnapshot: jsonb('preflight_snapshot'),
  preflightVerifiedAt: timestamp('preflight_verified_at', { withTimezone: true }),
  preflightVerifiedBy: uuid('preflight_verified_by').references(() => teammate.id),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  activatedBy: uuid('activated_by').references(() => teammate.id),
  rolledBackAt: timestamp('rolled_back_at', { withTimezone: true }),
  rolledBackBy: uuid('rolled_back_by').references(() => teammate.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
