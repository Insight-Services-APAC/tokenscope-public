-- 0061: model-specific rate_line rows — fix the Sonnet-priced-everything cost drift.
--
-- THE BUG: migration 0004 seeds ONLY wildcard (model = NULL) rate_line rows on the
-- canonical anthropic:claude-code card, holding placeholder SONNET prices. computeCost()
-- (server/workers/azure-monitor-reader.ts) prefers an exact (unit, model) match and
-- falls back to the model = NULL wildcard — so with no model-specific rows EVERY model,
-- including claude-opus-4-8, was costed at Sonnet rates. Admin cost-drift diagnostics
-- showed ~50.5% mean drift vs provider cost (worst span claude-opus-4-8:
-- rate-card $3.63 vs provider $9.67).
--
-- THE FIX: add model-specific rate_line rows with correct current Anthropic public list
-- prices against the SAME card (id 90000000-…-0001, scope_key anthropic:claude-code).
-- The wildcard (model = NULL) rows from 0004 are KEPT, unchanged, as the fallback for
-- unknown future model ids.
--
-- Values: public list prices as of 2026-06, per 1M tokens (unit_qty = 1000000).
-- cache-read = 0.1× input; cache-write uses the 5-MINUTE (1.25×) TTL basis. Residual
-- drift on cache-write-heavy spans (Claude's own usage may mix 5m and 1h cache writes)
-- is to be re-measured post-deploy via the admin cost-drift diagnostic.
--
-- Idempotent: ON CONFLICT (rate_card_id, unit, model) DO NOTHING against the table's
-- UNIQUE (rate_card_id, unit, model) constraint (mig 0001). The new rows all carry a
-- NON-NULL model, so the conflict target matches them deterministically and they never
-- collide with the wildcard model = NULL rows (NULLs compare distinct in a UNIQUE index).

INSERT INTO rate_line (rate_card_id, unit, unit_qty, unit_cost_usd, model, notes)
VALUES
  -- Opus 4.x (4.8 / 4.7 / 4.6): input $5 / output $25 per 1M
  ('90000000-0000-4000-8000-000000000001', 'input',       1000000, 5.00,  'claude-opus-4-8', 'Opus 4.x list — 2026-06'),
  ('90000000-0000-4000-8000-000000000001', 'output',      1000000, 25.00, 'claude-opus-4-8', 'Opus 4.x list — 2026-06'),
  ('90000000-0000-4000-8000-000000000001', 'cache-read',  1000000, 0.50,  'claude-opus-4-8', 'Opus 4.x — 0.1× input'),
  ('90000000-0000-4000-8000-000000000001', 'cache-write', 1000000, 6.25,  'claude-opus-4-8', 'Opus 4.x — 1.25× input (5m TTL)'),

  ('90000000-0000-4000-8000-000000000001', 'input',       1000000, 5.00,  'claude-opus-4-7', 'Opus 4.x list — 2026-06'),
  ('90000000-0000-4000-8000-000000000001', 'output',      1000000, 25.00, 'claude-opus-4-7', 'Opus 4.x list — 2026-06'),
  ('90000000-0000-4000-8000-000000000001', 'cache-read',  1000000, 0.50,  'claude-opus-4-7', 'Opus 4.x — 0.1× input'),
  ('90000000-0000-4000-8000-000000000001', 'cache-write', 1000000, 6.25,  'claude-opus-4-7', 'Opus 4.x — 1.25× input (5m TTL)'),

  ('90000000-0000-4000-8000-000000000001', 'input',       1000000, 5.00,  'claude-opus-4-6', 'Opus 4.x list — 2026-06'),
  ('90000000-0000-4000-8000-000000000001', 'output',      1000000, 25.00, 'claude-opus-4-6', 'Opus 4.x list — 2026-06'),
  ('90000000-0000-4000-8000-000000000001', 'cache-read',  1000000, 0.50,  'claude-opus-4-6', 'Opus 4.x — 0.1× input'),
  ('90000000-0000-4000-8000-000000000001', 'cache-write', 1000000, 6.25,  'claude-opus-4-6', 'Opus 4.x — 1.25× input (5m TTL)'),

  -- Sonnet 4.6: input $3 / output $15 per 1M
  ('90000000-0000-4000-8000-000000000001', 'input',       1000000, 3.00,  'claude-sonnet-4-6', 'Sonnet 4.6 list — 2026-06'),
  ('90000000-0000-4000-8000-000000000001', 'output',      1000000, 15.00, 'claude-sonnet-4-6', 'Sonnet 4.6 list — 2026-06'),
  ('90000000-0000-4000-8000-000000000001', 'cache-read',  1000000, 0.30,  'claude-sonnet-4-6', 'Sonnet 4.6 — 0.1× input'),
  ('90000000-0000-4000-8000-000000000001', 'cache-write', 1000000, 3.75,  'claude-sonnet-4-6', 'Sonnet 4.6 — 1.25× input (5m TTL)'),

  -- Haiku 4.5: input $1 / output $5 per 1M
  ('90000000-0000-4000-8000-000000000001', 'input',       1000000, 1.00,  'claude-haiku-4-5', 'Haiku 4.5 list — 2026-06'),
  ('90000000-0000-4000-8000-000000000001', 'output',      1000000, 5.00,  'claude-haiku-4-5', 'Haiku 4.5 list — 2026-06'),
  ('90000000-0000-4000-8000-000000000001', 'cache-read',  1000000, 0.10,  'claude-haiku-4-5', 'Haiku 4.5 — 0.1× input'),
  ('90000000-0000-4000-8000-000000000001', 'cache-write', 1000000, 1.25,  'claude-haiku-4-5', 'Haiku 4.5 — 1.25× input (5m TTL)')
ON CONFLICT (rate_card_id, unit, model) DO NOTHING;
