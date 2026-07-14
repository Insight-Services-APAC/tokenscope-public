-- 0064: canonicalise provider_org.external_org_id to LOWERCASE.
--
-- MIRRORS mig 0062 (which did the same for provider_enterprise.external_id). See
-- docs/design/copilot-fidelity-multi-org.md §"Case-handling inconsistency" and the
-- adversarial-review HIGH + MEDIUM-2 finding on the reconciliation-org admin surface.
--
-- THE PROBLEM. The enterprise key was lowercased end-to-end in 0062, but the ORG
-- key (provider_org.external_org_id) was NOT:
--   * the onboarding INSERT (orgs.post) wrote external_org_id VERBATIM;
--   * the dupe pre-check matched external_org_id case-SENSITIVELY;
--   * provider_org_unique was (provider, external_org_id) case-SENSITIVE (0009:23);
--   * BUT the GitHub attribution resolver (adapters/github.ts:resolveEnterpriseForOrg)
--     matches lower(po.external_org_id) = lower(${org}) — case-INSENSITIVE.
-- So two case-variant org rows ('Acme' and 'acme') could BOTH exist, and the reader's
-- lower()=lower() would collapse across them and pick a NON-DETERMINISTIC row →
-- non-deterministic GitHub attribution (could resolve the WRONG enterprise's slug).
--
-- THE DECISION. ONE canonical casing: LOWERCASE for external_org_id, exactly as the
-- enterprise key. GitHub org logins are case-insensitive and canonically lowercased
-- by GitHub; Anthropic org ids are UUIDs (already lowercase) — so the backfill is a
-- no-op for Anthropic and only normalises any stray mixed-case GitHub slug. The
-- read-side resolver already compares lower()=lower(), so it stays robust; this
-- migration removes the possibility of the case-split duplicate that made it
-- non-deterministic.
--
-- Idempotent throughout.

-- 1. De-dup case-variants first: two rows differing only by external_org_id case
--    would collide once lowered. Keep the lexically-first id. No-op on current data
--    (Anthropic ids are UUIDs; the seeded GitHub org is lowercased by the same PR's
--    seed change). A future case-variant FK row (provider_org_unique child) would
--    surface as a violation rather than silent mis-attribution.
DELETE FROM provider_org a
USING provider_org b
WHERE a.id > b.id
  AND a.provider = b.provider
  AND lower(a.external_org_id) = lower(b.external_org_id)
  AND a.external_org_id <> b.external_org_id;

-- 2. provider_org.external_org_id -> lowercase.
UPDATE provider_org
   SET external_org_id = lower(external_org_id)
 WHERE external_org_id <> lower(external_org_id);

-- 3. Enforce LOWERCASE external_org_id going forward. A CHECK is the loud failure
--    the runbook wants: an onboarding INSERT with a mixed-case slug fails immediately
--    rather than landing a silently-mismatched row. Pair with canonicaliseExternalId
--    in orgs.post / orgs/[id].patch (anthropic auto-lowercased; github mixed-case 400).
ALTER TABLE provider_org
  DROP CONSTRAINT IF EXISTS provider_org_external_org_id_lower_ck;
ALTER TABLE provider_org
  ADD CONSTRAINT provider_org_external_org_id_lower_ck
  CHECK (external_org_id = lower(external_org_id));

-- 4. Replace the case-SENSITIVE provider_org_unique (provider, external_org_id) with
--    a case-INSENSITIVE expression UNIQUE (provider, lower(external_org_id)) — so the
--    same slug in two casings can never coexist even if the CHECK is ever relaxed,
--    and the uniqueness invariant matches the lower()=lower() read-side resolver.
--    provider_org_unique was created as a table CONSTRAINT (0009), so drop the
--    CONSTRAINT first (that removes its backing index); the DROP INDEX is the
--    backstop for a partial rerun where it was already converted to a plain index.
ALTER TABLE provider_org DROP CONSTRAINT IF EXISTS provider_org_unique;
DROP INDEX IF EXISTS provider_org_unique;
CREATE UNIQUE INDEX IF NOT EXISTS provider_org_unique
  ON provider_org (provider, (lower(external_org_id)));
