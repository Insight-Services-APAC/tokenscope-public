-- 0122 — carry Anthropic's `server_tool_use.web_search_requests`.
--
-- WHAT THIS IS. The 2026-08-02 wire capture recorded
-- `data[].server_tool_use.web_search_requests` on 85/85 live and 257/257 stored
-- usage rows, under `undeclaredByOurSchema` — the same latent shape `model` was
-- in before task #32. This migration is the storage half of declaring it; the
-- schema half is server/anthropic/enterprise-client.ts.
--
-- IT CHANGES NO DOLLAR FIGURE. That is the accurate claim, and it is narrower
-- than "inert" — provider-transform.ts:40-45 explicitly retracts that word for
-- this table, because server/reporting/engine/billed-axis.ts reads it live. The
-- new column is not `cost_usd` and is not summed by any money path, so every
-- billed-lane figure is byte-identical before and after (asserted as an actual
-- response comparison in tests/integration/provider/provider-server-tool-use.test.ts,
-- not as a grep).
--
-- WHY A NEW COLUMN AND NOT `requests`. `requests` is single-homed per arm —
-- Anthropic's usage-report `requests` on the token row, Copilot's
-- user_initiated_interaction_count on its MODEL row (0120's comment on the
-- column) — which is exactly what makes `SUM(requests)` safe across the table.
-- Folding a second meaning into it would make that sum a number nobody is owed.
--
-- WHERE IT LIVES ON THE ROW. `server_tool_use` arrives on the USAGE report,
-- the same row as `requests`, so it rides the TOKEN row (`cost_type IS NULL`).
-- Like `requests`, it sits OUTSIDE provider_usage_fact_measure_chk — that
-- constraint governs the cost-vs-token exclusivity, and a request count is
-- neither (0118:158-160 states the same exemption for `requests`).
--
-- NULL IS NOT ZERO, and the column is nullable for that reason. "The provider
-- reported no web searches" and "the provider did not carry the field" are
-- different facts. GitHub rows never carry it at all and stay NULL.
ALTER TABLE provider_usage_fact ADD COLUMN web_search_requests bigint;

-- Same shape rule the other measures get (0118:172-180): a negative count is
-- not a value, it is a bug that has already been written.
ALTER TABLE provider_usage_fact ADD CONSTRAINT provider_usage_fact_web_search_chk
  CHECK (COALESCE(web_search_requests, 0) >= 0);

COMMENT ON COLUMN provider_usage_fact.web_search_requests IS
  'Anthropic usage report `server_tool_use.web_search_requests` — server-side web searches the provider counted for this (actor, day, product, model). Rides the TOKEN row (cost_type IS NULL) alongside `requests`, and is deliberately outside provider_usage_fact_measure_chk for the same reason `requests` is. NULL = the provider did not carry the field (always so on github rows); 0 = it carried zero. Carries no money and is summed by no money path.';
