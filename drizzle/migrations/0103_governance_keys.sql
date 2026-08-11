-- 0103 — governance keys on money rows + the chargeback-verdict snapshot
-- fields (Workstream B, Required outcomes 1 + 2).
--
-- Design: docs/design/usage-completeness-and-provider-governance.md §4.0
-- ("money rows have no governance key" — R1-H9, blocks the whole workstream),
-- §4.1 (the verdict snapshot), §8.4 (bounded/resumable backfill).
--
-- `provider_org_id` / `provider_enterprise_id` are the GOVERNANCE KEY: without
-- them, `provider_org.billing` / `provider_enterprise.billing` (ADR-0011 D1)
-- has nothing to join against. Nullable everywhere: NULL is the explicit
-- "not yet resolved" state (governance-unresolved), NEVER guessed at, and
-- NEVER defaulted to chargeable or exempt (see server/governance/verdict.ts).
--
-- ON DELETE SET NULL (not the default NO ACTION/RESTRICT): orgs/[id].delete.ts
-- documents provider_org as "a LEAF in the FK graph... a hard delete orphans
-- no rows" — money rows resolve an org by its (provider, external_org_id) TEXT
-- key at read/ingest time, never an FK. These governance-key columns must
-- preserve that: deleting a de-registered org's row must NEVER be blocked by
-- (or cascade-destroy) historical money rows. SET NULL sends any row that
-- referenced it back to governance-unresolved (never chargeable, always
-- showback-visible, and re-resolvable the moment the org is re-registered) —
-- exactly the existing, correct behaviour for a row whose org was never
-- resolved in the first place.
--
-- ============================================================================
-- PART 1 — actual_spend: governance key + verdict-snapshot metadata.
-- ============================================================================
ALTER TABLE actual_spend
  ADD COLUMN provider_org_id uuid REFERENCES provider_org(id) ON DELETE SET NULL,
  ADD COLUMN provider_enterprise_id uuid REFERENCES provider_enterprise(id) ON DELETE SET NULL,
  -- Backfill worker bookkeeping ONLY (never read by a money path): NULL = not
  -- yet attempted; 'resolved' = the key above was matched; 'unresolved' =
  -- attempted and parked (skip on the next sweep until an explicit recheck —
  -- design §8.4 "exception buckets are states to resolve, not permanent sinks").
  ADD COLUMN governance_key_status text CHECK (governance_key_status IN ('resolved', 'unresolved')),
  -- Stamped when this row's verdict is FROZEN by a finance_period close/restate
  -- (server/governance/finance-period.ts). NULL = open / recomputable.
  ADD COLUMN governance_verdict_locked_at timestamptz,
  -- Provenance of the CURRENT chargeback_exempt value — one of
  -- 'legacy-heuristic' (pre-activation rollback path) | 'governance:billed' |
  -- 'governance:tracked' | 'unresolved'. See
  -- server/governance/verdict.ts. NULL = never computed by this mechanism yet
  -- (a brand-new row before its writer's first governance-aware stamp, or a
  -- pre-Workstream-B historical row awaiting the backfill/recompute sweep).
  -- The CHECK makes the authority boundary structural: no teammate-derived
  -- verdict source can be introduced by a future writer.
  ADD COLUMN governance_verdict_source text
  CONSTRAINT actual_spend_governance_verdict_source_ck CHECK (
    governance_verdict_source IN (
      'legacy-heuristic',
      'governance:billed',
      'governance:tracked',
      'unresolved'
    )
  );

COMMENT ON COLUMN actual_spend.provider_org_id IS
  'Governance key (ADR-0011 D1): the provider_org this row''s spend belongs to. NULL = governance-unresolved (showback-visible, never chargeable). Populated at ingest by every writer; backfilled historically by the governance-key-backfill worker. usage-completeness-and-provider-governance.md §4.0.';
COMMENT ON COLUMN actual_spend.provider_enterprise_id IS
  'Governance key (ADR-0011 D11): the provider_enterprise this row''s GitHub spend belongs to (billing lives here for GitHub, not on provider_org). NULL for Anthropic rows whose org has no enterprise parent (the normal case) or for unresolved GitHub rows. usage-completeness-and-provider-governance.md §4.0/§4.2.';
COMMENT ON COLUMN actual_spend.governance_verdict_locked_at IS
  'Set when a finance_period close/restate freezes this row''s chargeback_exempt verdict; cleared on reopen. NULL = open (recomputes from current governance on every recompute pass). server/governance/finance-period.ts.';
COMMENT ON COLUMN actual_spend.governance_verdict_source IS
  'Provenance of the current chargeback_exempt value: legacy-heuristic | governance:billed | governance:tracked | unresolved. Only provider governance decides chargeback. server/governance/verdict.ts.';

-- Partial index backing the governance-key-backfill worker's bounded sweep
-- (WHERE governance_key_status IS NULL — never-yet-attempted rows).
CREATE INDEX actual_spend_governance_key_pending_idx ON actual_spend (id) WHERE governance_key_status IS NULL;
-- Backs the recompute engine's "never yet computed" priority pass.
CREATE INDEX actual_spend_governance_verdict_pending_idx ON actual_spend (id) WHERE governance_verdict_source IS NULL;
-- Date-first keyset traversal for the periodic open-period recompute. UUID ids
-- are random and cannot serve as a chronological cursor efficiently.
CREATE INDEX actual_spend_governance_recompute_cursor_idx ON actual_spend (date, id);

