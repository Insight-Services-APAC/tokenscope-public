-- 0053: durable enriched spend rollup (Phase A — ledger retention epic).
--
-- The single durable source-of-truth for spend that must SURVIVE raw-ledger
-- retention (docs/design/ledger-retention-and-archive.md). Grain carries
-- everything the dev / PM / finance personas need past month-end:
--   per day × project (NULL = spill) × teammate × point-in-time org context
--   × tool × model × token_type × activity × query_source.
-- Measures keep an estimated/indicative split keyed on cost_basis (NOT
-- fidelity_tier — the two are in lockstep today but the reconciliation roadmap
-- decouples them when Copilot tier-2 is promoted to tier-1).
--
-- Session COUNT is non-additive at this grain (one session spans ~8 cells/day),
-- so it lives in a separate coarse companion table below.

CREATE TABLE spend_rollup_daily (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start         timestamptz NOT NULL,                       -- UTC day midnight
  project_id           uuid REFERENCES project(id),                -- NULL = spill / unallocated
  teammate_id          uuid NOT NULL REFERENCES teammate(id),
  -- Point-in-time org context, CARRIED from raw (not re-derived from the current
  -- project/teammate — those move under reassignment; finance hot reads the
  -- frozen raw values, so cold must match them). In the grain key so a mid-life
  -- reassignment splits cells instead of silently aggregating across contexts.
  region_id            uuid NOT NULL REFERENCES region(id),
  org_unit_id          uuid NOT NULL REFERENCES org_unit(id),
  cost_owning_unit_id  uuid REFERENCES org_unit(id),               -- follows project; NULL for spill
  tool                 text NOT NULL,
  model                text NOT NULL,
  token_type           text NOT NULL,
  activity             text,                                       -- NULL = untagged
  query_source         text,                                      -- 'main' | aux lane | NULL
  total_tokens         bigint NOT NULL,
  total_cost_usd       numeric(14,6) NOT NULL,
  -- The telemetry-only (indicative) subset of total_cost_usd, keyed on
  -- cost_basis. estimated = total_cost_usd - indicative_cost_usd. This is the
  -- axis v_effective_spend.spend_class uses, so finance survives raw retirement.
  indicative_cost_usd  numeric(14,6) NOT NULL DEFAULT 0,
  record_count         integer NOT NULL,
  refresh_at           timestamptz NOT NULL DEFAULT now()
);

-- Upsert key. project_id / cost_owning_unit_id / activity / query_source are
-- nullable grain dimensions; a plain UNIQUE treats NULLs as DISTINCT (every
-- recompute would insert a duplicate and ON CONFLICT would find no arbiter), so
-- key on COALESCE expressions with sentinels. The sentinel is index-only — the
-- columns keep their real NULLs and FKs. (Mirrors attribution_aggregate / mig
-- 0046; the rollup worker's ON CONFLICT must infer on this identical list.)
CREATE UNIQUE INDEX spend_rollup_daily_grain_unique ON spend_rollup_daily (
  period_start,
  COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
  teammate_id,
  region_id,
  org_unit_id,
  COALESCE(cost_owning_unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
  tool, model, token_type,
  COALESCE(activity, ''),
  COALESCE(query_source, '')
);

-- Read paths: PM project view, dev/teammate view, finance per-CoU.
CREATE INDEX spend_rollup_daily_project_period  ON spend_rollup_daily (project_id, period_start);
CREATE INDEX spend_rollup_daily_teammate_period ON spend_rollup_daily (teammate_id, period_start);
CREATE INDEX spend_rollup_daily_cou_period      ON spend_rollup_daily (cost_owning_unit_id, period_start);

-- Companion: distinct-session activity per (teammate, project, day). Session
-- count CANNOT be recomputed once raw is retired, so it is captured here at
-- rollup time. Semantics: distinct claude_session_id active in this cell on this
-- day. Cross-day rollups are session-(project-)days (an activity proxy), NOT
-- exact distinct sessions; exact current-month distinct still comes from hot
-- raw. (A mergeable HLL sketch is a future enhancement for exact cold distinct.)
CREATE TABLE spend_session_daily (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start           timestamptz NOT NULL,
  teammate_id            uuid NOT NULL REFERENCES teammate(id),
  project_id             uuid REFERENCES project(id),              -- NULL = spill
  distinct_session_count integer NOT NULL,
  refresh_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX spend_session_daily_grain_unique ON spend_session_daily (
  period_start, teammate_id,
  COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX spend_session_daily_project_period ON spend_session_daily (project_id, period_start);
