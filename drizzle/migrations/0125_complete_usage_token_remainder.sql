-- 0125 — token conservation gets its own remainder predicate: a key's remainder
-- row is emitted when the COST remainder OR the TOKEN remainder is positive.
--
-- Design: docs/design/reporting-consolidation/07-model-axis-subtraction-build.md
-- D3/D4/D5 (the calibration rule bounds the fix). 0124 gated BOTH remainder
-- arms on the cost remainder alone, so a parent whose children covered the
-- money exactly but not the tokens ($10/5000tok parent, children $10/3000tok)
-- emitted no remainder row and silently dropped 2000 tokens — token
-- conservation (design tests 2/7: Σ view tokens per key = parent tokens) held
-- only when the cost remainder happened to be positive too. Arm 3 likewise
-- reconciled tokens only when cost did.
--
-- THE RULE (this migration): per key, emit the ONE remainder row whenever
-- `cost remainder > 0 OR token remainder > 0`, with each measure independently
-- GREATEST(0, …)-capped — a token-only shortfall reaches the remainder row as
-- $0 + the missing tokens, and a cost-only shortfall carries 0 tokens. Cost and
-- tokens stay subtracted from their OWN lanes (05 Decision 4), never gated on
-- each other.
--
-- WHAT DOES NOT CHANGE (calibration rule: simple over bill-grade):
--   * The arm-3 OVERRUN state is still evaluated on COST alone — no
--     token-overrun state is invented; a fact-token overrun simply floors the
--     token remainder to 0 as before.
--   * Arm 2's `WHERE uu.cost_usd > 0` parent scope — pre-0123 behaviour, not
--     part of this fix. Likewise arm 3's `vtd.usage_usd > 0`.
--   * Everything else is 0124's definition, copied forward verbatim
--     (immutable history: 0124 is not edited — it may already be applied).
--
-- Same shape, same columns, CREATE OR REPLACE — see 0124's header for the full
-- per-arm rationale; only the remainder predicates and their cost caps moved.
CREATE OR REPLACE VIEW v_complete_usage
WITH (security_invoker = true) AS
  WITH
  -- Σ of the write-time children per parent (0123). The writer guarantees
  -- Σ children ≤ parent for cost AND tokens (the descending cap), so the
  -- remainders below are never negative — the GREATEST(0, …) caps are belt
  -- and braces per measure, not load-bearing arithmetic.
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
  -- everything between: emit the remainder row when the COST remainder OR the
  -- TOKEN remainder is positive (0125), each measure GREATEST(0, …)-capped
  -- independently, typed by the parent's stamped reason, else
  -- 'unmodelled-provider-cost'. A cost-exact/token-short parent surfaces as a
  -- $0 row carrying the missing tokens — token conservation does not depend on
  -- the money also falling short.
  SELECT
    uu.teammate_id, uu.region_id, uu.org_unit_id, NULL::uuid AS cost_owning_unit_id, uu.project_id, uu.tool,
    (uu.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    GREATEST(0, uu.cost_usd - COALESCE(c.child_usd, 0))::numeric(14, 6) AS cost_usd,
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
    AND (uu.cost_usd - COALESCE(c.child_usd, 0) > 0
         OR COALESCE(uu.tokens, 0) - COALESCE(c.child_tokens, 0) > 0)
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
  -- Normal: emitted when the cost remainder OR the token remainder is positive
  -- (0125 — a cost-exact day whose facts carry fewer tokens than vtd still
  -- reconciles its tokens through a $0 remainder row). Copilot-agent money
  -- lands here WHOLE — github money rows carry no model, so its fan-out Σ is 0.
  -- Overrun: still decided on COST alone (no token-overrun state — calibration
  -- rule): the WHOLE day, unfanned, 'provider-revision-drift'.
  -- Σ per key = vtd.usage_usd in every case, and Σ tokens per key = vtd.tokens.
  SELECT
    vtd.teammate_id, vtd.region_id, vtd.org_unit_id, vtd.cost_owning_unit_id, NULL::uuid AS project_id, vtd.tool,
    (vtd.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    CASE WHEN COALESCE(fk.fact_usd, 0) > vtd.usage_usd
         THEN vtd.usage_usd
         ELSE GREATEST(0, vtd.usage_usd - COALESCE(fk.fact_usd, 0))::numeric(14, 6)
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
         OR vtd.usage_usd - COALESCE(fk.fact_usd, 0) > 0
         OR COALESCE(vtd.tokens, 0) - COALESCE(fk.fact_tokens, 0) > 0);

COMMENT ON VIEW v_complete_usage IS
  'Per-teammate COMPLETE usage = attribution_record (OTel, minus dev-confirmed forgeries) UNION ALL unaccounted_usage fanned into its write-time per-model children + ONE reason-typed remainder per parent (0123/0124, 07-model-axis-subtraction-build.md D4) UNION ALL the ingest-only completeness arm fanned against provider_usage_fact cost rows + ONE reason-typed remainder per (teammate, day, tool), overrun-guarded (0124, D5). The remainder row is emitted when the COST remainder OR the TOKEN remainder is positive, each measure GREATEST(0,…)-capped independently (0125) — token conservation does not depend on the money also falling short. Σ per key still equals the parent / vtd total in every case, for cost AND tokens — dollar totals are invariant, but one key can now be SEVERAL rows: per-row consumers must count DISTINCT keys (r1-H4). Carries (model, token_type) [0082], identity_state [0089], usage_provenance [0101], activity [0113] and model_gap_reason [0124: NULL on named-model rows; ''provider-day-grain'' | ''awaiting-provider-detail'' | ''unmodelled-provider-cost'' | ''surface-remainder'' | ''provider-revision-drift'' on remainders — readers must treat an unrecognised reason as a plain remainder, never a category]. THE single §A lane for project spend at every grain (server/usage/complete-spend.ts). usage-completeness-and-provider-governance.md §3.1.';
