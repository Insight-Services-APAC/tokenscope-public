-- 0136 — usage_rollup_daily: the day-grain §A rollup the region reports read,
-- plus its retro-mutation refresh queue.
-- Design: docs/design/usage-rollup-lane.md (R1/R2/R4/R6).
--
-- A NEW table, deliberately not an extension of spend_rollup_daily (R1): that
-- table reads attribution_record raw with no quarantine predicate, has no
-- arms 2/3, requires model NOT NULL in its unique grain (arms 2b/3b are
-- NULL-model by construction) and is load-bearing for archive-ledger +
-- rehome-placement through three lockstepped ON CONFLICT lists.
--
-- CONTENT CONTRACT: rows are DEFINED as
--   SELECT (ts_event AT TIME ZONE 'UTC')::date, <dims>, SUM(cost_usd),
--          SUM(tokens), COUNT(*) FROM v_complete_usage GROUP BY ...
-- written by server/workers/usage-rollup.ts. The view is the single §A
-- definition (quarantine exclusion, fill arms, remainder rows); the rollup
-- may lag it by at most the worker cadence plus, for retroactive mutations
-- outside the trailing window (a quarantine flip, a placement re-home), one
-- drain of usage_rollup_refresh. Footing is test-pinned
-- (tests/integration/workers/usage-rollup.test.ts).
--
-- Grain (R2): teammate stays in the key — the region page's non-additive
-- reads (active users, per-person percentiles, concentration, distinct
-- counts) need the per-teammate vector. Point-in-time dims are CARRIED from
-- the lane, never re-derived (the 0053 rule).
CREATE TABLE usage_rollup_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day date NOT NULL,
  teammate_id uuid NOT NULL REFERENCES teammate(id),
  -- Nullable dims: an Unassigned person has no region/org placement; arm 2
  -- carries no cost-owning unit; arms 2b/3 carry NULL project/model.
  region_id uuid REFERENCES region(id),
  org_unit_id uuid REFERENCES org_unit(id),
  cost_owning_unit_id uuid REFERENCES org_unit(id),
  project_id uuid REFERENCES project(id),
  tool text NOT NULL,
  model text,
  usage_provenance text NOT NULL,
  model_gap_reason text,
  activity text,
  cost_usd numeric(14, 6) NOT NULL,
  tokens bigint NOT NULL,
  record_count integer NOT NULL,
  refresh_at timestamptz NOT NULL DEFAULT now()
);

