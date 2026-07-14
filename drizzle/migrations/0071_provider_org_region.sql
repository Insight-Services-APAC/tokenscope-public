-- 0071: org → region home (ADR-0010 D4).
--
-- Intent: ADR-0010 (docs/decisions/0010-cost-accounting-...). "Attribution is by
-- GitHub org → region": every GitHub license-org maps to a region, so a Copilot
-- seat's flat + overage ALWAYS has a region home even when the individual seat-holder
-- can't be placed into a practice by the manager-walk. The bill-driven provisioner
-- (placement-service.fallbackRegionId) uses this as the floor instead of the global
-- __unassigned__ bucket.
--
-- NULL = not yet mapped. The admin reconciliation-orgs surface sets it; the resolver
-- (regionForLicenseOrg) returns null for an unmapped org → the provisioner falls back
-- to the global holding node (today's behaviour). So this is additive and inert until
-- an org is mapped.
ALTER TABLE provider_org
  ADD COLUMN region_id uuid REFERENCES region(id);

COMMENT ON COLUMN provider_org.region_id IS
  'ADR-0010 D4: the region a Copilot license-org bills to. NULL = unmapped (provisioner uses the global fallback).';
