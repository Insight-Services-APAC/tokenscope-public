/*
 * GitHub enterprise-org coverage (Workstream D, mig 0108) — the persisted LATEST
 * observation tables server/reconciliation/coverage.ts's classifier writes into.
 * See drizzle/migrations/0108_github_coverage_observation.sql for the full design
 * rationale (kept as SQL comments there since the CHECK constraints + partial index
 * are not expressible in Drizzle's table builder).
 *
 * Deliberately two tables, not one: provider_org_coverage is a per-org OBSERVATION;
 * provider_enterprise_coverage_census is the enterprise-level completeness claim
 * (the denominator). Never derive one from the other.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { providerEnterprise, providerOrg } from './governance'

export const providerOrgCoverage = pgTable(
  'provider_org_coverage',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    providerEnterpriseId: uuid('provider_enterprise_id')
      .notNull()
      .references(() => providerEnterprise.id),
    orgLogin: text('org_login').notNull(),
    // 'mislinked' | 'coverage-unknown' | 'stale' | 'not-installed' | 'suspended' |
    // 'not-onboarded' | 'connected' (CHECK-enforced in the migration; Drizzle can't
    // express the CHECK, mirrors the billing/reconciliationMode precedent elsewhere).
    state: text('state').notNull(),
    providerOrgId: uuid('provider_org_id').references(() => providerOrg.id),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('provider_org_coverage_enterprise_login_unique').on(t.providerEnterpriseId, t.orgLogin)],
)

export const providerEnterpriseCoverageCensus = pgTable('provider_enterprise_coverage_census', {
  providerEnterpriseId: uuid('provider_enterprise_id')
    .primaryKey()
    .references(() => providerEnterprise.id),
  available: boolean('available').notNull(),
  capped: boolean('capped').notNull().default(false),
  // 'not-app-mode' | 'no-credential' | 'key-malformed' | 'capability-denied' |
  // 'capability-unknown' | null (CHECK-enforced in the migration).
  unavailableReason: text('unavailable_reason'),
  orgCount: integer('org_count'),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})
