-- 0079: provider_org.cost_owning_unit_id — the GitHub-org → cost-owning-unit map.
--
-- Intent: docs/design/provider-billing-attribution-model.md §B + reporting-consolidation
-- build-design §6 Wave 0. GitHub Copilot bills a POOLED enterprise allowance per (org, sku);
-- the pooled charge homes to a COST-OWNING UNIT via a CONFIGURED GitHub-org → CoU map — NOT
-- via Entra teammate placement (that governs the per-user USAGE display + the Anthropic
-- per-user bill only). This column is that map: the CoU a github org's pooled Copilot bill
-- charges to.
--
--   * NULL = UNMAPPED. The org's pooled bill still surfaces — it lands in the VISIBLE
--     "unallocated" bucket (NULL cost_owning_unit_id in v_finance_copilot_pool_chargeback),
--     never dropped, never silently $0. An admin sets the mapping on the reconciliation-orgs
--     surface (the provider_org PATCH route, extended alongside this migration).
--
-- HOMING NOTE (D-Homing = point-in-time): for Copilot the homing axis is org → CoU (this
-- config map), NOT teammate → org. True point-in-time TEAMMATE→CoU homing (the Anthropic
-- per-teammate axis) needs historical org membership and is a Wave 5 concern — NOT solved
-- here. This map is the CURRENT config: re-pointing an org's CoU restates prior months'
-- per-CoU Copilot figures (a documented v1 limitation; the point-in-time restatement fix is
-- a Wave 5 item, reporting-consolidation risk 3).
--
-- Beside the D4 region_id mapping (mig 0071): region_id answers "where does a bill teammate
-- get placed", cost_owning_unit_id answers "which cost-centre does the pooled bill charge to".

ALTER TABLE provider_org
  ADD COLUMN cost_owning_unit_id uuid REFERENCES org_unit(id);

COMMENT ON COLUMN provider_org.cost_owning_unit_id IS
  'GitHub-org → cost-owning-unit map (Copilot pooled chargeback homing, provider-billing-attribution-model.md §B). NULL = unmapped → visible unallocated bucket, never dropped. Set via the reconciliation-orgs admin PATCH. Current-config (re-point restates prior months; point-in-time is a Wave 5 item).';
