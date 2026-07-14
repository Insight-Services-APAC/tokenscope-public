-- 0038: reconciliation engine — core tables & columns (Phase 0 foundation).
--
-- See docs/design/reconciliation-engine.md. This is the shared foundation both
-- adapters (Anthropic, GitHub) build against; it intentionally adds NO behaviour,
-- only the schema the platform-agnostic engine + the per-platform adapters need.
--
-- Adds:
--   1. provider_enterprise        — the credential-custody / onboarding unit (§3.2)
--   2. provider_org.provider_enterprise_id — link buckets to their enterprise
--   3. reconciliation_record      — the signed-delta ledger (§7.2)
--   4. attribution_record.credit_qty — native AIU operand for the GitHub lane (§7.1)
--   5. actual_spend.category      — cost-category on the adapter staging rows (§7.4)
--   6. teammate_identity_map ext  — directory-sourced identity columns + the
--      (system, enterprise_slug, identifier) key so one login can recur across
--      enterprises without collision (§7.3)
--
-- Idempotent throughout (IF NOT EXISTS / DROP IF EXISTS).

-- 1. provider_enterprise — credential custody (GitHub PAT here; Anthropic per-org
--    key stays on provider_org). reconciliation_mode/billing mirror provider_org.
CREATE TABLE IF NOT EXISTS provider_enterprise (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,                                  -- 'anthropic' | 'github'
  external_id text NOT NULL,                               -- github enterprise slug | anthropic org id
  display_name text NOT NULL,
  reconciliation_mode text NOT NULL DEFAULT 'indicative',  -- 'reconciled' | 'indicative'
  billing text NOT NULL DEFAULT 'tracked',                 -- 'billed' | 'tracked'
  credential_secret_name text,                             -- KV-ref name (GitHub PAT); NULL for Anthropic (per-org on provider_org)
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_enterprise_unique
  ON provider_enterprise (provider, external_id);

-- 2. Link each attribution bucket to its enterprise (nullable: existing rows
--    pre-date the two-level model; the credential resolver falls back per §3.2).
ALTER TABLE provider_org
  ADD COLUMN IF NOT EXISTS provider_enterprise_id uuid REFERENCES provider_enterprise (id);

-- 3. reconciliation_record — one signed-delta row per (teammate|org, enterprise,
--    day, category). Dimensions (region/org_unit/cost_owning_unit/project) are
--    denormalised from the teammate so v_effective_spend (0039) is a clean union
--    with attribution_record and the region clamp keeps working (R3 M-2).
CREATE TABLE IF NOT EXISTS reconciliation_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL for scope='org' (untaggable org-grain web/code-exec lines).
  teammate_id uuid REFERENCES teammate (id),
  provider text NOT NULL,                  -- 'anthropic' | 'github'
  enterprise_ref text NOT NULL,            -- credential scope: anthropic org id | github enterprise slug
  license_org text,                        -- seat.organization for GitHub; NULL for Anthropic
  period_date date NOT NULL,               -- UTC daily grain
  category text NOT NULL,                  -- model_tokens|copilot_interactive|copilot_coding_agent|web_search|code_execution|priority_tier
  scope text NOT NULL DEFAULT 'teammate',  -- 'teammate' | 'org'
  -- Denormalised dimensions (engine fills from the teammate; NULL on org-scope
  -- rows unless the engine resolves a CC/region for them).
  region_id uuid REFERENCES region (id),
  org_unit_id uuid REFERENCES org_unit (id),
  cost_owning_unit_id uuid REFERENCES org_unit (id),
  project_id uuid REFERENCES project (id), -- margin overlay (set on allocation; never gates the charge)
  activity text,
  -- Reconciliation facts (reconcile in the native unit; USD is the booked figure).
  actual_qty numeric(20, 6),               -- native qty (credits/tokens), nullable
  actual_unit_type text,                   -- 'tokens' | 'ai-credits'
  actual_usd numeric(14, 6) NOT NULL,
  otel_attributed_usd numeric(14, 6) NOT NULL,
  delta_usd numeric(14, 6) NOT NULL,       -- actual_usd - otel_attributed_usd
  spend_class text NOT NULL,               -- 'billed' | 'estimated' | 'indicative'
  indicative_reason text,                  -- 'personal-subscription'|'nfr-demo'|'unknown-org'|'copilot-pre-billing'
  disposition text NOT NULL,               -- 'untagged'|'walk_back'|'matched'|'no_install'|'ingest_only'
  status text NOT NULL DEFAULT 'proposed', -- 'proposed'|'applied'|'rejected'|'superseded'
  lag_state text,                          -- 'within_buffer'|'settled' — only meaningful for walk_back
  raw jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  -- NULL on hourly 'proposed' upserts (an audit row per re-pull would bloat);
  -- written on the proposed->applied/rejected state transition.
  audit_event_id uuid,
  -- Legal-cell guard (design §7.2 / R3 LOW-2): lag_state only for walk_back.
  CONSTRAINT reconciliation_record_lag_state_ck
    CHECK (lag_state IS NULL OR disposition = 'walk_back')
);

