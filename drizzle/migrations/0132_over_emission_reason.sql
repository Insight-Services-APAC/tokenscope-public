-- 0132 — over_emission.reason: give the no-bill lane somewhere honest to live
-- (UF-21, docs/security-sprint/urgent-follow-sprint.md Part C2).
--
-- WHAT WAS MISSING. over-emission detection computes TWO lanes and could persist
-- only one:
--
--   'api-uncorroborated'      the HIGH-confidence flag. There IS a provider bill
--                             for that (teammate, day, tool) and OTel exceeds it
--                             by more than 2x AND clears an absolute floor.
--                             max(0, OTel − API). This is what the developer is
--                             asked to review and quarantine.
--
--   'no-bill-to-corroborate'  the LOWER-confidence lane (`material_no_bill` in
--                             server/usage/over-emission-detection.ts). api_usd = 0
--                             — either the org is not reconciled or spend really was
--                             zero, and the two are indistinguishable from here — so
--                             a much higher absolute floor
--                             (OVER_EMISSION_NO_BILL_FLOOR_USD) is the ONLY guard,
--                             and a declared personal subscription is excluded.
--                             It is NOT an accusation and must never be merged into
--                             the high-confidence flag.
--
-- With no column to tell them apart, S10 had exactly three options: skip the second
-- lane, overload an existing column's meaning, or return it and persist nothing. It
-- chose the honest one and returned it (OverEmissionResult.noBillFlagged /
-- totalNoBillUsd). This column is the missing half.
--
-- 'api-uncorroborated' reuses the vocabulary already in the product: it is the
-- conversation_quarantine.reason a developer's quarantine writes
-- (server/api/v1/me/over-emission/[id]/resolve.post.ts:78,81) — the same fact from
-- the other end.
--
-- EXISTING ROWS STAY VALID, AND STAY CORRECT. Every row written before this
-- migration came from the material (api_usd > 0) lane, because that was the only
-- lane that wrote. NOT NULL DEFAULT 'api-uncorroborated' therefore backfills them
-- with the truth, not with a placeholder — and on PG11+ it is a metadata-only
-- default, so no rewrite. The CHECK is a validating one on purpose: the column is
-- new and every value conforms by construction, so it cannot fail here (unlike
-- mig 0131, where NOT VALID was doing real work).
--
-- SEPARATION IS BY `reason`, NOT BY TABLE. The two lanes share the
-- (teammate_id, day, tool) unique key without fighting over it: they are mutually
-- exclusive by construction (api_usd > 0 vs api_usd = 0), so a cell is in exactly
-- one lane at a time, and a cell that changes lane (an org gets reconciled) updates
-- its own row through the existing upsert. Every developer-facing reader —
-- GET /api/v1/me/over-emission, the resolve route, and the me-lens has_open_review
-- probe — filters `reason = 'api-uncorroborated'`, so persisting the no-bill lane
-- adds NO accusation to anyone's review queue. It makes the number durable and
-- queryable instead of existing only in one worker's return value.

ALTER TABLE over_emission
  ADD COLUMN reason text NOT NULL DEFAULT 'api-uncorroborated'
  CHECK (reason IN ('api-uncorroborated', 'no-bill-to-corroborate'));

-- NO INDEX CHANGE. over_emission_teammate_state_idx (mig 0072) still leads on the
-- predicate every reader leads on (teammate_id), and this table holds one row per
-- FLAGGED (teammate, day, tool) — a rare event by construction. Adding `reason` to
-- an index would be churn on a hot-path assumption nobody has measured.

-- The old comment predated mig 0073 ("Claude-only until a per-teammate-day Copilot
-- API truth exists" — 0073 gave us one, and 0072's own header says so), and said
-- nothing about the second lane. Restate both.
COMMENT ON TABLE over_emission IS
  'ADR-0010 rule 2 / ADR-0008: per-(teammate,day,tool) OTel emission the provider API does not corroborate. TWO LANES, discriminated by `reason` and never merged: api-uncorroborated = a real bill exists and OTel materially exceeds it (the high-confidence flag a developer reviews and quarantines); no-bill-to-corroborate = there is no bill at all for that cell (api_usd = 0, org possibly unreconciled), flagged on an absolute floor only, NOT an accusation and never shown as a review item. Both providers since mig 0073.';

COMMENT ON COLUMN over_emission.reason IS
  'Which detection lane wrote this row. api-uncorroborated = high-confidence (bill exists, OTel > 2x it); no-bill-to-corroborate = low-confidence (no bill to compare against, absolute floor only). Developer-facing readers filter to api-uncorroborated.';
