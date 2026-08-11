-- Ambiguous-owner counts, without an RLS bypass in a handler.
--
-- WHY THIS EXISTS. The admin org-unit tree warns when a cost-centre owner owns
-- MORE THAN ONE active cost-owning unit, because the manager-chain walk treats
-- such an owner as ambiguous and skips them entirely — they silently place
-- nobody. Getting that count right requires seeing every unit the owner holds,
-- including units in OTHER regions: an owner whose second unit is elsewhere is
-- exactly the case the warning exists to catch, and a region-clamped count
-- would report them as working.
--
-- The handler previously read this on the pooled handle, deliberately outside
-- the request's RLS transaction. That is a real RLS bypass in server/api/**,
-- which scripts/check-handler-rls-context.mjs exists to ratchet down (47 such
-- handlers predate FORCE ROW LEVEL SECURITY; the check stops the count growing
-- while UF-1 waits on FORCE). Moving the same getDb() call into a helper module
-- would have slipped past the scanner while changing nothing about the bypass,
-- so it is not done that way.
--
-- SECURITY DEFINER is the sanctioned shape for "an aggregate the caller may know
-- computed over rows the caller may not read". The function returns ONLY
-- (owner_oid, unit_count) — never a unit id, a name or a region — so no row this
-- caller could not otherwise see leaves the database. It behaves identically
-- before and after FORCE RLS lands, which the pooled-handle read did not: that
-- read works today only because RLS is currently inert.
--
-- Predicate is byte-identical to loadActiveUnitOwners in
-- server/reconciliation/placement-store.ts and to resolvesToSingleUnit's rule.
-- If one changes, change both — the warning must not drift from the behaviour it
-- describes.

CREATE OR REPLACE FUNCTION owner_active_unit_counts()
RETURNS TABLE (owner_oid text, unit_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Empty search_path: a SECURITY DEFINER function must not resolve unqualified
-- names against a caller-controlled path. Every reference below is schema-
-- qualified.
SET search_path = ''
AS $$
  SELECT t.entra_oid AS owner_oid, count(*) AS unit_count
  FROM public.cou_owner co
  JOIN public.teammate t ON t.id = co.teammate_id
  JOIN public.org_unit ou ON ou.id = co.org_unit_id
  WHERE co.revoked_at IS NULL
    AND t.entra_oid NOT LIKE 'bill:%'
    AND t.entra_oid NOT LIKE 'provisional:%'
    AND ou.is_cost_owning_unit
    AND ou.retired_at IS NULL
  GROUP BY t.entra_oid
$$;

COMMENT ON FUNCTION owner_active_unit_counts() IS
  'Aggregate-only owner ambiguity counts for the admin org-unit tree. SECURITY '
  'DEFINER so the count spans regions the caller cannot read; returns no unit '
  'identity. Mirrors loadActiveUnitOwners'' predicate — keep them in step.';

REVOKE ALL ON FUNCTION owner_active_unit_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION owner_active_unit_counts() TO PUBLIC;
