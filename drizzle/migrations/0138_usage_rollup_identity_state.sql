-- 0138 — usage_rollup_daily gains identity_state as a GRAIN column
-- (docs/design/usage-rollup-lane.md R5b.1).
--
-- The project-axis seam's provisional filter (identity_state IS DISTINCT FROM
-- 'provisional' -- server/usage/complete-spend.ts includePredicate) must work
-- on pre-aggregated cells, so the state rides the grain: a mixed
-- provisional/confirmed day splits into two cells and the filter drops exactly
-- the provisional one. Values are whatever v_complete_usage projects (0135):
-- arm 1 carries attribution_record.identity_state (NULL, 'provisional' or
-- 'confirmed'); arms 2a/2b/3a/3b project the literal 'confirmed'. NULL is a
-- real arm-1 value and the filter includes it exactly as on the view.
--
-- Step order, ONE transaction (the migration runner wraps each file): a failed
-- reseed rolls back the TRUNCATE, so the usage-rollup worker's kv markers can
-- never describe a partially reseeded table (R5b.1). The rollup is derived
-- data; a reseed from the view is the honest backfill.
--
-- DEPLOY WINDOW: the TRUNCATE holds ACCESS EXCLUSIVE through the reseed, so
-- the old revision's rollup-backed report reads BLOCK for its duration; after
-- commit, the old revision's 11-expression ON CONFLICT upsert fails until
-- traffic flips (0-1 ticks, damped). Full analysis: usage-rollup-lane.md R5b.1.
TRUNCATE usage_rollup_daily;

ALTER TABLE usage_rollup_daily ADD COLUMN identity_state text;

DROP INDEX usage_rollup_daily_grain_unique;

-- The 0136 seed statement, now projecting and grouping identity_state — the
-- exact shape the worker writes (server/workers/usage-rollup.ts cellsSelect),
-- so the first post-deploy worker run finds no missing day and stays
-- incremental.
--
-- CONSTRAINT: identity_state aggregates through NULLIF('' -> NULL), the same
-- expression the worker groups on. The grain index below buckets NULL and ''
-- into ONE key via its COALESCE sentinel, and attribution_record carries no
-- CHECK on the column: grouping them as two cells would abort this index
-- CREATE on a duplicate key, and a worker upsert would let the second cell
-- overwrite the first. Structural agreement with the arbiter, not data
-- cleanup (usage-rollup-lane.md R5b.1).
INSERT INTO usage_rollup_daily
  (day, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
   tool, model, usage_provenance, model_gap_reason, activity, identity_state,
   cost_usd, tokens, record_count)
SELECT (u.ts_event AT TIME ZONE 'UTC')::date AS day,
       u.teammate_id, u.region_id, u.org_unit_id, u.cost_owning_unit_id, u.project_id,
       u.tool, u.model, u.usage_provenance, u.model_gap_reason, u.activity,
       NULLIF(u.identity_state, ''),
       COALESCE(SUM(u.cost_usd), 0), COALESCE(SUM(u.tokens), 0), COUNT(*)
FROM v_complete_usage u
GROUP BY (u.ts_event AT TIME ZONE 'UTC')::date,
         u.teammate_id, u.region_id, u.org_unit_id, u.cost_owning_unit_id, u.project_id,
         u.tool, u.model, u.usage_provenance, u.model_gap_reason, u.activity,
         NULLIF(u.identity_state, '');

-- The widened upsert arbiter — the 0136/0053 sentinel idiom: COALESCE because
-- a plain UNIQUE treats NULLs as distinct and ON CONFLICT would find no
-- arbiter. identity_state takes the same empty-string sentinel as the other
-- nullable text dims; live values are NULL / 'provisional' / 'confirmed'
-- (instance_attestation 0057 check), and '' cannot reach the table at all:
-- every write path aggregates through NULLIF('' -> NULL) (the reseed above,
-- the worker cellsSelect), so the sentinel bucket holds exactly one value.
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
  COALESCE(activity, ''),
  COALESCE(identity_state, '')
);

COMMENT ON COLUMN usage_rollup_daily.identity_state IS
  'Grain dim (0138): the lane row''s identity_state as v_complete_usage projects it — arm 1 = attribution_record.identity_state (NULL/provisional/confirmed), arms 2/3 = confirmed by construction. In the grain so the project-axis provisional filter works on pre-aggregated cells (usage-rollup-lane.md R5b).';

COMMENT ON TABLE usage_rollup_daily IS
  'Day-grain rollup of v_complete_usage (the §A lane) for the region reporting endpoints and the project-axis seam — written by the usage-rollup worker every 15 min (full-history backfill once, trailing-window + refresh-queue steady state). Grain keeps teammate_id for the non-additive reads and identity_state (0138) for the provisional filter. May lag the live view by <= the cadence; footing Σ(rollup) ≡ Σ(view) is test-pinned. docs/design/usage-rollup-lane.md.';

ANALYZE usage_rollup_daily;
