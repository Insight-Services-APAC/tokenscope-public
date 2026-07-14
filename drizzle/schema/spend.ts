import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  bigint,
  numeric,
  date,
  jsonb,
  timestamp,
  boolean,
  customType,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { teammate, orgUnit } from './identity'

const tstzrange = customType<{ data: string }>({
  dataType() {
    return 'tstzrange'
  },
})

export const actualSpend = pgTable(
  'actual_spend',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    teammateId: uuid('teammate_id')
      .notNull()
      .references(() => teammate.id),
    date: date('date').notNull(),
    tool: text('tool').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'bigint' }).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'bigint' }).notNull(),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull(),
    source: text('source').notNull().default('anthropic-analytics-api'),
    // Cost-category on the adapter staging row (mig 0038). NULL = legacy (treated
    // as model_tokens). See docs/design/reconciliation-engine.md §7.4.
    category: text('category'),
    // ADR-0010 rule 5 (mig 0072): excluded from the chargeback view
    // (v_finance_bill_chargeback) but NOT showback (v_finance_bill_showback). True for
    // NFR/exempt license-orgs; Anthropic bill rows are always false.
    chargebackExempt: boolean('chargeback_exempt').notNull().default(false),
    pulledAt: timestamp('pulled_at', { withTimezone: true }).notNull().defaultNow(),
    rawPayload: jsonb('raw_payload'),
  },
  (t) => [
    uniqueIndex('actual_spend_teammate_date_tool_source_unique').on(
      t.teammateId,
      t.date,
      t.tool,
      t.source,
    ),
  ],
)

export const spillRecord = pgTable('spill_record', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: text('workspace_id').notNull(),
  invoicePeriod: tstzrange('invoice_period').notNull(),
  invoiceTotalUsd: numeric('invoice_total_usd', { precision: 14, scale: 2 }).notNull(),
  attributedTotalUsd: numeric('attributed_total_usd', { precision: 14, scale: 2 }).notNull(),
  costOwningUnitId: uuid('cost_owning_unit_id')
    .notNull()
    .references(() => orgUnit.id),
  shadowMode: boolean('shadow_mode').notNull().default(false),
  reconciliationState: text('reconciliation_state').notNull().default('open'),
})
