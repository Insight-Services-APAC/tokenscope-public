import { sql } from 'drizzle-orm'
import { pgTable, uuid, numeric, text, timestamp, customType } from 'drizzle-orm/pg-core'
import { teammate } from './identity'
import { providerEnterprise } from './governance'

const tstzrange = customType<{ data: string }>({
  dataType() {
    return 'tstzrange'
  },
})

/*
 * copilot_rate_plan (mig 0106, ADR-0011 D9) — effective-dated Copilot seat
 * price + included allowance, keyed (provider_enterprise_id, effective).
 * FORECAST/SHOWBACK input ONLY: server/governance/copilot-rate-plan.ts
 * resolves the plan in force for the period being computed; NEVER used to
 * reconstruct copilot_pool_bill's bill-anchored license/overage figures. See
 * drizzle/migrations/0106_copilot_rate_plan_and_overage_allocation.sql for the
 * EXCLUDE USING gist non-overlap constraint (WHERE retired_at IS NULL) Drizzle
 * can't render.
 */
export const copilotRatePlan = pgTable('copilot_rate_plan', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  providerEnterpriseId: uuid('provider_enterprise_id')
    .notNull()
    .references(() => providerEnterprise.id),
  effective: tstzrange('effective').notNull(),
  flatSeatPriceUsd: numeric('flat_seat_price_usd', { precision: 14, scale: 6 }),
  includedAllowanceUsd: numeric('included_allowance_usd', { precision: 14, scale: 6 }),
  notes: text('notes'),
  createdBy: uuid('created_by').references(() => teammate.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
})
