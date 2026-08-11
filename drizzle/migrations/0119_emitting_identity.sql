-- 0119 — emitting identity + the billing lane
-- (docs/design/emitting-identity-and-subscription-type.md §5, step 1).
--
-- A telemetry record carries TWO identities. Which DEVICE emitted it
-- (tokenscope.instance_id — already stored, and still the sole binding from
-- spend to a teammate), and which ACCOUNT was signed in (Claude's per-event
-- `user.email` — until now read past and discarded). Money keeps binding to the
-- device. But whether a dollar is inside the bill we reconcile against is a
-- property of the ACCOUNT: a developer running a personal Claude subscription
-- on an enrolled machine has that spend counted as if it were enterprise, which
-- suppresses their needs-tagging worklist by exactly the amount of it.
--
-- NUMBERING: 0117 and 0118 look free on this branch and are NOT. 0117 is
-- reserved by the unmerged feat/provider-raw-capture branch; 0118 is assigned
-- to the transform table landing alongside this. The gap is cosmetic —
-- drizzle/migrate.ts applies files in lexical order and records each by name.
--
-- THE PRINCIPLE THIS DDL EXISTS TO SUPPORT (§1): the lane is decided ONCE, at
-- join time, and never changes. Three earlier drafts of this design evaluated
-- classification at READ time and each broke on temporal instability — a
-- teammate changing their email silently rewrote every historic figure. Stamping
-- ends that class: an email change, a shadow confirmation, an erasure or a
-- subscription relabel all terminate at the stamp without moving a dollar.
--
-- EVERY COLUMN HERE IS ADDITIVE AND DEFAULTED, so applying this migration
-- changes no existing number. `billing_lane` defaults to 'unknown', and
-- 'unknown' nets against the provider API exactly as today's un-laned rows do.
-- Behaviour changes when the joiner starts stamping, not when the column lands.

-- ── attribution_record ──────────────────────────────────────────────────────
ALTER TABLE attribution_record
  ADD COLUMN IF NOT EXISTS emitting_email  text,
  ADD COLUMN IF NOT EXISTS emitting_org_id text,
  ADD COLUMN IF NOT EXISTS billing_lane    text NOT NULL DEFAULT 'unknown';

-- NOT VALID, then VALIDATE: adding a plain CHECK takes ACCESS EXCLUSIVE for a
-- full table scan, and attribution_record is the ledger. NOT VALID takes the
-- lock only briefly; VALIDATE then scans under SHARE UPDATE EXCLUSIVE, which
-- does not block reads or writes. Every existing row satisfies it by the
-- DEFAULT, so the validation cannot fail.
ALTER TABLE attribution_record
  ADD CONSTRAINT attribution_record_billing_lane_check
  CHECK (billing_lane IN ('provider-billed', 'self-billed', 'unknown')) NOT VALID;
ALTER TABLE attribution_record VALIDATE CONSTRAINT attribution_record_billing_lane_check;

COMMENT ON COLUMN attribution_record.emitting_email IS
  'Canonicalised (trim+lower) Claude per-event user.email — WHICH ACCOUNT was signed in, as distinct from which device emitted (instance_id). The evidence for billing_lane. NULL = the emitter did not report one. PII: redact in place on erasure; billing_lane survives, because it was stamped at write (design §11).';
COMMENT ON COLUMN attribution_record.emitting_org_id IS
  'Claude per-event organization.id for this record. Hint and diagnostics ONLY — it never decides billing_lane. (The reconciliation LANE is picked separately, from one organization.id per grouped session, in server/workers/azure-monitor-reader.ts.)';
COMMENT ON COLUMN attribution_record.billing_lane IS
  'provider-billed | self-billed | unknown. Stamped ONCE at join time from canon(emitting_email) against the teammate enterprise address set, and NEVER updated thereafter — the only permitted write is a backfill filling an ''unknown'' (design §5/§9). ''unknown'' reproduces pre-0119 behaviour exactly: it nets against the provider API just as an un-laned row did.';

-- ── teammate_identity_map ───────────────────────────────────────────────────
-- EXACTLY ONE of these three is functional. `is_enterprise` decides membership
-- of the enterprise address set; `subscription_type` and `monthly_cost_usd` are
-- display and migration-planning only. An earlier draft claimed identity
-- metadata had "no functional role" while ALSO claiming that linking an address
-- repaired a misclassification; both cannot be true, so the boolean is named as
-- the one that does work.
ALTER TABLE teammate_identity_map
  ADD COLUMN IF NOT EXISTS is_enterprise     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS subscription_type text,
  ADD COLUMN IF NOT EXISTS monthly_cost_usd  numeric(10, 2);

ALTER TABLE teammate_identity_map
  ADD CONSTRAINT teammate_identity_map_monthly_cost_bound
  CHECK (monthly_cost_usd IS NULL OR (monthly_cost_usd >= 0 AND monthly_cost_usd < 100000)) NOT VALID;
ALTER TABLE teammate_identity_map VALIDATE CONSTRAINT teammate_identity_map_monthly_cost_bound;

COMMENT ON COLUMN teammate_identity_map.is_enterprise IS
  'FUNCTIONAL: this linked address is part of the teammate enterprise address set, so emissions under it stamp provider-billed. Affects FUTURE writes ONLY — setting it never re-stamps a historic attribution_record (design §3, owner-decided 2026-08-02). Carries PROVENANCE as well as a value: set by directory sync it is directory-verified; set by a developer it is a claim, subject to the existing anti-claim-jacking collision rule.';
COMMENT ON COLUMN teammate_identity_map.subscription_type IS
  'Display only (e.g. ''Max 20''). Never decides a billing lane. Inherits the classification-free display role of personal_subscription_declaration.subscription_type, which retires in a later step.';
COMMENT ON COLUMN teammate_identity_map.monthly_cost_usd IS
  'Display + migration planning only. The cost_usd a self-billed Claude session emits IS the real equivalent usage-based cost (the client computes it from token counts and model rates), so "this address is $200/mo and emitted $340 of usage" compares directly against what enterprise would have charged. Never decides a billing lane.';
