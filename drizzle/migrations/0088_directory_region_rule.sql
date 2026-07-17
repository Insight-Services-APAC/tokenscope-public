-- 0088: generalise department_to_region → directory_region_rule.
--
-- mig 0068 keyed region derivation on Entra `department`, which is uniformly
-- "Services" at Insight → the map was inert. Real profiles carry region in OTHER
-- attributes (companyName "Insight Australia", country, officeLocation "AU-…").
-- Generalise to an ATTRIBUTE-agnostic rule so any tenant keys on whichever
-- directory field is region-correlated on THEIR directory. See
-- shared/placement/region-attributes.ts + the design doc.
--
-- RENAME + ADD COLUMN (NOT drop/recreate): preserves the region_id FK (NO ACTION)
-- that regions/[id].delete.ts's 409-guard counts, and the region_leader companion.
-- The table is empty in practice (never seeded), so backfilling the existing
-- department rows to attribute='department' is behaviour-preserving.

ALTER TABLE department_to_region RENAME TO directory_region_rule;
ALTER TABLE directory_region_rule RENAME COLUMN department_lower TO match_value;
ALTER TABLE directory_region_rule RENAME COLUMN department TO match_value_raw;

-- New columns. `attribute` gets a TEMPORARY default so existing rows backfill to
-- the old behaviour (department rules); the default is then dropped so the app
-- must always supply it (matches the Drizzle schema: notNull, no default).
ALTER TABLE directory_region_rule ADD COLUMN attribute text NOT NULL DEFAULT 'department';
ALTER TABLE directory_region_rule ALTER COLUMN attribute DROP DEFAULT;
ALTER TABLE directory_region_rule ADD COLUMN match_mode text NOT NULL DEFAULT 'exact';
ALTER TABLE directory_region_rule ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();

-- Swap the primary key from the natural department key to the surrogate id
-- (a rule is now (attribute, value), so the value alone is no longer unique).
-- NB: Postgres does NOT rename a table's implicit constraint names on RENAME TO,
-- so the inline PK from 0068 is still named `department_to_region_pkey` here.
ALTER TABLE directory_region_rule DROP CONSTRAINT department_to_region_pkey;
ALTER TABLE directory_region_rule ADD PRIMARY KEY (id);

-- One region per (attribute, value) — the upsert key.
CREATE UNIQUE INDEX directory_region_rule_attr_value_unique
  ON directory_region_rule (attribute, match_value);

-- Index the FK the region-delete 409-guard counts (SELECT COUNT(*) ... WHERE
-- region_id = ?), and any future growth. (The old table lacked this — close it now.)
CREATE INDEX directory_region_rule_region_id_idx
  ON directory_region_rule (region_id);
