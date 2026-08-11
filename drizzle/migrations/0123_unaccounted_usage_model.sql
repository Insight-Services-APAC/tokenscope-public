-- 0123 — unaccounted_usage_model: the fill's per-model residual, stored where
-- it is computed.
--
-- Design: docs/design/reporting-consolidation/07-model-axis-subtraction-build.md
-- D1 (owner ruling 2026-08-04). A fill day's model split is
-- `cap(API_model − OTel_model)` — a subtraction of two OBSERVED operands, never
-- an apportionment. Both operands exist: provider_usage_fact carries per-model
-- cost AND token rows (0118; cost rows carry `model`), and
-- attribution_record.model is NOT NULL. The 05-doc's "a residual cannot carry a
-- model breakdown" reasoned from unaccounted_usage's (teammate, day, tool)
-- grain — a fact about mig 0071, not about the sources.
--
-- WHY CHILD ROWS, WRITTEN AT WRITE TIME (D1):
--   1. The stored fill is the taggable amount. A read-time split computed from
--      live lanes drifts from the stored cost_usd whenever either lane moved
--      since the 2h write. Same transaction ⇒ Σ children = parent at every
--      read, forever.
--   2. The OTel operand is not reproducible in a view — the parent subtracts
--      corroboratedOtelDaily (quarantine-excluded, self-billed-excluded per
--      complete cell, server/usage/corroborated-otel.ts). A view restating that
--      operand would be a second implementation of it.
--   3. No `model` column lands on unaccounted_usage itself: the
--      (teammate, day, tool) unique key stands, one row stays ONE tagging
--      decision. Children carry no tagging columns; tag-unaccounted.ts is
--      untouched.
--
-- LIFECYCLE (r1-M1): replaced wholesale on every parent recompute by
-- server/usage/unaccounted-reconciliation.ts, in the SAME transaction as the
-- parent upsert. The undecided-orphan DELETE cascades through the FK; the
-- decided-orphan zero-out deletes the zeroed parents' children in the same
-- statement set — a zeroed parent with surviving children would break
-- Σ children = parent silently.
--
-- INERT ON ARRIVAL (S1). Nothing reads this table yet — no view, no route, no
-- report. v_complete_usage's arm-2 fan-out (D4) is the S2 slice.
CREATE TABLE unaccounted_usage_model (
  unaccounted_usage_id uuid NOT NULL REFERENCES unaccounted_usage(id) ON DELETE CASCADE,
  model                text NOT NULL,
  -- The capped residual allocation, never negative (D3: floored subtraction,
  -- then the deterministic descending cap — a named cell is its observed
  -- subtraction or that subtraction truncated, never inflated).
  cost_usd             numeric(14,6) NOT NULL CHECK (cost_usd >= 0),
  -- The identical pipeline over the TOKEN lane (input+output per model vs OTel
  -- tokens per model), capped against parent.tokens. Cost and tokens are
  -- subtracted from their own lanes, never each other's proportions.
  tokens               bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  PRIMARY KEY (unaccounted_usage_id, model)
);

COMMENT ON TABLE unaccounted_usage_model IS
  'Per-model residual of one unaccounted_usage fill row (07-model-axis-subtraction-build.md D1): cap(GREATEST(0, API_model − OTel_model)) computed at write time by unaccounted-reconciliation.ts in the SAME transaction as the parent upsert, replaced wholesale per run. Observed subtraction, never apportionment. Carries no tagging columns — the parent stays the one tagging decision. Σ children ≤ parent always; the shortfall is the view''s reason-typed remainder (D3 step 4).';

-- Gap typing (r1-H5): stamped by the writer — the one place that knows why
-- children are absent. 'provider-day-grain' = the key's only cost-bearing
-- facts are github money (mig 0120: Copilot money is day-grain by
-- construction, no per-model dollars exist). 'awaiting-provider-detail' = no
-- cost-bearing facts have landed for the key yet (2h vs 1h cadence — a
-- transient that heals on the next fact refresh). NULL = children were
-- written. This is NOT a model column; the (teammate, day, tool) key and the
-- one-tagging-decision rule stand.
ALTER TABLE unaccounted_usage ADD COLUMN model_gap_reason text;

COMMENT ON COLUMN unaccounted_usage.model_gap_reason IS
  'Why this fill row has no unaccounted_usage_model children (07-model-axis-subtraction-build.md r1-H5): ''provider-day-grain'' = only github money backs the key (Copilot sends no per-model dollars, mig 0120); ''awaiting-provider-detail'' = no cost-bearing provider facts landed yet (transient); NULL = children exist (or there is nothing to explain). Stamped by unaccounted-reconciliation.ts on every recompute.';
