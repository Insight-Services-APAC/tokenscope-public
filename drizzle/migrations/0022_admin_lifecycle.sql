-- 0022: admin lifecycle — region code uniqueness + cost-centre soft-retire.
--
-- Backs the admin-region-lifecycle work (region create/edit/delete, cost-centre
-- org_unit CRUD). Two changes:
--
--   1. region.code UNIQUE — region.code was created WITHOUT a unique constraint
--      (only org_unit has UNIQUE (region_id, code)). The finance-scope region
--      filter selects on r.code = 'apac' etc., so duplicate codes would make
--      region-scoped queries ambiguous. Region creation needs a clean 409 on a
--      duplicate code, which this constraint provides. Safe: the seeded regions
--      (apac/emea/us/global/demo) are already distinct.
--
--   2. org_unit.retired_at — cost centres can now be retired from the admin tree
--      editor. Retire is soft (set retired_at) when the unit still has history we
--      must preserve (projects/teammates referenced it); a hard DELETE is only
--      offered when the unit is empty. NULL = active (every existing row).

ALTER TABLE region ADD CONSTRAINT region_code_unique UNIQUE (code);

ALTER TABLE org_unit ADD COLUMN retired_at TIMESTAMPTZ;
