-- 0108 — GitHub enterprise-org coverage detection (Workstream D, ADR-0011 D13 as
-- amended by docs/design/usage-completeness-and-provider-governance.md §6).
--
-- Two tables, deliberately kept SEPARATE (§6 "enterprise completeness is a separate
-- claim from per-org observations"; requirement 1):
--
-- provider_org_coverage — the LATEST per-org classification observed for one
-- (enterprise, org) pair. One row per org actually observed by a sweep/recheck (the
-- census union our own known provider_org rows) — an org never observed has no row,
-- which is correct: absence of an observation is not itself a claim.
--
-- provider_enterprise_coverage_census — the LATEST enterprise-level census result: did
-- we obtain an authoritative org count THIS pass, was it capped, and if unavailable,
-- why. This is the ONLY place a denominator/"N of M" claim may be read from — never
-- derived from counting provider_org_coverage rows, which may include stale stragglers
-- the census itself does not count as current members.
--
-- Both carry observed_at/expires_at (requirement 5): a reader (the GET route, the
-- admin UI, the reporting metadata) MUST treat an expired row as UNKNOWN, never as
-- still-complete/still-connected — a sweep that stopped running silently must not be
-- read as "still healthy" forever. Minimal columns only: this is a LATEST-observation
-- table for transition detection + operator UI, not a history/audit log (audit_event
-- already carries the audited recheck/sweep actions that produced a given observation).
CREATE TABLE provider_org_coverage (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_enterprise_id  uuid NOT NULL REFERENCES provider_enterprise(id),
  org_login               text NOT NULL,
  state                   text NOT NULL CHECK (
    state IN ('mislinked', 'coverage-unknown', 'stale', 'not-installed', 'suspended', 'not-onboarded', 'connected')
  ),
  -- The provider_org row this observation resolved to, when one exists — carried so
  -- the admin UI's remediation link (Edit / Delete) can jump straight to it without a
  -- second lookup. NULL for not-installed/not-onboarded orgs with no row yet.
  provider_org_id         uuid REFERENCES provider_org(id),
  observed_at             timestamptz NOT NULL,
  expires_at              timestamptz NOT NULL,
  UNIQUE (provider_enterprise_id, org_login)
);

CREATE INDEX provider_org_coverage_enterprise_idx ON provider_org_coverage (provider_enterprise_id);
-- The sweep/admin-banner query's primary shape: "every currently non-expired,
-- non-connected observation" (a partial index — this table is expected to be small
-- and mostly `connected`, so keying the index to the rows that actually drive an
-- alert/banner keeps it cheap regardless of enterprise-fleet growth).
CREATE INDEX provider_org_coverage_non_connected_idx ON provider_org_coverage (expires_at)
  WHERE state <> 'connected';

COMMENT ON TABLE provider_org_coverage IS
  'Latest per-(enterprise, org) coverage classification (Workstream D, design §6). One row per org actually observed; NEVER counted for a denominator claim (see provider_enterprise_coverage_census). A reader MUST treat expires_at < now() as unknown, never as still the classified state.';

CREATE TABLE provider_enterprise_coverage_census (
  provider_enterprise_id  uuid PRIMARY KEY REFERENCES provider_enterprise(id),
  available               boolean NOT NULL,
  capped                  boolean NOT NULL DEFAULT false,
  unavailable_reason      text CHECK (
    unavailable_reason IS NULL
    OR unavailable_reason IN ('not-app-mode', 'no-credential', 'key-malformed', 'capability-denied', 'capability-unknown')
  ),
  -- The raw census size THIS pass — the authoritative "M" in "N of M orgs", read ONLY
  -- when available AND NOT capped (server/reconciliation/coverage.ts
  -- summariseEnterpriseCoverage enforces this at the application layer too — the
  -- column itself stays populated even when capped/unavailable so the raw number is
  -- inspectable, but no caller may present it as a denominator in that case).
  org_count               integer,
  observed_at             timestamptz NOT NULL,
  expires_at              timestamptz NOT NULL
);

COMMENT ON TABLE provider_enterprise_coverage_census IS
  'Latest enterprise-level coverage-census result (Workstream D, design §6). The ONLY source of an "N of M orgs" completeness claim -- null/absent/expired means no denominator may be emitted (R1-M5). Never derive M by counting provider_org_coverage rows (stale stragglers would inflate it).';

-- Sweep and manual recheck can overlap after both read the same prior
-- observation. Keep one open alert per recipient/event key even under that
-- race; resolving the row removes it from this partial index so a later,
-- genuinely new transition can alert again.
CREATE UNIQUE INDEX inbox_github_coverage_gap_open_unique
  ON inbox_item (
    recipient_teammate_id,
    related_entity_id,
    ((body ->> 'kind')),
    ((COALESCE(body ->> 'org', ''))),
    ((COALESCE(body ->> 'state', '')))
  )
  WHERE category = 'github-coverage-gap'
    AND ack_state IN ('unread', 'read', 'acknowledged');
