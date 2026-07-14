import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, date, numeric, bigint, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { teammate, region, orgUnit } from './identity'
import { project } from './projects'

/*
 * over_emission (mig 0072) — the integrity counterpart of unaccounted_usage: per
 * (teammate, day, tool) UNCORROBORATED OTel excess = max(0, OTel − provider API truth).
 * Flagged for the developer to review and either quarantine the suspect session or
 * escalate. Claude-only until a per-teammate-day Copilot API truth exists. See
 * docs/design/provider-billing-attribution-model.md §A + ADR-0010 rule 2 / ADR-0008.
 */
export const overEmission = pgTable(
  'over_emission',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    teammateId: uuid('teammate_id')
      .notNull()
      .references(() => teammate.id),
    regionId: uuid('region_id').references(() => region.id),
    orgUnitId: uuid('org_unit_id').references(() => orgUnit.id),
    day: date('day').notNull(),
    tool: text('tool').notNull(),
    otelUsd: numeric('otel_usd', { precision: 14, scale: 6 }).notNull(),
    apiUsd: numeric('api_usd', { precision: 14, scale: 6 }).notNull(),
    overUsd: numeric('over_usd', { precision: 14, scale: 6 }).notNull(),
    state: text('state').notNull().default('open'),
    quarantinedConversationId: text('quarantined_conversation_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => teammate.id),
    resolvedOverUsd: numeric('resolved_over_usd', { precision: 14, scale: 6 }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('over_emission_teammate_day_tool_unique').on(t.teammateId, t.day, t.tool)],
)

/*
 * unaccounted_usage (mig 0071) — per-(teammate, day, tool) reconciliation of the
 * provider usage API (the COMPLETE truth) against what OTel actually captured.
 * `cost_usd` = max(0, API daily total − Σ OTel captured that day). Surfaced as ONE
 * taggable record per (teammate, day, tool) in the needs-tagging flow; `project_id`
 * NULL = still needs tagging. See docs/design/provider-billing-attribution-model.md §A.
 * Attribution (usage completeness), NOT chargeback.
 */
export const unaccountedUsage = pgTable(
  'unaccounted_usage',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    teammateId: uuid('teammate_id')
      .notNull()
      .references(() => teammate.id),
    regionId: uuid('region_id').references(() => region.id),
    orgUnitId: uuid('org_unit_id').references(() => orgUnit.id),
    day: date('day').notNull(),
    tool: text('tool').notNull(),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull(),
    tokens: bigint('tokens', { mode: 'bigint' }).notNull().default(0n),
    projectId: uuid('project_id').references(() => project.id),
    activity: text('activity'),
    source: text('source').notNull().default('api-reconciled'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    taggedAt: timestamp('tagged_at', { withTimezone: true }),
    taggedBy: uuid('tagged_by').references(() => teammate.id),
  },
  (t) => [
    uniqueIndex('unaccounted_usage_teammate_day_tool_unique').on(t.teammateId, t.day, t.tool),
    index('unaccounted_usage_teammate_day_idx').on(t.teammateId, t.day),
  ],
)
