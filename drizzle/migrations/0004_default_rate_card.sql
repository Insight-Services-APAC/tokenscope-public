-- Default rate cards — Anthropic Claude Code list-basis.
--
-- Per data-model.md §rate_card: every Claude attribution_record pins a
-- rate_card_id at write time (COST-7). Without at least one card per
-- tool, the read joiner has nothing to pin to.
--
-- NOTE: GitHub Copilot CLI does NOT use a token rate card — its cost is
-- computed from AI credits via a joiner constant (COPILOT_AI_CREDIT_USD in
-- azure-monitor-reader.ts, migration 0036). The former github:copilot-cli
-- rate_card + rate_lines are removed (§3.7 locked decision). Do not re-add.
--
-- These cards use the v0.1 pilot prices. Update via the rate-card admin
-- endpoint (Epic 7+) for real prices; the migration is idempotent on
-- INSERT ... ON CONFLICT DO NOTHING so re-applying doesn't double-insert.

-- Anthropic Claude — Sonnet 4.x pricing (per 1M tokens; values are
-- placeholder pilot prices and should be replaced via the rate-card
-- admin flow before any cost decisions land on production data).
INSERT INTO rate_card (id, scope_key, effective, basis, provenance, version)
VALUES
  (
    '90000000-0000-4000-8000-000000000001',
    'anthropic:claude-code',
    '[2026-01-01, 2099-01-01)'::tstzrange,
    'list',
    '{"source": "pilot-placeholder", "note": "replace via rate-card admin before cost-bearing usage"}'::jsonb,
    1
  )
ON CONFLICT DO NOTHING;

-- Rate lines per token type. unit_qty = 1_000_000 (per 1M tokens);
-- unit_cost_usd values are pilot placeholders.
INSERT INTO rate_line (rate_card_id, unit, unit_qty, unit_cost_usd, model, notes)
VALUES
  ('90000000-0000-4000-8000-000000000001', 'input',       1000000, 3.00,  NULL, 'Sonnet input — placeholder'),
  ('90000000-0000-4000-8000-000000000001', 'output',      1000000, 15.00, NULL, 'Sonnet output — placeholder'),
  ('90000000-0000-4000-8000-000000000001', 'cache-read',  1000000, 0.30,  NULL, 'placeholder'),
  ('90000000-0000-4000-8000-000000000001', 'cache-write', 1000000, 3.75,  NULL, 'placeholder')
ON CONFLICT DO NOTHING;