-- The upsert arbiter: COALESCE sentinels because a plain UNIQUE treats NULLs
-- as distinct and ON CONFLICT would find no arbiter (the 0053 rationale,
-- same sentinel idiom).
CREATE UNIQUE INDEX usage_rollup_daily_grain_unique ON usage_rollup_daily (
  day,
  teammate_id,
  COALESCE(region_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(org_unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(cost_owning_unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
  tool,
  COALESCE(model, ''),
  usage_provenance,
  COALESCE(model_gap_reason, ''),
  COALESCE(activity, '')
);

-- Read shapes: whole-company windows, region/org clamps, per-teammate
-- vectors (docs/design/usage-rollup-lane.md R2).
CREATE INDEX usage_rollup_daily_day_idx ON usage_rollup_daily (day);
CREATE INDEX usage_rollup_daily_region_day_idx ON usage_rollup_daily (region_id, day);
CREATE INDEX usage_rollup_daily_org_unit_day_idx ON usage_rollup_daily (org_unit_id, day);
CREATE INDEX usage_rollup_daily_teammate_day_idx ON usage_rollup_daily (teammate_id, day);

-- Derived reporting data: same posture as attribution_aggregate under the
-- 0098 CONVERGENCE — ('global-finops', 'platform-admin'), never bare 'admin'
-- (a region-scoped role must not get a DB-level org-wide bypass). The
-- reporting endpoints authorize via in-query scope predicates; the policy is
-- the defense-in-depth floor for the RLS cutover.
ALTER TABLE usage_rollup_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON usage_rollup_daily FROM PUBLIC;
CREATE POLICY usage_rollup_daily_admin_only ON usage_rollup_daily
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

-- ── The retro-mutation refresh queue (R4) ────────────────────────────────
-- v_complete_usage is retroactively mutable OUTSIDE any date window: a
-- quarantine flip removes arm-1 history at read time; a placement re-home
-- restates dims on all history. Neither bumps a timestamp a trailing window
-- can see, so those two write paths queue the teammate here and the worker
-- drains the queue by recomputing that teammate's full history
-- (delete-after-recompute — a crashed run re-drains).
CREATE TABLE usage_rollup_refresh (
  teammate_id uuid PRIMARY KEY REFERENCES teammate(id),
  requested_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE usage_rollup_refresh ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON usage_rollup_refresh FROM PUBLIC;
-- Writers: the developer's own over-emission resolve (own-teammate arm) and
-- the rehome lanes, which run as region 'admin' or platform-admin. 'admin'
-- stays in THIS list — unlike the rollup table, the queue exposes no data
-- (teammate id + timestamp) and its only power is "recompute this teammate's
-- rollup", an idempotent no-op when nothing changed; the rehome handler
-- enforces region scope in-app before the enqueue.
CREATE POLICY usage_rollup_refresh_write_scope ON usage_rollup_refresh
  FOR ALL
  USING (
    current_setting('app.user_role', true) IN ('global-finops', 'platform-admin', 'admin')
    OR teammate_id::text = current_setting('app.user_teammate_id', true)
  );

COMMENT ON TABLE usage_rollup_daily IS
  'Day-grain rollup of v_complete_usage (the §A lane) for the region reporting endpoints — written by the usage-rollup worker every 15 min (full-history backfill once, trailing-window + refresh-queue steady state). Grain keeps teammate_id for the non-additive reads. May lag the live view by <= the cadence; footing Σ(rollup) ≡ Σ(view) is test-pinned. docs/design/usage-rollup-lane.md.';
COMMENT ON TABLE usage_rollup_refresh IS
  'Teammates whose usage_rollup_daily history must be recomputed because a retroactive mutation (quarantine flip, placement re-home) changed v_complete_usage outside the worker''s trailing window. Drained by the usage-rollup worker; delete-after-recompute.';

-- ── Source-write signal indexes ─────────────────────────────────────────
-- The usage-rollup worker's change signal filters every §A source by its
-- write instant each cadence (server/workers/usage-rollup.ts signal 2);
-- without these, each 15-minute run seq-scans four whole-history tables —
-- sustained load the rollup exists to remove. The unaccounted_usage index
-- key matches the worker's GREATEST expression exactly (GREATEST/COALESCE
-- over timestamptz are immutable — legal index keys).
CREATE INDEX IF NOT EXISTS actual_spend_pulled_at_idx
  ON actual_spend (pulled_at);
CREATE INDEX IF NOT EXISTS provider_usage_fact_pulled_at_idx
  ON provider_usage_fact (pulled_at);
CREATE INDEX IF NOT EXISTS reconciliation_record_computed_at_idx
  ON reconciliation_record (computed_at);
CREATE INDEX IF NOT EXISTS unaccounted_usage_write_instant_idx
  ON unaccounted_usage ((GREATEST(computed_at, COALESCE(tagged_at, computed_at))));

-- ── Synchronous full-history seed ────────────────────────────────────────
-- The region reports switch to this table in the SAME release; without a
-- seed, the first deploy serves an EMPTY reporting source until the worker's
-- resumable backfill catches up (potentially hours at enterprise scale).
-- One full-history aggregate of the lane, at deploy, inside the migration —
-- the exact shape the worker writes (server/workers/usage-rollup.ts
-- cellsSelect), so the first worker run finds no missing day and flips
-- straight to incremental. Runs while the OLD binary is still serving (the
-- deploy applies migrations before the traffic switch), so the write is
-- invisible until the new readers arrive.
INSERT INTO usage_rollup_daily
  (day, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
   tool, model, usage_provenance, model_gap_reason, activity,
   cost_usd, tokens, record_count)
SELECT (u.ts_event AT TIME ZONE 'UTC')::date AS day,
       u.teammate_id, u.region_id, u.org_unit_id, u.cost_owning_unit_id, u.project_id,
       u.tool, u.model, u.usage_provenance, u.model_gap_reason, u.activity,
       COALESCE(SUM(u.cost_usd), 0), COALESCE(SUM(u.tokens), 0), COUNT(*)
FROM v_complete_usage u
GROUP BY (u.ts_event AT TIME ZONE 'UTC')::date,
         u.teammate_id, u.region_id, u.org_unit_id, u.cost_owning_unit_id, u.project_id,
         u.tool, u.model, u.usage_provenance, u.model_gap_reason, u.activity;

ANALYZE usage_rollup_daily;
