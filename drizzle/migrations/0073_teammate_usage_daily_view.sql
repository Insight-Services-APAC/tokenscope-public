-- 0073: v_teammate_usage_daily — the per-user provider USAGE truth that §A reconciles against.
--
-- Intent: docs/design/provider-billing-attribution-model.md §A. §A reconciles OTel against the
-- provider's per-(teammate, DAY) USAGE — a concern SEPARATE from the §B bill. The usage truth
-- lives in a different place per tool, and this view is the single point that encodes that:
--
--   claude-code   → actual_spend (Anthropic is pure-metered, so the bill row IS the usage).
--   copilot-cli   → reconciliation_record.actual_usd — per-user GROSS usage from GitHub's
--                   ai_credit/usage API, which is per-(user, DAY) (verified live 2026-06-08);
--                   the reconciliation engine persists it at period_date day grain,
--                   scope='teammate', one row per category (copilot_interactive +
--                   copilot_coding_agent). Summed across categories/enterprises = the day's
--                   gross usage.
--
-- LIFECYCLE (load-bearing): a logical key is (provider, enterprise_ref, period_date, category,
-- scope, teammate_id). Today every row is status='proposed' (the 0038 partial-unique index
-- guarantees ONE proposed row per key). When an apply/supersede lifecycle lands (F2 booking
-- worker: proposed→applied in place, or supersede = mark old 'superseded' + insert a new row),
-- §A must keep reading the CURRENT live row per key — NOT just 'proposed', or applied usage
-- silently drops out and §A under-counts (the exact failure §A exists to prevent). So we take
-- the single highest-precedence non-terminal row per key (DISTINCT ON): this is correct for v1
-- (picks the only proposed row) AND robust to F2 (picks applied; never double-counts a
-- proposed+applied pair; ignores rejected/superseded).
-- F2 NOTE: the 0038 partial-unique guards only 'proposed', so it does NOT stop two non-terminal
-- rows (e.g. two 'applied') from coexisting per key once F2 lands. The DISTINCT ON resolves that
-- to newest-wins (computed_at DESC) — acceptable, but F2 should extend the partial-unique to
-- status IN ('proposed','applied') so the invariant is enforced, not just resolved here.
--
-- This corrects an earlier wrong call ("Copilot has no per-(user, day) usage truth"): the GitHub
-- API exposes it natively AND the engine already persisted it — the §A readers just weren't
-- reading it. Copilot's POOLED per-cost-centre BILL (§B) is a different axis and must NOT be
-- conflated with this per-user USAGE.
--
-- Copilot usage is deliberately EXCLUDED from the actual_spend branch (tool <> 'copilot-cli') so
-- that if/when the §B Copilot bill writer lands rows in actual_spend, the two sources can never
-- double-count: usage comes from reconciliation_record, the bill from actual_spend.
--
-- security_invoker: the view respects the underlying tables' RLS (the reconciliation worker runs
-- as the service role and sees everything; any future RLS-scoped reader stays constrained).

CREATE VIEW v_teammate_usage_daily
WITH (security_invoker = true) AS
  SELECT
    a.teammate_id,
    a.date AS day,
    a.tool,
    SUM(a.cost_usd)::numeric(14, 6) AS usage_usd,
    SUM(a.input_tokens + a.output_tokens)::bigint AS tokens
  FROM actual_spend a
  WHERE a.tool <> 'copilot-cli'   -- copilot usage truth is reconciliation_record (gross), not the pooled bill
  GROUP BY a.teammate_id, a.date, a.tool
  UNION ALL
  SELECT
    cur.teammate_id,
    cur.period_date AS day,
    'copilot-cli'::text AS tool,
    SUM(cur.actual_usd)::numeric(14, 6) AS usage_usd,
    NULL::bigint AS tokens          -- copilot is metered in ai-credits, not tokens
  FROM (
    -- The single live row per logical key (see LIFECYCLE note above): non-terminal status,
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
  'Per-(teammate, day, tool) provider USAGE truth for §A reconciliation (provider-billing-attribution-model.md §A). claude-code from actual_spend; copilot-cli gross from reconciliation_record. NOT the §B bill.';
