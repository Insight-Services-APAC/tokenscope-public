import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, numeric, date, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { teammate, region, orgUnit } from './identity'
import { project } from './projects'
import { workerRun } from './worker-run'

/*
 * reconciliation_record — the signed-delta reconciliation ledger (migration 0038).
 *
 * One row per (teammate|org, enterprise, day, category). `attribution_record`
 * stays the immutable OTel truth; corrections/additions live here as signed
 * `delta_usd`, and v_effective_spend (0039) = attribution + applied deltas.
 *
 * NOTE: the open-record PARTIAL unique index (one 'proposed' row per logical key)
 * and the COALESCE(teammate_id) expression are hand-written in 0038 — Drizzle
 * can't express partial / expression indexes, so this def omits them. 0038 is the
 * source of truth (same pattern as attribution_record's dedup index vs 0035).
 */
export const reconciliationRecord = pgTable(
  'reconciliation_record',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // NULL for scope='org' (untaggable org-grain web/code-exec lines).
    teammateId: uuid('teammate_id').references(() => teammate.id),
    provider: text('provider').notNull(), // 'anthropic' | 'github'
    enterpriseRef: text('enterprise_ref').notNull(), // anthropic org id | github enterprise slug
    licenseOrg: text('license_org'), // seat.organization for GitHub; NULL for Anthropic
    periodDate: date('period_date').notNull(), // UTC daily grain
    category: text('category').notNull(),
    scope: text('scope').notNull().default('teammate'), // 'teammate' | 'org'
    // Denormalised dimensions (engine fills from the teammate) so v_effective_spend
    // is a clean union with attribution_record and the region clamp keeps working.
    regionId: uuid('region_id').references(() => region.id),
    orgUnitId: uuid('org_unit_id').references(() => orgUnit.id),
    costOwningUnitId: uuid('cost_owning_unit_id').references(() => orgUnit.id),
    projectId: uuid('project_id').references(() => project.id), // margin overlay (never gates the charge)
    activity: text('activity'),
    // Reconcile in the native unit; USD is the booked figure.
    actualQty: numeric('actual_qty', { precision: 20, scale: 6 }),
    actualUnitType: text('actual_unit_type'), // 'tokens' | 'ai-credits'
    actualUsd: numeric('actual_usd', { precision: 14, scale: 6 }).notNull(),
    otelAttributedUsd: numeric('otel_attributed_usd', { precision: 14, scale: 6 }).notNull(),
    deltaUsd: numeric('delta_usd', { precision: 14, scale: 6 }).notNull(),
    spendClass: text('spend_class').notNull(), // 'billed' | 'estimated' | 'indicative'
    indicativeReason: text('indicative_reason'),
    disposition: text('disposition').notNull(), // untagged|walk_back|matched|no_install|ingest_only
    status: text('status').notNull().default('proposed'), // proposed|applied|rejected|superseded
    lagState: text('lag_state'), // within_buffer|settled — only for walk_back (CHECK in 0038)
    raw: jsonb('raw'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    // NULL on hourly 'proposed' upserts; set on the state transition.
    auditEventId: uuid('audit_event_id'),
    // The worker_run that wrote this row (0042) — powers "what did this run produce?".
    // ON DELETE SET NULL is in 0042 (Drizzle def omits the FK action).
    runId: uuid('run_id').references(() => workerRun.id),
  },
  (t) => [
    index('reconciliation_record_teammate_period_idx').on(t.teammateId, t.periodDate),
    index('reconciliation_record_status_idx').on(t.status),
    index('reconciliation_record_run_id_idx').on(t.runId),
  ],
)
