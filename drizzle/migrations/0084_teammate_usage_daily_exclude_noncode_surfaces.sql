-- 0084 — exclude non-Code Claude surfaces from the §A usage-reconciliation seam (#142)
--
-- v_teammate_usage_daily feeds reconcileUnaccountedUsage / detectOverEmission —
-- the §A "needs tagging" flow (provider-billing-attribution-model.md §A). The
-- per-surface chargeback split (#142) makes the enterprise analytics poll write
-- actual_spend rows for chat / Cowork / Office / Chrome / Design / Slack /
-- other lanes; those surfaces are §B (chargeback) ONLY — they have no OTel
-- telemetry, no sessions, and are deliberately untaggable ("tagging is
-- Code-only"). Without this exclusion every non-Code dollar would surface as a
-- taggable "unaccounted usage" record in the developer worklist.
--
-- The tool list below MUST equal NON_CODE_CLAUDE_TOOLS in
-- shared/usage/surface.ts (a SQL view cannot import TS; the unit test
-- tests/unit/usage/surface.test.ts pins the two together so drift fails CI).
--
-- copilot-cli stays excluded for its original reason (its usage truth is
-- reconciliation_record, not the pooled bill) — see 0073_teammate_usage_daily_view.sql.
DROP VIEW IF EXISTS v_teammate_usage_daily;
CREATE VIEW v_teammate_usage_daily
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
    'copilot-cli'::text AS tool,
    SUM(cur.actual_usd)::numeric(14, 6) AS usage_usd,
    NULL::bigint AS tokens          -- copilot is metered in ai-credits, not tokens
  FROM (
    -- The single live row per logical key (see the LIFECYCLE note in 0073): non-terminal status,
    -- highest precedence (applied beats a lingering proposed), newest computed_at as tiebreak.
    SELECT DISTINCT ON (r.provider, r.enterprise_ref, r.period_date, r.category, r.scope, r.teammate_id)
      r.teammate_id, r.period_date, r.actual_usd
    FROM reconciliation_record r
    WHERE r.provider = 'github'
      AND r.scope = 'teammate'
      AND r.teammate_id IS NOT NULL
      AND r.status NOT IN ('rejected', 'superseded')
    ORDER BY r.provider, r.enterprise_ref, r.period_date, r.category, r.scope, r.teammate_id,
             CASE r.status WHEN 'applied' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
             r.computed_at DESC
  ) cur
  GROUP BY cur.teammate_id, cur.period_date;

COMMENT ON VIEW v_teammate_usage_daily IS
  'Per-(teammate, day, tool) provider USAGE truth for §A reconciliation (provider-billing-attribution-model.md §A). claude-code from actual_spend; copilot-cli gross from reconciliation_record. Non-Code Claude surfaces (#142) are §B-only and excluded. NOT the §B bill.';
