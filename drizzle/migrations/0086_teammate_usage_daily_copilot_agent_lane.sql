-- 0086 — §A Copilot usage-lane split (copilot-surface-lanes design D4):
-- lane the v_teammate_usage_daily copilot branch by reconciliation category.
--
-- reconciliation_record already distinguishes the per-(user, day) Copilot usage
-- categories (GitHub ai_credit/usage, engine-persisted at day grain):
--   copilot_interactive   → tool 'copilot-cli'   (keeps its id for continuity —
--                           it is the OTel wire tool literal and the historical
--                           attribution/actual-spend value)
--   copilot_coding_agent  → tool 'copilot-agent' (OTel-INVISIBLE / ingest_only:
--                           usage DISPLAY only — never taggable, never
--                           OTel-joined, never a charge)
-- Any other/legacy category value defaults to 'copilot-cli' (the CASE ELSE; the
-- github adapter emits exactly the two categories above for teammate scope, and
-- reconciliation_record.category is NOT NULL — the default is belt-and-braces).
--
-- The category is already part of the DISTINCT ON logical key, so laning by it
-- cannot double-count: each category's live row lands in exactly one lane.
--
-- INTENTIONAL SURFACE DIVERGENCE (owner decision, r1 finding 5): 'copilot-agent'
-- is §A-VISIBLE through THIS view (v_teammate_usage_daily → e.g. the Finance
-- Overage-Drivers weight) but ABSENT from the v_complete_usage completeness
-- rollups (Across/Regional/Cost-Centre usage cards). v_complete_usage =
-- attribution_record ∪ unaccounted_usage, and the coding-agent lane feeds
-- NEITHER: it is OTel-invisible (no attribution rows) and ingest_only-excluded
-- from the needs-tagging reconciliation (no unaccounted rows — see
-- server/usage/unaccounted-reconciliation.ts). Folding it into v_complete_usage
-- would require a NON-TAGGABLE completeness feed (a third union arm that must
-- never become a worklist item) — an owner follow-up, deliberately out of scope
-- here. Pinned by tests/integration/usage/copilot-usage-completeness.test.ts.
--
-- Everything else is 0084 verbatim: the DISTINCT ON lifecycle logic, the
-- security_invoker, and the Claude exclusion list (which MUST equal
-- NON_CODE_CLAUDE_TOOLS in shared/usage/surface.ts — the drift-pin unit test
-- tests/unit/usage/surface.test.ts parses this file's NOT IN literals).
-- 'copilot-agent' joins 'copilot-cli' in the actual_spend exclusion for the
-- 0073 reason: BOTH copilot usage tools source from reconciliation_record, so
-- if a §B bill writer ever lands either tool in actual_spend the two sources
-- can never double-count.
--
-- CREATE OR REPLACE (same column signature as 0084) keeps the view's OID.
CREATE OR REPLACE VIEW v_teammate_usage_daily
WITH (security_invoker = true) AS
  SELECT
    a.teammate_id,
    a.date AS day,
    a.tool,
    SUM(a.cost_usd)::numeric(14, 6) AS usage_usd,
    SUM(a.input_tokens + a.output_tokens)::bigint AS tokens
  FROM actual_spend a
  WHERE a.tool NOT IN (
    'copilot-cli',    -- copilot usage truth is reconciliation_record (gross), not the pooled bill
    'copilot-agent',  -- same reason (D4 coding-agent lane, sourced below)
    -- #142 non-Code Claude surfaces: §B chargeback lanes, never §A-taggable.
    'claude-ai',
    'claude-cowork',
    'claude-office',
    'claude-chrome',
    'claude-design',
    'claude-slack',
    'claude-other'
  )
  GROUP BY a.teammate_id, a.date, a.tool
  UNION ALL
  SELECT
    cur.teammate_id,
    cur.period_date AS day,
    cur.tool,
    SUM(cur.actual_usd)::numeric(14, 6) AS usage_usd,
    NULL::bigint AS tokens          -- copilot is metered in ai-credits, not tokens
  FROM (
    -- The single live row per logical key (see the LIFECYCLE note in 0073): non-terminal status,
    -- highest precedence (applied beats a lingering proposed), newest computed_at as tiebreak.
    SELECT DISTINCT ON (r.provider, r.enterprise_ref, r.period_date, r.category, r.scope, r.teammate_id)
      r.teammate_id, r.period_date, r.actual_usd,
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
  'Per-(teammate, day, tool) provider USAGE truth for §A reconciliation (provider-billing-attribution-model.md §A). claude-code from actual_spend; Copilot gross from reconciliation_record, laned by category (copilot_interactive → copilot-cli, copilot_coding_agent → copilot-agent; copilot-agent is DISPLAY-only — ingest_only, never taggable). Non-Code Claude surfaces (#142) are §B-only and excluded. NOT the §B bill.';
