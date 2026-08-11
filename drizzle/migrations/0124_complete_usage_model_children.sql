-- 0124 — v_complete_usage carries the model split that was measured, and types
-- every remainder.
--
-- Design: docs/design/reporting-consolidation/07-model-axis-subtraction-build.md
-- D4 + D5 (S2; owner ruling 2026-08-04). S1 (mig 0123 + the
-- unaccounted-reconciliation writer) computes and stores the arm-2 per-model
-- residual children at write time; this migration is the read side: the view
-- fans both NULL-model arms out into NAMED models plus ONE reason-typed
-- remainder per key, so "Not split by model" and "Model not captured for this
-- surface" stop existing as category rows (the acceptance gate).
--
-- WHAT CHANGES, per arm:
--
--   arm 1 (otel-emitted)  — unchanged; gains the trailing `model_gap_reason`
--                           column as NULL (a named model has no gap to type).
--
--   arm 2 (api-reconciled) — per parent (cost_usd > 0, same tool exclusions):
--     (a) one row per unaccounted_usage_model child — the write-time capped
--         subtraction (D1-D3), model = child.model, reason NULL;
--     (b) ONE remainder row `parent − Σ children` WHEN the cost remainder is
--         positive (r2-H1: one rule, not three — the no-children case is this
--         rule with Σ children = 0). Reason = the parent's stamped
--         model_gap_reason ('provider-day-grain' = only github money backs the
--         key; 'awaiting-provider-detail' = no cost facts landed yet) when no
--         children exist, else 'unmodelled-provider-cost' (model-less provider
--         cost legitimately leaves Σ children < R — 0118:55-58, model is
--         nullable on cost rows). Σ over a key equals the parent in EVERY case:
--         the writer caps Σ children ≤ parent (0123), so the remainder is
--         never negative.
--
--   arm 3 (provider-usage) — v_teammate_usage_daily.usage_usd stays the
--     authoritative per-key total (headline pins stand); the view fans it out
--     against provider_usage_fact COST rows (model NOT NULL, aggregated across
--     `source` — the same source-omitting join the provider-day drawer ships)
--     for the (teammate, day, tool) key, plus ONE remainder row
--     `vtd − Σ fact models` only when > 0. A fully-modelled Anthropic surface
--     day has remainder 0 and NO NULL row; Copilot-agent money (day-grain by
--     mig 0120's CHECK — github money rows carry model NULL, so they never
--     enter the fan-out) lands whole on the remainder. This arm is a WHOLE-DAY
--     OBSERVED READ, no subtraction: these tools are ingest-only (excluded
--     from reconciliation), so no OTel operand exists.
--
--     THE OVERRUN GUARD (r1-H3): actual_spend (vtd's source) and
--     provider_usage_fact refresh independently, so a downward provider
--     revision can reach vtd before the facts do, leaving
--     Σ fact_model_usd > vtd total. Emitting the stale facts would make the
--     arm exceed its own authoritative total — so per key, when the facts
--     overrun, the view emits NO fan-out: one whole row, model NULL,
--     model_gap_reason = 'provider-revision-drift'. Conservative, conserving,
--     self-healing on the next fact refresh.
--
--     Remainder typing when the fan-out runs: 'provider-day-grain' for the
--     copilot-agent lane — the ONE github lane among the eight ingest-only
--     tools (v_teammate_usage_daily lanes github money into copilot-cli /
--     copilot-agent only, mig 0086/0101, and copilot-cli is not ingest-only),
--     so keying on the tool IS "the key's facts are github money", and it
--     still types correctly when the facts have not landed at all —
--     'surface-remainder' otherwise.
--
-- ONE VIEW STATEMENT, ONE MVCC SNAPSHOT: the fact aggregation, the overrun
-- decision and the remainder arithmetic are all CTEs of the single view query,
-- so a reader can never see a fan-out computed against one snapshot and its
-- remainder against another.
--
-- ROW MULTIPLICITY IS A CONSUMER CONTRACT CHANGE (r1-H4): a key that was one
-- view row can now be several. Dollar totals are invariant (Σ per key = the
-- old row's value, both arms), but per-row consumers (COUNT(*)) are audited in
-- the same slice — server/utils/me-queries.ts counts DISTINCT
-- (teammate, day, tool) as of this change.
--
-- Provenance values, arm-1 exclusions and security_invoker are unchanged.
-- Shape: CREATE OR REPLACE VIEW appending ONE trailing column
-- (model_gap_reason), the same backwards-compatible move as 0082/0089/0101/0113.
-- Base definition is 0113's — copied forward verbatim where unchanged
-- (immutable history: 0113 is not edited).
CREATE OR REPLACE VIEW v_complete_usage
WITH (security_invoker = true) AS
  WITH
  -- Σ of the write-time children per parent (0123). The writer guarantees
  -- Σ children ≤ parent for cost AND tokens (the descending cap), so the
  -- remainders below are never negative.
  uu_children AS (
    SELECT
      m.unaccounted_usage_id,
      SUM(m.cost_usd)::numeric(14, 6) AS child_usd,
      SUM(m.tokens)::bigint AS child_tokens
    FROM unaccounted_usage_model m
    GROUP BY m.unaccounted_usage_id
  ),
  -- The arm-3 per-model observed operand: provider_usage_fact COST rows,
  -- model NOT NULL, aggregated ACROSS sources for the (teammate, day, tool)
  -- key (mig 0121's index). Measure exclusivity (0118 measure_chk) makes the
  -- plain SUMs safe: SUM(cost_usd) sees only cost rows, the FILTERed token
  -- sum sees only token rows — a github MODEL row (requests-only) contributes
  -- neither and is dropped by the usd/tokens gate below; github money (model
  -- NULL, mig 0120) never enters at all. btrim mirrors the S1 writer (D9:
  -- pairing/display on the trimmed, case-preserved string).
  arm3_fact_model AS (
    SELECT
      f.teammate_id,
      f.date AS day,
      f.tool,
      btrim(f.model) AS model,
      COALESCE(SUM(f.cost_usd), 0)::numeric(14, 6) AS usd,
      COALESCE(
        SUM(COALESCE(f.input_tokens, 0) + COALESCE(f.output_tokens, 0))
          FILTER (WHERE f.cost_type IS NULL),
        0
      )::bigint AS tokens
    FROM provider_usage_fact f
    WHERE f.model IS NOT NULL
      AND f.teammate_id IS NOT NULL
      AND f.tool IN (
        'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
        'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
      )
    GROUP BY f.teammate_id, f.date, f.tool, btrim(f.model)
  ),
  -- The per-key fact totals the overrun guard and the remainder read.
  arm3_fact_key AS (
    SELECT teammate_id, day, tool,
           SUM(usd)::numeric(14, 6) AS fact_usd,
           SUM(tokens)::bigint AS fact_tokens
    FROM arm3_fact_model
    GROUP BY teammate_id, day, tool
  )
  -- ── Arm 1 (otel-emitted) — 0113's definition verbatim + the new column ─────
  SELECT
    ar.teammate_id, ar.region_id, ar.org_unit_id, ar.cost_owning_unit_id, ar.project_id, ar.tool,
    ar.ts_event, ar.cost_usd, ar.tokens,
    ar.model,
    ar.token_type,
    ar.identity_state,
    'otel-emitted'::text AS usage_provenance,     -- 0101: see shared/usage/provenance.ts
    ar.activity,                                   -- 0113
    NULL::text AS model_gap_reason                 -- 0124: a named model has no gap
  FROM attribution_record ar
  WHERE NOT EXISTS (
    SELECT 1 FROM session_quarantine sq
     WHERE sq.teammate_id = ar.teammate_id
       AND sq.conversation_id = ar.claude_session_id
       AND sq.resolved_at IS NULL
       AND sq.reason = 'api-uncorroborated'
  )
  AND ar.tool NOT IN (
    'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
    'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
  )
  UNION ALL
  -- ── Arm 2a (api-reconciled) — the write-time children (D4) ─────────────────
  -- Children inherit the parent's project_id, so a TAGGED fill day's models
  -- flow to its project. They carry the parent's day/activity/identity; only
  -- model, cost and tokens are their own.
  SELECT
    uu.teammate_id, uu.region_id, uu.org_unit_id, NULL::uuid AS cost_owning_unit_id, uu.project_id, uu.tool,
    (uu.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    m.cost_usd, m.tokens,
    m.model,
    'unknown'::text AS token_type,
    'confirmed'::text AS identity_state,
    'api-reconciled'::text AS usage_provenance,
    uu.activity,
    NULL::text AS model_gap_reason
  FROM unaccounted_usage uu
  JOIN unaccounted_usage_model m ON m.unaccounted_usage_id = uu.id
  WHERE uu.cost_usd > 0
    AND uu.tool NOT IN (
      'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
      'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
    )
  UNION ALL
  -- ── Arm 2b (api-reconciled) — the reason-typed remainder (D3 step 4) ───────
  -- ONE rule for the with-children shortfall, the no-children case (Σ = 0) and
  -- everything between: emit `parent − Σ children` when positive, typed by the
  -- parent's stamped reason, else 'unmodelled-provider-cost'.
  SELECT
    uu.teammate_id, uu.region_id, uu.org_unit_id, NULL::uuid AS cost_owning_unit_id, uu.project_id, uu.tool,
    (uu.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    (uu.cost_usd - COALESCE(c.child_usd, 0))::numeric(14, 6) AS cost_usd,
    GREATEST(0, COALESCE(uu.tokens, 0) - COALESCE(c.child_tokens, 0))::bigint AS tokens,
    NULL::text AS model,
    'unknown'::text AS token_type,
    'confirmed'::text AS identity_state,
    'api-reconciled'::text AS usage_provenance,
    uu.activity,
    COALESCE(uu.model_gap_reason, 'unmodelled-provider-cost') AS model_gap_reason
  FROM unaccounted_usage uu
  LEFT JOIN uu_children c ON c.unaccounted_usage_id = uu.id
  WHERE uu.cost_usd > 0
    AND uu.tool NOT IN (
      'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
      'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
    )
    AND uu.cost_usd - COALESCE(c.child_usd, 0) > 0
  UNION ALL
  -- ── Arm 3a (provider-usage) — the observed per-model fan-out (D5) ──────────
  -- Guarded: a key whose facts overrun its authoritative vtd total emits NO
  -- fan-out (see arm 3b). Equality is NOT an overrun — a fully-modelled day
  -- fans out completely and emits no NULL row at all.
  SELECT
    vtd.teammate_id, vtd.region_id, vtd.org_unit_id, vtd.cost_owning_unit_id, NULL::uuid AS project_id, vtd.tool,
    (vtd.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    fm.usd AS cost_usd, fm.tokens,
    fm.model,
    'unknown'::text AS token_type,
    'confirmed'::text AS identity_state,
    'provider-usage'::text AS usage_provenance,
    NULL::text AS activity,                        -- 0113: untaggable ⇒ no activity axis
    NULL::text AS model_gap_reason
  FROM v_teammate_usage_daily vtd
  JOIN arm3_fact_key fk
    ON fk.teammate_id = vtd.teammate_id AND fk.day = vtd.day AND fk.tool = vtd.tool
  JOIN arm3_fact_model fm
    ON fm.teammate_id = vtd.teammate_id AND fm.day = vtd.day AND fm.tool = vtd.tool
  WHERE vtd.usage_usd > 0
    AND fk.fact_usd <= vtd.usage_usd
    AND (fm.usd > 0 OR fm.tokens > 0)
    -- INGEST_ONLY_USAGE_TOOLS (shared/usage/surface.ts) — MUST match exactly
    -- (pinned by tests/unit/usage/surface.test.ts's migration-0101 block).
    AND vtd.tool IN (
      'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
      'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
    )
  UNION ALL
  -- ── Arm 3b (provider-usage) — the remainder / overrun row (D5, r1-H3) ──────
  -- Normal: `vtd − Σ fact models` when positive (Copilot-agent money lands
  -- here WHOLE — github money rows carry no model, so its fan-out Σ is 0).
  -- Overrun: the WHOLE day, unfanned, 'provider-revision-drift'.
  -- Σ per key = vtd.usage_usd in every case.
  SELECT
    vtd.teammate_id, vtd.region_id, vtd.org_unit_id, vtd.cost_owning_unit_id, NULL::uuid AS project_id, vtd.tool,
    (vtd.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    CASE WHEN COALESCE(fk.fact_usd, 0) > vtd.usage_usd
         THEN vtd.usage_usd
         ELSE (vtd.usage_usd - COALESCE(fk.fact_usd, 0))::numeric(14, 6)
    END AS cost_usd,
    CASE WHEN COALESCE(fk.fact_usd, 0) > vtd.usage_usd
         THEN COALESCE(vtd.tokens, 0)::bigint
         ELSE GREATEST(0, COALESCE(vtd.tokens, 0) - COALESCE(fk.fact_tokens, 0))::bigint
    END AS tokens,
    NULL::text AS model,
    'unknown'::text AS token_type,
    'confirmed'::text AS identity_state,
    'provider-usage'::text AS usage_provenance,
    NULL::text AS activity,                        -- 0113: untaggable ⇒ no activity axis
    CASE WHEN COALESCE(fk.fact_usd, 0) > vtd.usage_usd THEN 'provider-revision-drift'
         WHEN vtd.tool = 'copilot-agent' THEN 'provider-day-grain'
         ELSE 'surface-remainder'
    END AS model_gap_reason
  FROM v_teammate_usage_daily vtd
  LEFT JOIN arm3_fact_key fk
    ON fk.teammate_id = vtd.teammate_id AND fk.day = vtd.day AND fk.tool = vtd.tool
  WHERE vtd.usage_usd > 0
    AND vtd.tool IN (
      'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
      'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
    )
    AND (COALESCE(fk.fact_usd, 0) > vtd.usage_usd
         OR vtd.usage_usd - COALESCE(fk.fact_usd, 0) > 0);

COMMENT ON VIEW v_complete_usage IS
  'Per-teammate COMPLETE usage = attribution_record (OTel, minus dev-confirmed forgeries) UNION ALL unaccounted_usage fanned into its write-time per-model children + ONE reason-typed remainder per parent (0123/0124, 07-model-axis-subtraction-build.md D4) UNION ALL the ingest-only completeness arm fanned against provider_usage_fact cost rows + ONE reason-typed remainder per (teammate, day, tool), overrun-guarded (0124, D5). Σ per key still equals the parent / vtd total in every case — dollar totals are invariant, but one key can now be SEVERAL rows: per-row consumers must count DISTINCT keys (r1-H4). Carries (model, token_type) [0082], identity_state [0089], usage_provenance [0101], activity [0113] and model_gap_reason [0124: NULL on named-model rows; ''provider-day-grain'' | ''awaiting-provider-detail'' | ''unmodelled-provider-cost'' | ''surface-remainder'' | ''provider-revision-drift'' on remainders — readers must treat an unrecognised reason as a plain remainder, never a category]. THE single §A lane for project spend at every grain (server/usage/complete-spend.ts). usage-completeness-and-provider-governance.md §3.1.';
