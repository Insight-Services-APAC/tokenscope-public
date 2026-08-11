-- 0120 — provider_usage_fact grows its GitHub arm (task #49).
--
-- No new columns. What this migration adds is the ONE structural rule the
-- GitHub arm needs, and the corrected column semantics 0118 could not state
-- because only one provider existed when it was written.
--
-- ── THE TABLE NOW HOLDS TWO KINDS OF MONEY, AND SAYS SO ─────────────────────
--
-- 0118 called this "the BILLED lane" and asserted one invariant for the whole
-- table:
--
--     Σ provider_usage_fact.cost_usd = actual_spend.cost_usd
--       per (teammate, date, tool, source)
--
-- THAT INVARIANT IS ANTHROPIC-ONLY, and it does not transfer to Copilot:
--
--   * Anthropic's cost report gives a per-(actor, day, product, model,
--     cost_type) AMOUNT — what the provider charged. Those rows have an
--     actual_spend row to conserve against, and they still do.
--   * Copilot's per-user figure is CONSUMPTION: `ai_credits_used`, GitHub's own
--     "the same AI credits consumption data used in the usage-based billing
--     API", GROSS, before the included allowance. Its authoritative BILL is
--     `copilot_pool_bill` (mig 0080) at (org, sku, month) — POOLED per cost
--     centre and NET. There is no per-user invoice figure to conserve against,
--     and pooled rows cannot live in actual_spend at all (teammate_id NOT NULL,
--     mig 0001:301).
--
-- So the GitHub arm claims a DIFFERENT invariant — conservation with the
-- reconciliation ledger it derives from — and does not claim a weaker version of
-- the Anthropic one. Both are stated in full, and proven, in
-- server/workers/provider-transform-github.ts and
-- tests/integration/provider/provider-transform-github.test.ts.
--
-- A READER MUST DISCRIMINATE BEFORE SUMMING cost_usd ACROSS PROVIDERS. The
-- discriminators are `provider` and `cost_type`, and the column comments below
-- are where that is recorded for anyone who reaches the schema first. A blind
-- SUM over the whole table adds billed dollars to consumption dollars and is
-- not a figure anyone is owed.

COMMENT ON TABLE provider_usage_fact IS
  'The NORMALISED provider lane (target-state-data-architecture.md §6, reporting-consolidation/04-prototype-delta.md §2): teammate/day/tool/model/cost_type facts, one row shape, `provider` as the discriminator, each provider written by its own adapter. THE MEASURE MEANS DIFFERENT THINGS PER PROVIDER: anthropic rows carry BILLED cost (conserved against actual_spend); github rows carry gross CONSUMPTION valued at the provider''s credit rate (conserved against reconciliation_record, NEVER against copilot_pool_bill, which is pooled and net). Discriminate on `provider` before summing cost_usd. Only a provider API adapter writes it. Retention unresolved pending #41.';

COMMENT ON COLUMN provider_usage_fact.source IS
  'The OWNERSHIP DOMAIN this row belongs to — what the transform''s advisory lock and guarded prune are keyed on. Anthropic rows mirror actual_spend.source (''anthropic-analytics-api[:<externalOrgId>]''); GitHub rows carry ''copilot-consumption:<enterpriseRef>'', which is NOT an actual_spend.source — Copilot per-user consumption has no actual_spend row (0118''s "mirrors actual_spend.source" was true of the only arm that then existed).';

COMMENT ON COLUMN provider_usage_fact.cost_usd IS
  'PROVIDER-SCOPED MEANING. anthropic: the amount the provider charged for this (model, cost_type) — billed money. github: gross AI-credit consumption valued at the provider''s own credit rate, BEFORE the pooled allowance — not an invoice figure, and not expected to equal copilot_pool_bill. NULL on a row whose measure is tokens or activity.';

COMMENT ON COLUMN provider_usage_fact.requests IS
  'PROVIDER-SCOPED MEANING. anthropic: the usage report''s `requests` (NULL on cost rows, which the provider documents as NULL whenever cost_type is grouped). github: `totals_by_model_feature[].user_initiated_interaction_count` — deliberate user interactions with that model, the arm''s activity measure. Carried on GitHub MODEL rows only, so a SUM over the arm cannot double count.';

/*
 * ── MONEY IS DAY GRAIN ON THE GITHUB ARM, AND THAT IS ENFORCED ──────────────
 *
 * WHAT THE WIRE SAYS (observed, not inferred —
 * docs/design/provider-wire-captures/2026-08-02-provider-wire-shape.json):
 *
 *   ndjson_records[].ai_credits_used          number, 100%, AT THE RECORD ROOT
 *   ndjson_records[].totals_by_model_feature[].model      487/487
 *   ndjson_records[].totals_by_language_model[].model     756/756
 *
 * The model rows carry activity counts and LOC sums. They carry NO credits and
 * NO cost. The capture answers `does_copilot_send_money_at_model_grain` with a
 * flat NO.
 *
 * So a GitHub row that carried BOTH a model and a cost could only have got there
 * by SPLITTING a day's credits across models by some share — a ratio. A ratio is
 * indistinguishable at read time from a figure the provider sent, which is
 * exactly what makes it dangerous: it would render in a model axis, foot to the
 * right total, and be wrong in every cell.
 *
 * This CHECK makes that a constraint violation instead of a silent number. The
 * arm writes the two truths separately — the day's money on a `model IS NULL`
 * row, the model dimension on rows carrying the activity measure — and this is
 * what stops a later change collapsing them.
 *
 * SCOPED TO github ON PURPOSE. Anthropic genuinely does send money at model
 * grain (`data[].model` 255/255 on the cost report), so the same rule there
 * would delete the whole point of the table.
 *
 * REMOVAL CONDITION, so this does not become architecture by accident: if a
 * future capture shows GitHub sending money at model grain — the PAT-mode
 * ai_credit/usage surface is the candidate, and the 2026-08-02 probe could not
 * exercise it ("not-configured on this environment") — then re-derive this
 * constraint from THAT capture in the same change that starts reading the
 * dimension. Not before, and never from a Zod schema.
 */
ALTER TABLE provider_usage_fact ADD CONSTRAINT provider_usage_fact_github_money_grain_chk
  CHECK (provider <> 'github' OR model IS NULL OR cost_usd IS NULL);
