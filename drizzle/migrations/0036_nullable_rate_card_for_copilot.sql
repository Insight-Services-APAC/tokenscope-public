-- 0036: make attribution_record.rate_card_id and rate_card_version nullable.
--
-- Copilot CLI v1 pricing uses a straight joiner constant (1 AI credit = $0.01 USD,
-- see COPILOT_AI_CREDIT_USD in azure-monitor-reader.ts), not a token rate_line.
-- Without a rate_card row for Copilot, the NOT NULL constraints on rate_card_id and
-- rate_card_version would require a sentinel row that doesn't represent real pricing.
-- Making them nullable is cleaner: NULL = "priced by non-rate-card mechanism"
-- (today = Copilot AI-credit constant; future = billing-API reconciliation).
-- Claude rows continue to have a non-null rate_card_id.
--
-- Note: only the NOT NULL constraints are dropped here. The FK column definition is
-- retained; the NOT NULL constraint is what this migration removes. Drizzle's schema
-- treats the column as nullable FK (i.e. optional referential integrity when non-null).

ALTER TABLE attribution_record
  ALTER COLUMN rate_card_id    DROP NOT NULL,
  ALTER COLUMN rate_card_version DROP NOT NULL;