-- Idempotent hourly re-pull: at most ONE open ('proposed') row per logical key.
-- Terminal rows (applied/rejected/superseded) accumulate as history, so
-- supersession writes a NEW row rather than overwriting (§7.2). COALESCE the
-- nullable teammate_id so org-scope rows share one slot per (enterprise,day,cat).
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_record_open_unique
  ON reconciliation_record (
    provider,
    enterprise_ref,
    period_date,
    category,
    scope,
    (COALESCE(teammate_id, '00000000-0000-0000-0000-000000000000'::uuid))
  )
  WHERE status = 'proposed';

-- Rollup/lookup index (effective-spend view, per-teammate history).
CREATE INDEX IF NOT EXISTS reconciliation_record_teammate_period_idx
  ON reconciliation_record (teammate_id, period_date);
CREATE INDEX IF NOT EXISTS reconciliation_record_status_idx
  ON reconciliation_record (status);

-- 4. credit_qty — the native AIU operand persisted for the GitHub lane so
--    Copilot reconciles credit-vs-credit (§7.1). NULL for Anthropic/Claude rows.
ALTER TABLE attribution_record
  ADD COLUMN IF NOT EXISTS credit_qty numeric(20, 6);

-- 5. category — cost-category on the adapter staging rows (§7.4). NULL = legacy
--    rows (treated as model_tokens by the engine).
ALTER TABLE actual_spend
  ADD COLUMN IF NOT EXISTS category text;

-- 6. teammate_identity_map — directory-sourced identity columns. github_login is
--    the billing-join key; enterprise_slug qualifies it (one login can hold seats
--    in multiple enterprises); license_org/sso_email/billing_relationship carry
--    the resolved lane. (§7.3)
ALTER TABLE teammate_identity_map
  ADD COLUMN IF NOT EXISTS github_login text,
  ADD COLUMN IF NOT EXISTS enterprise_slug text,
  ADD COLUMN IF NOT EXISTS license_org text,
  ADD COLUMN IF NOT EXISTS sso_email text,
  ADD COLUMN IF NOT EXISTS billing_relationship text NOT NULL DEFAULT 'indicative';
                                          -- 'enterprise-reconciled' | 'indicative'

-- Widen the uniqueness to (system, enterprise_slug, identifier) so one login can
-- recur across enterprises — while PRESERVING migration 0012's CASE-INSENSITIVE
-- invariant (the anti-claim-jacking guard: one identity -> at most one teammate;
-- 'Foo@x.com' and 'foo@x.com' must not coexist on two teammates). The live key is
-- (system, lower(identifier)); we keep lower() and add the enterprise_slug
-- qualifier. COALESCE(enterprise_slug,'') keeps existing rows (all NULL
-- enterprise_slug) equivalent to the old key, so no backfill collision.
-- De-dup case-variants under the new key first (mirrors 0012; a no-op on current
-- data, correct if enterprise_slug-qualified variants ever exist).
DELETE FROM teammate_identity_map a
USING teammate_identity_map b
WHERE a.id < b.id
  AND a.system = b.system
  AND COALESCE(a.enterprise_slug, '') = COALESCE(b.enterprise_slug, '')
  AND lower(a.identifier) = lower(b.identifier);

DROP INDEX IF EXISTS teammate_identity_map_identity_unique;
CREATE UNIQUE INDEX IF NOT EXISTS teammate_identity_map_identity_unique
  ON teammate_identity_map (system, (COALESCE(enterprise_slug, '')), (lower(identifier)));