-- ============================================================================
-- PART 2 — reconciliation_record: same governance key (no verdict-snapshot
-- fields here — reconciliation_record's chargeback-eligibility gate remains
-- spend_class <> 'indicative', which this PR does not change; only the
-- indicative_reason assignment at ingest becomes governance-aware, per
-- server/reconciliation/adapters/github.ts).
-- ============================================================================
ALTER TABLE reconciliation_record
  ADD COLUMN provider_org_id uuid REFERENCES provider_org(id) ON DELETE SET NULL,
  ADD COLUMN provider_enterprise_id uuid REFERENCES provider_enterprise(id) ON DELETE SET NULL,
  ADD COLUMN governance_key_status text CHECK (governance_key_status IN ('resolved', 'unresolved'));

COMMENT ON COLUMN reconciliation_record.provider_org_id IS
  'Governance key (ADR-0011 D1) — see actual_spend.provider_org_id. NULL = unresolved.';
COMMENT ON COLUMN reconciliation_record.provider_enterprise_id IS
  'Governance key (ADR-0011 D11) — see actual_spend.provider_enterprise_id.';

CREATE INDEX reconciliation_record_governance_key_pending_idx ON reconciliation_record (id) WHERE governance_key_status IS NULL;

-- ============================================================================
-- PART 3 — pending_placement: same governance key, carried through by
-- replayOwedBills into the actual_spend row it writes (no re-resolution at
-- replay time — server/reconciliation/placement-store.ts).
-- ============================================================================
ALTER TABLE pending_placement
  ADD COLUMN provider_org_id uuid REFERENCES provider_org(id) ON DELETE SET NULL,
  ADD COLUMN provider_enterprise_id uuid REFERENCES provider_enterprise(id) ON DELETE SET NULL;

COMMENT ON COLUMN pending_placement.provider_org_id IS
  'Governance key (ADR-0011 D1), resolved at enqueue time and carried through unchanged by replayOwedBills into the actual_spend row it writes.';

-- ============================================================================
-- PART 4 — one-time backfill pass: a pure SQL join against the EXISTING
-- provider_org / provider_enterprise registry, deterministically parsing the
-- SAME `source` string convention the writers already use
-- (server/reconciliation/source-org-ref.ts). No external calls, no per-row
-- failure mode — same justification as migration 0101 Part 1's dimension
-- backfill. Rows this pass cannot resolve (the org is not registered yet, or
-- the source predates per-org sourcing) are left with governance_key_status
-- IS NULL, picked up by the bounded governance-key-backfill WORKER
-- (server/workers/governance-key-backfill.ts) once the org is registered/
-- linked, or parked 'unresolved' by that worker if it still cannot resolve
-- them (design §8.4: "leave unresolvable rows in explicit operator buckets").
-- ============================================================================

-- Anthropic actual_spend rows: source = 'anthropic-analytics-api:<externalOrgId>'.
UPDATE actual_spend a
SET provider_org_id = po.id, provider_enterprise_id = po.provider_enterprise_id, governance_key_status = 'resolved'
FROM provider_org po
WHERE po.provider = 'anthropic'
  AND a.source LIKE 'anthropic-analytics-api:%'
  AND lower(po.external_org_id) = lower(split_part(a.source, ':', 2))
  AND a.provider_org_id IS NULL;

-- GitHub actual_spend rows (copilot-bill.ts flat-seat showback): source = 'copilot-seat:<licenseOrg>'.
UPDATE actual_spend a
SET provider_org_id = po.id, provider_enterprise_id = po.provider_enterprise_id, governance_key_status = 'resolved'
FROM provider_org po
WHERE po.provider = 'github'
  AND a.source LIKE 'copilot-seat:%'
  AND a.source <> 'copilot-seat:unknown'
  AND lower(po.external_org_id) = lower(split_part(a.source, ':', 2))
  AND a.provider_org_id IS NULL;

-- reconciliation_record: anthropic enterprise_ref IS the org's external_org_id
-- (no enterprise row for anthropic in the common case).
UPDATE reconciliation_record r
SET provider_org_id = po.id, provider_enterprise_id = po.provider_enterprise_id, governance_key_status = 'resolved'
FROM provider_org po
WHERE po.provider = 'anthropic' AND r.provider = 'anthropic'
  AND lower(po.external_org_id) = lower(r.enterprise_ref)
  AND r.provider_org_id IS NULL;

-- reconciliation_record: github enterprise_ref is the enterprise slug; license_org
-- (when present) resolves the org within it.
UPDATE reconciliation_record r
SET provider_enterprise_id = pe.id
FROM provider_enterprise pe
WHERE pe.provider = 'github' AND r.provider = 'github'
  AND lower(pe.external_id) = lower(r.enterprise_ref)
  AND r.provider_enterprise_id IS NULL;

UPDATE reconciliation_record r
SET provider_org_id = po.id
FROM provider_org po
WHERE po.provider = 'github' AND r.provider = 'github'
  AND r.license_org IS NOT NULL
  AND po.provider_enterprise_id = r.provider_enterprise_id
  AND (lower(po.external_org_id) = lower(r.license_org) OR lower(po.display_name) = lower(r.license_org))
  AND r.provider_org_id IS NULL;

-- A github reconciliation_record row is "resolved" once its ENTERPRISE key is
-- known (D11: the org is attribution-only for chargeability) even if
-- license_org could not be matched to a registered org (an org-less App-mode
-- metrics line, or an org not yet onboarded).
UPDATE reconciliation_record
SET governance_key_status = 'resolved'
WHERE provider = 'github' AND provider_enterprise_id IS NOT NULL AND governance_key_status IS NULL;
