import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  jsonb,
  timestamp,
  boolean,
  customType,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { teammate, region, orgUnit } from './identity'

const tstzrange = customType<{ data: string }>({
  dataType() {
    return 'tstzrange'
  },
})

export const rateCard = pgTable('rate_card', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  scopeKey: text('scope_key').notNull(),
  effective: tstzrange('effective').notNull(),
  basis: text('basis').notNull(),
  provenance: jsonb('provenance').notNull(),
  version: integer('version').notNull().default(1),
  // Scope dimensions (mig 0050). region_id NULL = global card; cou_id NULL =
  // not CoU-scoped (a CoU-scoped card is always region-scoped too — CHECK in
  // the migration). Precedence contract — (cou match) > (region match) >
  // (global), temporal within each tier, version tie-break — is documented in
  // drizzle/migrations/0050_rate_card_scope.sql.
  regionId: uuid('region_id').references(() => region.id),
  couId: uuid('cou_id').references(() => orgUnit.id),
  createdBy: uuid('created_by').references(() => teammate.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
})

export const rateLine = pgTable(
  'rate_line',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    rateCardId: uuid('rate_card_id')
      .notNull()
      .references(() => rateCard.id, { onDelete: 'cascade' }),
    unit: text('unit').notNull(),
    unitQty: numeric('unit_qty', { precision: 20, scale: 6 }).notNull(),
    unitCostUsd: numeric('unit_cost_usd', { precision: 14, scale: 8 }).notNull(),
    model: text('model'),
    notes: text('notes'),
  },
  (t) => [uniqueIndex('rate_line_card_unit_model_unique').on(t.rateCardId, t.unit, t.model)],
)

export const allocation = pgTable('allocation', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  scopeType: text('scope_type').notNull(),
  scopeId: uuid('scope_id').notNull(),
  // Per-developer cap (per_dev_fixed mode): a project-scoped allocation
  // row carrying the teammate it caps. NULL = the shared pool baseline.
  teammateId: uuid('teammate_id').references(() => teammate.id),
  budgetUsd: numeric('budget_usd', { precision: 14, scale: 2 }).notNull(),
  effective: tstzrange('effective').notNull(),
  allocationKind: text('allocation_kind').notNull().default('baseline'),
  createdBy: uuid('created_by').references(() => teammate.id),
  auditEventId: uuid('audit_event_id').notNull(),
  source: text('source').notNull().default('manual'),
  isPinned: boolean('is_pinned').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
})

export const limitPolicy = pgTable('limit_policy', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  scopeType: text('scope_type').notNull(),
  scopeId: uuid('scope_id').notNull(),
  limitKind: text('limit_kind').notNull(),
  thresholdUsd: numeric('threshold_usd', { precision: 14, scale: 2 }).notNull(),
  windowSeconds: integer('window_seconds'),
  competencyTierScale: numeric('competency_tier_scale', { precision: 4, scale: 2 }),
  effective: tstzrange('effective').notNull(),
})

export const tierAssignment = pgTable('tier_assignment', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => teammate.id),
  tier: text('tier').notNull(),
  effective: tstzrange('effective').notNull(),
  assessedBy: uuid('assessed_by').references(() => teammate.id),
  evidenceLink: text('evidence_link'),
  auditEventId: uuid('audit_event_id').notNull(),
  source: text('source').notNull().default('manual'),
  isPinned: boolean('is_pinned').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
})

