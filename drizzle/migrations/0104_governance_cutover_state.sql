-- 0104 — governance cutover state (Workstream B, Required outcome 3).
--
-- Design: docs/design/usage-completeness-and-provider-governance.md §8.1/§8.4,
-- ADR-0011 D1/D2/D11. Singleton row (id = 1) — the whole-system activation
-- state machine: not_started -> preflight_verified -> activated -> rolled_back
-- (-> back to not_started via a fresh preflight). See server/governance/cutover.ts.
CREATE TABLE governance_cutover_state (
  id                     smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  status                 text NOT NULL DEFAULT 'not_started'
                           CHECK (status IN ('not_started', 'preflight_verified', 'activated', 'rolled_back')),
  -- The full computed old-verdict / new-verdict snapshot from the last
  -- successful preflight (per-enterprise + per-org), for audit + operator
  -- review before activation, and for activation's drift re-check.
  preflight_snapshot     jsonb,
  preflight_verified_at  timestamptz,
  preflight_verified_by  uuid REFERENCES teammate(id),
  activated_at           timestamptz,
  activated_by           uuid REFERENCES teammate(id),
  rolled_back_at         timestamptz,
  rolled_back_by         uuid REFERENCES teammate(id),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE governance_cutover_state IS
  'Singleton (id=1). Whole-system GitHub-heuristic -> governance-data cutover state. status=activated switches ALL money paths to read billing authoritatively and ignore name/env heuristics (ADR-0011 D2). server/governance/cutover.ts + server/governance/verdict.ts.';

INSERT INTO governance_cutover_state (id, status) VALUES (1, 'not_started');

-- ============================================================================
-- DB CONSTRAINT (Required outcome 4): reject a GitHub provider_org.billing
-- UPDATE once governance is activated. Defence-in-depth alongside the
-- app-level gate in server/api/v1/admin/reconciliation/orgs/[id].patch.ts —
-- ADR-0011 D11 makes provider_org.billing meaningless for GitHub once the
-- enterprise is authoritative, so a raw SQL client (a script, a future
-- endpoint that forgets the app-level check) must not be able to change it
-- either. INSERT is deliberately NOT blocked (a fresh org row's billing
-- DEFAULT is inert/never read post-activation for github; onboarding must not
-- break). Anthropic rows are NEVER blocked — the org remains its own billing
-- unit for that provider (D11).
-- ============================================================================
CREATE OR REPLACE FUNCTION provider_org_billing_lock() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider = 'github' AND NEW.billing IS DISTINCT FROM OLD.billing THEN
    IF (SELECT status FROM governance_cutover_state WHERE id = 1) = 'activated' THEN
      RAISE EXCEPTION 'provider_org.billing is not writable for a github org once governance cutover is activated — set billing on the provider_enterprise instead (ADR-0011 D11)'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_org_billing_lock_trg ON provider_org;
CREATE TRIGGER provider_org_billing_lock_trg
  BEFORE UPDATE ON provider_org
  FOR EACH ROW EXECUTE FUNCTION provider_org_billing_lock();
