-- 0046 — consumption-dashboard foundations
-- Design: docs/design/my-consumption-my-projects-brief.md (§6).
--
-- 1) attribution_aggregate.advisory_cost_usd — the tier-2 (telemetry-only /
--    advisory) subset of total_cost_usd per cell, so dashboards can split
--    estimated vs advisory without touching the raw ledger.
-- 2) attribution_aggregate RLS bridge — replaces the conservative admin-only
--    policy (mig 0002 explicitly deferred "scope_id bridging" to the first
--    real consumer; this sprint is that consumer). Teammates read their own
--    teammate-scope cells; current project members read their projects'
--    cells; admin/global-finops read all (policy retained).
-- 3) model_catalog — analytics tier classification (frontier | workhorse |
--    lightweight | specialised) resolved by SUBSTRING match against
--    attribution_record.model, first match by sort_order. Display naming
--    stays in the UI (useModelDisplay); this table is the ANALYTICS
--    authority (frontier-share detector, swap rationale).
-- 4) insight_ack — per-(teammate, finding, month) dismissals for the
--    "Observed in your usage" cards. Month scope: a dismissed insight stays
--    dismissed for the calendar month, then may resurface if still true.

ALTER TABLE attribution_aggregate
  ADD COLUMN IF NOT EXISTS advisory_cost_usd numeric(14, 6) NOT NULL DEFAULT 0;

-- query_source as an aggregate dimension (NULL = pre-0045/unknown lane):
-- powers the aux-overhead detector and the consumption page's main-vs-aux
-- strip WITHOUT raw-ledger reads (the dashboards' perf gate forbids them).
-- Cell multiplier is small (main + 1–2 aux lanes per dev-day).
ALTER TABLE attribution_aggregate
  ADD COLUMN IF NOT EXISTS query_source text;

-- Rebuild the unique index with the new dimension. COALESCE expression for
-- the nullable lane (mirrors attribution_record's dedup-index precedent) so
-- concurrent upserts of the NULL lane still conflict instead of duplicating.
DROP INDEX IF EXISTS attribution_aggregate_scope_unique;
CREATE UNIQUE INDEX IF NOT EXISTS attribution_aggregate_scope_unique
  ON attribution_aggregate (scope_type, scope_id, period_start, period_end,
                            tool, model, token_type, COALESCE(query_source, ''));

-- Drop the LEGACY inline unique constraint from mig 0001 (scope_type,
-- scope_id, period_start, period_end, tool, model — WITHOUT token_type).
-- Mig 0045 replaced the named index but the table-level constraint survived,
-- so two token-type cells of one model-day collide. Located by definition
-- (auto-generated name may vary), dropped defensively.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'attribution_aggregate'
    AND con.contype = 'u'
    AND array_length(con.conkey, 1) = 6;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE attribution_aggregate DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- ── RLS bridge (additive permissive policies; admin-only policy remains) ──
CREATE POLICY attribution_aggregate_teammate_self ON attribution_aggregate
  FOR SELECT
  USING (
    scope_type = 'teammate'
    AND scope_id::text = current_setting('app.user_teammate_id', true)
  );

CREATE POLICY attribution_aggregate_project_member ON attribution_aggregate
  FOR SELECT
  USING (
    scope_type = 'project'
    AND EXISTS (
      SELECT 1 FROM project_assignment pa
      WHERE pa.project_id = attribution_aggregate.scope_id
        AND pa.teammate_id::text = current_setting('app.user_teammate_id', true)
        AND pa.effective @> now()
    )
  );

-- Allocation visibility for project MEMBERS (SELECT only): the project
-- dashboard shows the team its own budget context (PO decision: project
-- transparency). Mirrors the allocation_manager_scope precedent (mig 0007)
-- and the app-level fact that /me/usage already shows allocation totals to
-- members. Effective once the app runs under a non-owner role.
CREATE POLICY allocation_project_member ON allocation
  FOR SELECT
  USING (
    scope_type = 'project'
    AND EXISTS (
      SELECT 1 FROM project_assignment pa
      WHERE pa.project_id = allocation.scope_id
        AND pa.teammate_id::text = current_setting('app.user_teammate_id', true)
        AND pa.effective @> now()
    )
  );

-- ts_recorded index: the aggregate-rollup worker's recompute set scans
-- "rows written or re-tagged inside the lookback window" every 15 minutes —
-- without this, that is a full ledger scan at scale. (tagSessionTx bumps
-- ts_recorded on re-tag, so this index serves the re-tag signal too.)
CREATE INDEX IF NOT EXISTS attribution_record_recorded
  ON attribution_record (ts_recorded);

-- Project visibility for CURRENT members (SELECT only): the project RLS
-- from mig 0002 is region-scoped, so a developer assigned to a
-- cross-region project would silently lose its card/dashboard under the
-- non-owner role. Membership is the stronger claim — mirror the aggregate
-- and allocation bridges above.
CREATE POLICY project_member_scope ON project
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM project_assignment pa
      WHERE pa.project_id = project.id
        AND pa.teammate_id::text = current_setting('app.user_teammate_id', true)
        AND pa.effective @> now()
    )
  );

-- ── model_catalog ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS model_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SUBSTRING matched (position(model_pattern in lower(model)) > 0);
  -- ties broken by sort_order ASC. Substring (not prefix) so legacy ids like
  -- 'claude-3-5-sonnet-20241022' and Bedrock 'us.anthropic.claude-…' resolve.
  model_pattern text NOT NULL UNIQUE,
  display_name text NOT NULL,
  family text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('frontier', 'workhorse', 'lightweight', 'specialised')),
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed: current Claude families + the Copilot GPT lane. Unmatched models are
-- UNCLASSIFIED — detectors guard on classified_ratio, so unknown models can
-- never fabricate a finding. sort_order: more specific patterns first.
INSERT INTO model_catalog (model_pattern, display_name, family, tier, sort_order) VALUES
  ('fable',    'Fable',    'claude', 'frontier',    10),
  ('opus',     'Opus',     'claude', 'frontier',    20),
  ('sonnet',   'Sonnet',   'claude', 'workhorse',   30),
  ('haiku',    'Haiku',    'claude', 'lightweight', 40),
  ('gpt-5-mini', 'GPT-5 mini', 'gpt', 'lightweight', 50),
  ('gpt-5 mini', 'GPT-5 mini', 'gpt', 'lightweight', 51),
  ('gpt-4o',   'GPT-4o',   'gpt',    'workhorse',   60),
  ('gpt-5',    'GPT-5',    'gpt',    'frontier',    70)
ON CONFLICT (model_pattern) DO NOTHING;

-- ── insight_ack ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insight_ack (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teammate_id uuid NOT NULL REFERENCES teammate(id),
  finding_id text NOT NULL,
  month text NOT NULL,  -- 'YYYY-MM' (UTC) dismissal scope
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teammate_id, finding_id, month)
);

ALTER TABLE insight_ack ENABLE ROW LEVEL SECURITY;
CREATE POLICY insight_ack_self ON insight_ack
  FOR ALL
  USING (teammate_id::text = current_setting('app.user_teammate_id', true))
  WITH CHECK (teammate_id::text = current_setting('app.user_teammate_id', true));
CREATE POLICY insight_ack_admin ON insight_ack
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'admin'));