// provider_enterprise — credential-custody / onboarding unit above provider_org
// (migration 0038, two-level lane registry). GitHub: one manage_billing PAT per
// enterprise (credential here). Anthropic: per-org key stays on provider_org.
// See docs/design/reconciliation-engine.md §3.2.
export const providerEnterprise = pgTable(
  'provider_enterprise',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    provider: text('provider').notNull(), // 'anthropic' | 'github'
    externalId: text('external_id').notNull(), // github enterprise slug | anthropic org id
    displayName: text('display_name').notNull(),
    reconciliationMode: text('reconciliation_mode').notNull().default('indicative'),
    billing: text('billing').notNull().default('tracked'),
    credentialSecretName: text('credential_secret_name'),
    // ADR-0010 D1/D2 (mig 0072): Copilot's real billing structure, configurable per
    // enterprise. flat_seat_price_usd = whole-month flat per-seat license (NULL = no
    // flat row); included_allowance_usd = per-user AI-credit allowance in USD (NULL =
    // overage disabled). Anthropic enterprises leave both NULL (pure metered).
    flatSeatPriceUsd: numeric('flat_seat_price_usd', { precision: 14, scale: 6 }),
    includedAllowanceUsd: numeric('included_allowance_usd', { precision: 14, scale: 6 }),
    // GitHub App credential opt-in (migration 0078). NULL = PAT mode (the classic
    // enterprise manage_billing PAT, today's default). NON-NULL = App mode INTENDED:
    // the credential resolver derives kind='github-app', resolves the App PRIVATE KEY
    // from NUXT_GITHUB_APP_KEY_<NAME> (where <NAME> is credential_secret_name), and
    // FAILS LOUD if that key is absent (never silently falls back to PAT). The id
    // itself is a non-secret integer; only the private key is a secret (KV/env). See
    // docs/design/github-pat-to-github-app-transition.md.
    githubAppId: text('github_app_id'),
    // ADR-0011 D10 (mig 0106): how a PAID pooled overage is DISTRIBUTED across
    // cost-owning units. 'consumption-share' | 'excess-share' | 'excess-equal' |
    // 'seat-share' (CHECK in 0106 — Drizzle def omits it, same precedent as
    // billing/reconciliationMode above). Never derives a charge — see
    // server/governance/copilot-overage-allocation.ts.
    overageAllocationPolicy: text('overage_allocation_policy').notNull().default('consumption-share'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Authoritative key is (provider, lower(external_id)) in mig 0062 — external_id
    // is CHECK-constrained lowercase (the canonical enterprise casing, P1-7).
    // Drizzle can't express lower(); this def is approximate — 0062 wins.
    uniqueIndex('provider_enterprise_unique').on(t.provider, t.externalId),
  ],
)

// provider_org — registry of Anthropic / GitHub orgs + how each is reconciled
// and billed (migration 0009). See docs/design/client-attribution-auth-spec.md
// §2.1. The joiner reads the per-event organization.id and selects the lane
// (reconciled | indicative | unknown) from this table.
export const providerOrg = pgTable(
  'provider_org',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    provider: text('provider').notNull(), // 'anthropic' | 'github'
    externalOrgId: text('external_org_id').notNull(),
    displayName: text('display_name').notNull(),
    reconciliationMode: text('reconciliation_mode').notNull().default('indicative'), // 'reconciled' | 'indicative'
    billing: text('billing').notNull().default('tracked'), // 'billed' | 'tracked'
    // Which Anthropic API reconciles this org (migration 0063, the co-existence
    // variant). anthropic: 'enterprise-analytics' | 'claude-code-admin'
    // (CHECK-enforced); github: NULL (Copilot has a single billing API). The
    // anthropic adapter branches on this; reconciliation-sync threads it through
    // AdapterScope. See docs/design/reconciliation-engine.md §4.1.
    apiKind: text('api_kind'),
    // ADR-0010 D4 (mig 0071): the region a Copilot license-org bills to. NULL = unmapped
    // (the bill-driven provisioner uses the global fallback). Admin sets it on the
    // reconciliation-orgs surface; regionForLicenseOrg() reads it.
    regionId: uuid('region_id').references(() => region.id),
    // Reporting-consolidation Wave 0 (mig 0079): the GitHub-org → cost-owning-unit map. The
    // org's POOLED Copilot bill (copilot_pool_bill) homes to this CoU (canonical §B: charge
    // homes via the org map, NOT Entra placement). NULL = unmapped → visible unallocated
    // bucket, never dropped. Admin sets it on the reconciliation-orgs surface. Current-config
    // (re-pointing restates prior months; point-in-time homing is a Wave 5 item).
    costOwningUnitId: uuid('cost_owning_unit_id').references(() => orgUnit.id),
    credentialSecretName: text('credential_secret_name'),
    // Two-level lane registry (migration 0038): link this bucket to its
    // credential-custody enterprise. Nullable: pre-0038 rows + Anthropic (whose
    // credential stays on this row). See docs/design/reconciliation-engine.md §3.2.
    providerEnterpriseId: uuid('provider_enterprise_id').references(() => providerEnterprise.id),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Authoritative key is (provider, lower(external_org_id)) in mig 0064 —
    // external_org_id is CHECK-constrained lowercase (mirrors the enterprise key,
    // mig 0062), so the case-split duplicate that made GitHub attribution
    // non-deterministic can't occur. Drizzle can't express lower(); this def is
    // approximate — 0064 wins.
    uniqueIndex('provider_org_unique').on(t.provider, t.externalOrgId),
  ],
)
