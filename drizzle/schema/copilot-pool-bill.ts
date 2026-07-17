import { sql } from 'drizzle-orm'
import { pgTable, uuid, date, integer, numeric, timestamp, jsonb } from 'drizzle-orm/pg-core'
import { orgUnit } from './identity'
import { providerEnterprise, providerOrg } from './governance'

/*
 * copilot_pool_bill (mig 0080) — the per-(enterprise, org, month) POOLED Copilot bill, READ
 * from the enterprise billing usage report (never recomputed).
 *
 * Copilot's bill is pooled per (org, sku) with NO per-user field, so it cannot live in
 * actual_spend (teammate_id NOT NULL). This is the sibling grain: one row per
 * (enterprise, org, month) carrying the bill's own net lines, homed to a cost-owning unit via
 * the provider_org → CoU map. The copilot-pool-bill worker is the writer (a reader, not a
 * calculator — every figure is read straight off the bill). See
 * docs/design/provider-billing-attribution-model.md §B.
 *
 *   - license_net_usd        = "Copilot Enterprise" SKU NET (the seat license). NULL = SKU line
 *                              ABSENT → no license charge, worker alerts, month reports unsettled.
 *   - overage_net_usd        = AI-Credits / Cloud-Agent SKU NET (pooled chargeable authority).
 *   - unclassified_net_usd   = NET of Copilot lines matching neither classifier (mig 0085).
 *                              Visible as the copilot-unclassified chargeback lane; NEVER
 *                              chargeable; > 0 raises a copilot-bill-unclassified alert.
 *   - included_allowance_usd = the `included` discount line (the pool allowance; context).
 *   - usage_gross_usd        = gross AI-credit consumption (context / unsettled signal).
 *   - provider_org_id NULL   = the single explicit unallocated enterprise-residual line.
 *   - cost_owning_unit_id NULL = unmapped org OR residual → visible unallocated bucket.
 */
export const copilotPoolBill = pgTable('copilot_pool_bill', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  month: date('month').notNull(),
  providerEnterpriseId: uuid('provider_enterprise_id')
    .notNull()
    .references(() => providerEnterprise.id),
  providerOrgId: uuid('provider_org_id').references(() => providerOrg.id),
  costOwningUnitId: uuid('cost_owning_unit_id').references(() => orgUnit.id),
  seats: integer('seats'),
  licenseNetUsd: numeric('license_net_usd', { precision: 14, scale: 6 }),
  includedAllowanceUsd: numeric('included_allowance_usd', { precision: 14, scale: 6 }),
  usageGrossUsd: numeric('usage_gross_usd', { precision: 14, scale: 6 }),
  overageNetUsd: numeric('overage_net_usd', { precision: 14, scale: 6 }),
  unclassifiedNetUsd: numeric('unclassified_net_usd', { precision: 14, scale: 6 })
    .notNull()
    .default('0'),
  pulledAt: timestamp('pulled_at', { withTimezone: true }).notNull().defaultNow(),
  rawPayload: jsonb('raw_payload'),
})
