-- 0062: canonicalise the enterprise key to LOWERCASE across all sites.
--
-- See docs/design/copilot-fidelity-multi-org.md §"Case-handling inconsistency
-- (MUST-FIX before a second org)" + P1-7 / validation must-fix #6.
--
-- THE PROBLEM. The enterprise key (provider_enterprise.external_id, surfaced as
-- teammate_identity_map.enterprise_slug / the adapter's externalRef) was handled
-- with THREE different case regimes:
--   * identity-sync UPSERT wrote enterprise_slug RAW (ent.external_id verbatim);
--   * teammate_identity_map_identity_unique lowered only the identifier, NOT the
--     enterprise_slug (0038:145) -> slug was case-SENSITIVE in the key;
--   * the adapter roster reader matched lower(enterprise_slug)=lower(...) -> case-
--     INSENSITIVE (github.ts);
--   * the credential resolver matched external_id EXACT (credentials.ts);
--   * provider_enterprise_unique was (provider, external_id) case-SENSITIVE (0038:33).
-- A tenant onboarded with casing differing from GitHub's canonical slug therefore
-- landed identity rows under one casing while the reader's lower() collapsed across
-- casings (could pick up the WRONG enterprise's rows for a shared login), OR the
-- credential lookup missed entirely (zero attribution).
--
-- THE DECISION. ONE canonical casing: LOWERCASE for external_id / enterprise_slug.
-- GitHub enterprise slugs and org logins are themselves case-insensitive and
-- canonically lowercased by GitHub; the reader + the identity-unique identifier leg
-- already lower(); the seeded reconciled enterprise is already lowercase
-- (acme-partner-demo). Lowercase aligns the most existing surfaces and lets the
-- UPSERT, the unique index, the reader, the credential resolver, and
-- provider_enterprise_unique all agree. Normalisation happens at the write/onboarding
-- boundary (seed + the identity-sync UPSERT + this migration for existing rows); the
-- read-side lookups (reader, credential resolver) compare lower()=lower() so they are
-- robust even against a stray legacy mixed-case row.
--
-- Idempotent throughout. PRESERVES the anti-claim-jacking NULL-slug lane: NULL
-- enterprise_slug stays NULL (self-service rows are untouched and never collapse into
-- an enterprise lane).

-- 1. provider_enterprise.external_id -> lowercase.
--    De-dup first: two rows differing only by external_id case would collide once
--    lowered. Keep the lexically-first id; this is a no-op on current data (the only
--    reconciled GitHub enterprise is already lowercase) and correct if case-variants
--    ever crept in. provider_org.provider_enterprise_id FK rows are NOT repointed
--    here (no case-variant duplicates exist on real data); a future occurrence would
--    surface as an FK violation rather than silent mis-attribution.
DELETE FROM provider_enterprise a
USING provider_enterprise b
WHERE a.id > b.id
  AND a.provider = b.provider
  AND lower(a.external_id) = lower(b.external_id)
  AND a.external_id <> b.external_id;

UPDATE provider_enterprise
   SET external_id = lower(external_id)
 WHERE external_id <> lower(external_id);

-- 2. teammate_identity_map.enterprise_slug -> lowercase (NULL stays NULL: the
--    self-service / anti-claim-jacking lane is preserved verbatim).
--    De-dup case-variants under the post-normalisation key first (mirrors 0038's
--    pre-index de-dup): once the slug is lowered, two rows that differed only by
--    enterprise_slug case (same system, same lower(identifier)) collide on
--    teammate_identity_map_identity_unique. No-op on current data.
DELETE FROM teammate_identity_map a
USING teammate_identity_map b
WHERE a.id < b.id
  AND a.system = b.system
  AND lower(COALESCE(a.enterprise_slug, '')) = lower(COALESCE(b.enterprise_slug, ''))
  AND lower(a.identifier) = lower(b.identifier);

UPDATE teammate_identity_map
   SET enterprise_slug = lower(enterprise_slug)
 WHERE enterprise_slug IS NOT NULL
   AND enterprise_slug <> lower(enterprise_slug);

-- 3. Enforce LOWERCASE external_id going forward. A CHECK is the loud failure the
--    runbook wants: an onboarding INSERT with a mixed-case slug fails immediately
--    rather than landing a silently-mismatched row. Pair with the application-side
--    normalisation in the seed + the credential/reader lookups.
ALTER TABLE provider_enterprise
  DROP CONSTRAINT IF EXISTS provider_enterprise_external_id_lower_ck;
ALTER TABLE provider_enterprise
  ADD CONSTRAINT provider_enterprise_external_id_lower_ck
  CHECK (external_id = lower(external_id));

-- 4. Make provider_enterprise_unique case-insensitive too, so the same slug in two
--    casings can never coexist even if the CHECK is ever relaxed. With the CHECK
--    above this is belt-and-braces, but it keeps the uniqueness invariant aligned
--    with the lower()=lower() read-side lookups.
DROP INDEX IF EXISTS provider_enterprise_unique;
CREATE UNIQUE INDEX IF NOT EXISTS provider_enterprise_unique
  ON provider_enterprise (provider, (lower(external_id)));
