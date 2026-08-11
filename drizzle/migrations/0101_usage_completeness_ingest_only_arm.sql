-- 0101 — Workstream A (usage completeness): restore non-Code Claude surfaces
-- to v_teammate_usage_daily, generalise the ingest-only tool set, add the
-- third (non-taggable) completeness arm to v_complete_usage, snapshot
-- historical homing dimensions on actual_spend, and carry usage_provenance.
--
-- Design: docs/design/usage-completeness-and-provider-governance.md §3.1 (A1-A3),
-- §8.4 (rollback/backup amendments). Contract: docs/wiki/Reporting.md §2 Axis 1,
-- §6.1/§6.2. Uses migrations 0086 (latest v_teammate_usage_daily def) and 0089
-- (latest v_complete_usage def) as bases — both are CREATE OR REPLACE'd here,
-- neither is edited in place (immutable history).
--
-- ============================================================================
-- PART 1 — actual_spend historical-homing dimension snapshot (§3.1 "Historical
-- homing uses source snapshots, with an explicit legacy fallback").
--
-- reconciliation_record has snapshotted (region_id, org_unit_id,
-- cost_owning_unit_id) since its own inception (migration 0038,
-- server/reconciliation/engine.ts). actual_spend never has, which would force
-- the new arm 3 below to home usage against the teammate's CURRENT placement —
-- moving historical spend across a reorg, which the design forbids. These
-- columns are nullable: NULL is the explicit "no evidence" / "no cost-owning
-- ancestor" state, never guessed at.
-- ============================================================================
ALTER TABLE actual_spend
  ADD COLUMN region_id uuid REFERENCES region(id),
  ADD COLUMN org_unit_id uuid REFERENCES org_unit(id),
  ADD COLUMN cost_owning_unit_id uuid REFERENCES org_unit(id),
  -- 'ingest-snapshot' (written by a writer at write/replay time) |
  -- 'legacy-current-placement' (this migration's one-time backfill, below).
  ADD COLUMN dimension_source text;

-- Backfill EVERY pre-existing row (dimension_source IS NULL for all of them,
-- since the columns did not exist before this statement) from the teammate's
-- CURRENT placement — the only evidence available for history. Labelled
-- 'legacy-current-placement' so it is never mistaken for point-in-time truth.
-- This is a single-pass join over `teammate`/`org_unit` (no external calls, no
-- per-row failure mode), consistent with this codebase's existing backfill
-- migrations (e.g. 0069_region_id_backfill.sql) — unlike a governance-key or
-- directory-derived backfill, it has no failure state to bucket, so it does
-- not need the batched-worker treatment §8.4 requires for those.
UPDATE actual_spend a
SET region_id = dims.region_id,
    org_unit_id = dims.org_unit_id,
    cost_owning_unit_id = dims.cost_owning_unit_id,
    dimension_source = 'legacy-current-placement'
FROM (
  SELECT t.id AS teammate_id, t.region_id, t.org_unit_id, cc.cost_owning_unit_id
  FROM teammate t
  LEFT JOIN LATERAL (
    -- Nearest ACTIVE cost-owning ancestor of the teammate's current org unit —
    -- same semantics as v_finance_bill_chargeback (mig 0073) and
    -- fetchOverageDrivers (server/reporting/finance.ts). NULL (no match) is
    -- retained as the explicit unallocated bucket, never guessed.
    SELECT anc.id AS cost_owning_unit_id
    FROM org_unit home JOIN org_unit anc ON home.path <@ anc.path
    WHERE home.id = t.org_unit_id AND anc.is_cost_owning_unit = TRUE AND anc.retired_at IS NULL
    ORDER BY nlevel(anc.path) DESC LIMIT 1
  ) cc ON TRUE
) dims
WHERE a.teammate_id = dims.teammate_id
  AND a.dimension_source IS NULL;

COMMENT ON COLUMN actual_spend.dimension_source IS
  'Provenance of (region_id, org_unit_id, cost_owning_unit_id) on this row: ''ingest-snapshot'' = captured at write/replay time (the teammate''s placement THEN); ''legacy-current-placement'' = this migration''s one-time backfill of pre-existing rows (the teammate''s placement NOW, since no historical evidence exists — never point-in-time truth). See server/reconciliation/dimension-snapshot.ts.';

-- ============================================================================
-- PART 2 — back up, then delete, any stale ingest-only unaccounted_usage rows
-- (§3.1 "Disjointness must be structural, not conventional"; §8.4 "the
-- migration takes a backup copy ... before deleting them, so rollback restores
-- data rather than attempting to infer it").
--
-- In a correctly-behaved deployment this should find ZERO rows: the seven
-- non-Code Claude surfaces were NEVER in v_teammate_usage_daily before this
-- migration (excluded since 0084, the reconciliation worker's only source),
-- and 'copilot-agent' has been excluded from the needs-tagging reconciliation
-- since migration 0086 (GITHUB_INGEST_ONLY_USAGE_TOOLS). This step is
-- defensive belt-and-braces for structural disjointness, not a correction of
-- an observed defect, and is safe to run as a no-op.
-- ============================================================================
CREATE TABLE unaccounted_usage_0101_ingest_only_backup AS
SELECT * FROM unaccounted_usage
WHERE tool IN (
  'copilot-agent',
  -- NON_CODE_CLAUDE_TOOLS (shared/usage/surface.ts) — MUST match exactly
  -- (pinned by tests/unit/usage/surface.test.ts's migration-0101 block).
  'claude-ai',
  'claude-cowork',
  'claude-office',
  'claude-chrome',
  'claude-design',
  'claude-slack',
  'claude-other'
);

COMMENT ON TABLE unaccounted_usage_0101_ingest_only_backup IS
  'Rollback evidence for migration 0101''s ingest-only unaccounted_usage sweep (docs/design/usage-completeness-and-provider-governance.md §8.4). Restore with: INSERT INTO unaccounted_usage SELECT * FROM unaccounted_usage_0101_ingest_only_backup ON CONFLICT (teammate_id, day, tool) DO NOTHING; Safe to drop once the 0101 cutover is confirmed stable (see the Workstream A rollout runbook, docs/development/).';

DELETE FROM unaccounted_usage
WHERE tool IN (
  'copilot-agent',
  'claude-ai',
  'claude-cowork',
  'claude-office',
  'claude-chrome',
  'claude-design',
  'claude-slack',
  'claude-other'
);

-- ============================================================================
-- PART 3 — A1 + dimension carry: restore v_teammate_usage_daily to the
-- complete per-(teammate, day, tool) USAGE truth (revert 0084's non-Code
-- exclusion), and append the historical-homing dimension snapshot columns
-- (backwards-compatible: CREATE OR REPLACE only ever appends trailing
-- columns; every existing consumer selects named columns).
--
-- copilot-cli and copilot-agent remain excluded from the actual_spend branch
-- for the pre-existing, unchanged reason (their usage truth is
-- reconciliation_record, not actual_spend) — see 0073 / 0086. The non-Code
-- Claude surfaces (#142) are no longer excluded: A2 (shared/usage/surface.ts
-- INGEST_ONLY_USAGE_TOOLS, consumed by server/usage/unaccounted-reconciliation.ts)
-- is what keeps them out of the needs-tagging worklist now, not this view.
--
-- Dimension snapshot columns:
--   - actual_spend branch: actual_spend now carries its own snapshot (Part 1).
--     A (teammate, day, tool) group can still span >1 actual_spend row (e.g.
--     two org sources the same day) — (array_agg(... ORDER BY pulled_at DESC))[1]
--     picks the MOST RECENTLY WRITTEN row's snapshot deterministically. This
--     does not reintroduce reorg-drift: an individual row's own snapshot is
--     fixed at ITS OWN write time (writers never update it on conflict; see
--     server/reconciliation/dimension-snapshot.ts) — this aggregate only
--     picks WHICH row's already-fixed snapshot represents the group.
--   - copilot branch: reconciliation_record has snapshotted these since its
--     own inception (mig 0038) — carried straight through, labelled
--     'ingest-snapshot' unconditionally (scope='teammate' rows always have
--     them resolved; server/reconciliation/engine.ts skips-and-counts any
--     teammate it cannot resolve rather than writing a dangling row). A
--     teammate can hold seats in >1 enterprise (see the existing "sums across
--     enterprises" test) — the same array_agg pick-latest pattern, ordered by
--     computed_at, resolves that fan-out.
-- ============================================================================
CREATE OR REPLACE VIEW v_teammate_usage_daily
WITH (security_invoker = true) AS
  SELECT
    a.teammate_id,
    a.date AS day,
    a.tool,
    SUM(a.cost_usd)::numeric(14, 6) AS usage_usd,
    SUM(a.input_tokens + a.output_tokens)::bigint AS tokens,
    (array_agg(a.region_id ORDER BY a.pulled_at DESC))[1] AS region_id,
    (array_agg(a.org_unit_id ORDER BY a.pulled_at DESC))[1] AS org_unit_id,
    (array_agg(a.cost_owning_unit_id ORDER BY a.pulled_at DESC))[1] AS cost_owning_unit_id,
    (array_agg(a.dimension_source ORDER BY a.pulled_at DESC))[1] AS dimension_source
  FROM actual_spend a
  WHERE a.tool NOT IN (
    'copilot-cli',   -- copilot usage truth is reconciliation_record (gross), not the pooled bill
    'copilot-agent'  -- same reason (D4 coding-agent lane, sourced below)
    -- 0101 (A1): the #142 non-Code Claude surfaces are NO LONGER excluded here
    -- — this view is restored to the complete per-(teammate, day, tool) USAGE
    -- truth its name and header claim. They stay out of the needs-tagging
    -- worklist via INGEST_ONLY_USAGE_TOOLS in reconcileUnaccountedUsage (A2),
    -- not via this view.
  )
  GROUP BY a.teammate_id, a.date, a.tool
  UNION ALL
  SELECT
    cur.teammate_id,
    cur.period_date AS day,
    cur.tool,
    SUM(cur.actual_usd)::numeric(14, 6) AS usage_usd,
    NULL::bigint AS tokens,          -- copilot is metered in ai-credits, not tokens
    (array_agg(cur.region_id ORDER BY cur.computed_at DESC))[1] AS region_id,
    (array_agg(cur.org_unit_id ORDER BY cur.computed_at DESC))[1] AS org_unit_id,
    (array_agg(cur.cost_owning_unit_id ORDER BY cur.computed_at DESC))[1] AS cost_owning_unit_id,
    'ingest-snapshot'::text AS dimension_source
  FROM (
    -- The single live row per logical key (see the LIFECYCLE note in 0073): non-terminal status,
    -- highest precedence (applied beats a lingering proposed), newest computed_at as tiebreak.
    SELECT DISTINCT ON (r.provider, r.enterprise_ref, r.period_date, r.category, r.scope, r.teammate_id)
      r.teammate_id, r.period_date, r.actual_usd, r.region_id, r.org_unit_id, r.cost_owning_unit_id, r.computed_at,
      -- D4 usage-lane split: coding agent gets its own display lane; everything
      -- else (copilot_interactive + any legacy value) stays 'copilot-cli'.
      CASE WHEN r.category = 'copilot_coding_agent' THEN 'copilot-agent' ELSE 'copilot-cli' END AS tool
    FROM reconciliation_record r
    WHERE r.provider = 'github'
      AND r.scope = 'teammate'
      AND r.teammate_id IS NOT NULL
      AND r.status NOT IN ('rejected', 'superseded')
    ORDER BY r.provider, r.enterprise_ref, r.period_date, r.category, r.scope, r.teammate_id,
             CASE r.status WHEN 'applied' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
             r.computed_at DESC
  ) cur
  GROUP BY cur.teammate_id, cur.period_date, cur.tool;

COMMENT ON VIEW v_teammate_usage_daily IS
  'Per-(teammate, day, tool) provider USAGE truth for §A reconciliation (usage-completeness-and-provider-governance.md §3.1). claude-code + non-Code Claude surfaces from actual_spend; Copilot gross from reconciliation_record, laned by category. Non-Code surfaces restored 0101 (A1) — worklist safety now comes from INGEST_ONLY_USAGE_TOOLS in reconcileUnaccountedUsage (A2), not this view. Carries a historical-homing dimension snapshot (region_id/org_unit_id/cost_owning_unit_id/dimension_source, 0101) so v_complete_usage''s ingest-only arm homes AS AT THE USAGE DATE. NOT the §B bill.';

-- ============================================================================
-- PART 4 — A3: the third (non-taggable) completeness arm on v_complete_usage,
-- plus usage_provenance (appended for every arm — ships with A, not deferred
-- to Workstream E, so arm 3 is never mislabelled "Unattributed" the moment it
-- lands). Arms 1 and 2 gain an EXPLICIT ingest-only-tool exclusion so
-- disjointness is structural (a data anomaly can never land the same tool in
-- two arms), not merely a consequence of today's data shape.
-- ============================================================================
CREATE OR REPLACE VIEW v_complete_usage
WITH (security_invoker = true) AS
  SELECT
    ar.teammate_id, ar.region_id, ar.org_unit_id, ar.cost_owning_unit_id, ar.project_id, ar.tool,
    ar.ts_event, ar.cost_usd, ar.tokens,
    ar.model,
    ar.token_type,
    ar.identity_state,
    'otel-emitted'::text AS usage_provenance      -- 0101: see shared/usage/provenance.ts
  FROM attribution_record ar
  WHERE NOT EXISTS (
    SELECT 1 FROM session_quarantine sq
     WHERE sq.teammate_id = ar.teammate_id
       AND sq.conversation_id = ar.claude_session_id
       AND sq.resolved_at IS NULL
       AND sq.reason = 'api-uncorroborated'
  )
  -- 0101 structural disjointness: an ingest-only tool must never reach §A via
  -- the OTel arm (it cannot, by definition — no ingest-only tool ever emits
  -- OTel — but the predicate is explicit rather than assumed).
  AND ar.tool NOT IN (
    'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
    'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
  )
  UNION ALL
  SELECT
    uu.teammate_id, uu.region_id, uu.org_unit_id, NULL::uuid AS cost_owning_unit_id, uu.project_id, uu.tool,
    (uu.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    uu.cost_usd, COALESCE(uu.tokens, 0)::bigint AS tokens,
    NULL::text AS model,
    'unknown'::text AS token_type,
    'confirmed'::text AS identity_state,
    'api-reconciled'::text AS usage_provenance    -- 0101
  FROM unaccounted_usage uu
  WHERE uu.cost_usd > 0
    -- 0101 structural disjointness (belt-and-braces: Part 2 already swept
    -- historical rows, and reconcileUnaccountedUsage (A2) never writes new
    -- ones for these tools).
    AND uu.tool NOT IN (
      'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
      'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
    )
  UNION ALL
  -- Arm 3 (0101, A3) — the non-taggable completeness arm. Genuine §A provider
  -- usage for tools that can NEVER be OTel-emitted or reconciled into a
  -- taggable unaccounted_usage row (the non-Code Claude surfaces, #142; the
  -- coding-agent lane, D4/mig 0086). Reads v_teammate_usage_daily (NOT
  -- actual_spend directly) so the copilot-agent lane — whose usage truth is
  -- reconciliation_record — is covered by the SAME mechanism as the non-Code
  -- surfaces, with no second bespoke query. `model` is NULL for a structural
  -- reason (no source API exposes a model split for these surfaces at all),
  -- so usage_provenance='provider-usage' is required — see
  -- shared/reports/model-attribution.ts for why these rows must never render
  -- as "Unattributed". `identity_state`='confirmed': bill-anchored provider
  -- truth is never provisional. `project_id` is always NULL — this lane is
  -- untaggable by construction, never a project budget operand. Dimensions
  -- come from v_teammate_usage_daily's OWN snapshot (Part 3) — NOT a live
  -- LATERAL join to the teammate's current placement — so a reorg cannot move
  -- historical arm-3 spend between cost centres; an unresolved ancestor stays
  -- the explicit NULL/unallocated bucket, matching every other §A/§B arm.
  SELECT
    vtd.teammate_id, vtd.region_id, vtd.org_unit_id, vtd.cost_owning_unit_id, NULL::uuid AS project_id, vtd.tool,
    (vtd.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    vtd.usage_usd AS cost_usd, COALESCE(vtd.tokens, 0)::bigint AS tokens,
    NULL::text AS model,
    'unknown'::text AS token_type,
    'confirmed'::text AS identity_state,
    'provider-usage'::text AS usage_provenance
  FROM v_teammate_usage_daily vtd
  WHERE vtd.usage_usd > 0
    -- INGEST_ONLY_USAGE_TOOLS (shared/usage/surface.ts) — MUST match exactly
    -- (pinned by tests/unit/usage/surface.test.ts's migration-0101 block).
    -- The ONLY arm that INCLUDES this set (arms 1/2 above EXCLUDE it).
    AND vtd.tool IN (
      'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
      'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
    );

COMMENT ON VIEW v_complete_usage IS
  'Per-teammate COMPLETE usage = attribution_record (OTel, minus dev-confirmed forgeries) UNION ALL unaccounted_usage (API-OTel gap) UNION ALL the ingest-only completeness arm (0101, A3: non-Code Claude surfaces + copilot-agent, via v_teammate_usage_daily — never taggable, never budget-eligible, always velocity-eligible). Carries (model, token_type) [0082], identity_state [0089], and usage_provenance [0101: otel-emitted | api-reconciled | provider-usage] so manager-facing producers and reporting drivers can tell a genuine attribution gap from a structural absence. usage-completeness-and-provider-governance.md §3.1.';
