import { sql } from 'drizzle-orm'
import { pgTable, uuid, date, text, numeric, timestamp } from 'drizzle-orm/pg-core'
import { orgUnit } from './identity'
import { providerEnterprise } from './governance'
import { workerRun } from './worker-run'

/*
 * copilot_overage_allocation (mig 0106, ADR-0011 D10) — the PERSISTED
 * per-cost-owning-unit distribution of one (enterprise, month)'s PAID pooled
 * Copilot overage (copilot_pool_bill.overage_net_usd). Allocation DISTRIBUTES
 * the already-imported overage net; it never creates or derives money. NULL
 * costOwningUnitId = the explicit unallocated bucket (paid overage with zero
 * attributable weight) -- see drizzle/migrations/0106_... for the two partial
 * unique indexes (one real-CoU-keyed, one unallocated-bucket-keyed) Drizzle
 * can't render. Idempotent delete-and-replace under the
 * copilotOverageAllocation advisory lock -- see
 * server/governance/copilot-overage-allocation.ts.
 */
export const copilotOverageAllocation = pgTable('copilot_overage_allocation', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  providerEnterpriseId: uuid('provider_enterprise_id')
    .notNull()
    .references(() => providerEnterprise.id),
  month: date('month').notNull(),
  costOwningUnitId: uuid('cost_owning_unit_id').references(() => orgUnit.id),
  policy: text('policy').notNull(),
  weight: numeric('weight', { precision: 20, scale: 6 }).notNull().default('0'),
  allocatedUsd: numeric('allocated_usd', { precision: 14, scale: 2 }).notNull(),
  overageNetUsd: numeric('overage_net_usd', { precision: 14, scale: 6 }).notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  runId: uuid('run_id').references(() => workerRun.id),
})
