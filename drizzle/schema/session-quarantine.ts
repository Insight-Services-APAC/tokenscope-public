import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  bigint,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'
import { region, orgUnit, teammate } from './identity'
import { instanceAttestation } from './instance-attestation'

/*
 * session_quarantine (migration 0032) — heartbeat-coverage / quarantined-spend.
 *
 * The persisted result of the coverage worker (server/workers/heartbeat-coverage.ts):
 * one row per (conversation, instance) whose spend is NOT covered by an
 * authenticated heartbeat. The emit channel is untrusted/public-write (the emit
 * credential is broadly readable), so anyone with an emit token can write spoofed
 * attribution_record rows claiming a victim instance_id. This table surfaces such
 * "unverified spend" EARLY (before reconciliation, which lags ~1h+) by checking
 * each session's [min,max] ts_event against its instance's authenticated-live
 * window [ts_start, last_bearer_at + grace].
 *
 * INFORMATIONAL ONLY — the worker NEVER auto-revokes or auto-deletes. Reconciliation
 * against Anthropic actuals is the only thing that wipes non-reconciling spend.
 * Catches the cross-instance spoof (no covering heartbeat); does NOT catch full
 * credential theft (thief owns the instance → heartbeats as the victim).
 */
export const sessionQuarantine = pgTable(
  'session_quarantine',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // COALESCE(claude_session_id, instance_id::text) — the conversation key.
    conversationId: text('conversation_id').notNull(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => instanceAttestation.instanceId),
    teammateId: uuid('teammate_id')
      .notNull()
      .references(() => teammate.id),
    regionId: uuid('region_id')
      .notNull()
      .references(() => region.id),
    orgUnitId: uuid('org_unit_id')
      .notNull()
      .references(() => orgUnit.id),
    // The session's observed event window (the span the heartbeat had to cover).
    sessionTsStart: timestamp('session_ts_start', { withTimezone: true }).notNull(),
    sessionTsEnd: timestamp('session_ts_end', { withTimezone: true }).notNull(),
    // The instance's authenticated-live window at detection time, for the "why".
    instanceTsStart: timestamp('instance_ts_start', { withTimezone: true }).notNull(),
    lastBearerAt: timestamp('last_bearer_at', { withTimezone: true }),
    // Spend the unverified session claims (informational; reconciliation is truth).
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    tokens: bigint('tokens', { mode: 'bigint' }).notNull().default(sql`0`),
    reason: text('reason').notNull().default('no-covering-heartbeat'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Set when a later run finds the session now covered. NULL = still quarantined.
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('session_quarantine_conv_instance_unique').on(t.conversationId, t.instanceId),
    index('session_quarantine_teammate_open_idx').on(t.teammateId),
  ],
)
