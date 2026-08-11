-- Unit placement rules (C5) + the default-unit occupancy dial (C9).
--
-- ── C5: a rule may target a UNIT, not just a region ────────────────────────
--
-- `directory_region_rule` already answers "when a user's <attribute> = <value>,
-- their region is R". The only thing a cost-centre rule adds is a finer TARGET:
-- "…their unit is U". So this is one nullable column on the existing table, not
-- a second rule table — there is one matcher (mapAttributesToRegion), one loader
-- (PlacementStore.loadDirectoryRegionRules) and one admin write door, and a
-- second of any of those is how a rule engine starts disagreeing with itself.
--
--   org_unit_id IS NULL  → region rule (every rule that exists today).
--   org_unit_id NOT NULL → unit rule; region_id is that unit's region.
--
-- THE COMPOSITE FOREIGN KEY IS THE POINT. `(org_unit_id, region_id)` references
-- `org_unit (id, region_id)`, so a rule can never name a unit while claiming a
-- region the unit is not in. Without it, region_id is a second, independently
-- writable copy of a fact the unit already owns, and the two drift the first
-- time anything writes one without the other — a rule that places people into a
-- unit in region B while every region-scoped reader files it under region A.
-- MATCH SIMPLE (the default) is deliberate: a NULL org_unit_id leaves the
-- constraint unchecked, which is exactly the region-rule case.
--
-- ON UPDATE CASCADE, so if a unit's region_id is ever re-pointed the rule's
-- region follows it rather than blocking the write. The rule targets the UNIT;
-- the region is derived.

ALTER TABLE org_unit
  ADD CONSTRAINT org_unit_id_region_unique UNIQUE (id, region_id);

COMMENT ON CONSTRAINT org_unit_id_region_unique ON org_unit IS
  'Redundant over the primary key on its own — it exists so (org_unit_id, region_id) can be a composite FK target, which is what stops directory_region_rule naming a unit and a region that disagree.';

ALTER TABLE directory_region_rule
  ADD COLUMN org_unit_id uuid;

ALTER TABLE directory_region_rule
  ADD CONSTRAINT directory_region_rule_unit_in_region_fk
  FOREIGN KEY (org_unit_id, region_id) REFERENCES org_unit (id, region_id)
  ON UPDATE CASCADE;

COMMENT ON COLUMN directory_region_rule.org_unit_id IS
  'NULL = a region rule (the original shape). NOT NULL = a unit rule: matching teammates are placed into this cost-owning unit, and region_id is the unit''s own region (held true by directory_region_rule_unit_in_region_fk).';

-- The region-scoped rule list (a region admin sees the rules that target THEIR
-- units) filters on the unit's region, so index the join column.
CREATE INDEX directory_region_rule_org_unit_idx
  ON directory_region_rule (org_unit_id)
  WHERE org_unit_id IS NOT NULL;

-- ── C9: the default unit's "these people do not belong here" dial ──────────
--
-- A region's `default` BU is the catch-all the manager-chain walk lands on when
-- it climbs past a report's own manager and finds no nearer owner. Its EXPECTED
-- occupants are roughly the direct reports of its owner; everyone else is there
-- because a unit somewhere below is missing an owner. Above this many
-- non-direct-reports the region page warns and names the manager clusters behind
-- the number.
--
-- SEEDED, NOT HARD-CODED, and region-overridable through the existing
-- governance_setting precedence (mig 0049): span of control differs by
-- organisation, so 20 is a starting point for this deployment rather than a
-- product constant. server/utils/governance-settings.ts holds the key + bounds.
INSERT INTO governance_setting (key, scope_type, scope_id, value_numeric) VALUES
  ('placement.default_unit_warn_threshold', 'platform', NULL, 20)
ON CONFLICT DO NOTHING;
