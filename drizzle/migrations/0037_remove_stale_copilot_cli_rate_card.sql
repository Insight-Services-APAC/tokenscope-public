-- Migration 0037: Remove the stale github:copilot-cli rate_card and its rate_lines.
--
-- The github:copilot-cli rate card was seeded in mig 0004 as a placeholder
-- before we knew Copilot charges in AI credits (nano_aiu), not per-token.
-- It was removed from seed.ts and from the 0004 migration comment in a prior
-- fix pass, but deployed databases still have the rows because the migration
-- runner is keyed by filename (editing 0004 is a no-op on already-applied DBs).
--
-- Copilot spend is now computed from nano_aiu × COPILOT_AI_CREDIT_USD ($0.01)
-- with rate_card_id = NULL. These rows are dead and misleading.
DELETE FROM rate_line
WHERE rate_card_id = '90000000-0000-4000-8000-000000000002';

DELETE FROM rate_card
WHERE id = '90000000-0000-4000-8000-000000000002';
