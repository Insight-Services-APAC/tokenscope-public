-- Per-developer budget caps on allocation.
--
-- data-model.md §project.allocation_mode: 'per_dev_fixed' means "each
-- assigned dev has their own budget ON this project". We model a per-dev
-- cap as a project-scoped allocation row (scope_type='project',
-- scope_id=project_id) carrying a teammate_id; the shared pool baseline
-- is the same shape with teammate_id NULL. This reuses the allocation
-- audit / top-up / effective machinery and the allocationScopePredicate
-- (server/auth/allocation-scope.ts) unchanged — per-dev rows are still
-- scoped by the project's cost-owning unit.
--
-- The existing exclusion constraint keyed (scope_type, scope_id,
-- allocation_kind, effective) — that would forbid more than one baseline
-- per project per period, blocking per-dev rows. Replace it with one that
-- also discriminates on teammate_id, COALESCE-ing the NULL pool rows to a
-- fixed sentinel so two overlapping POOL baselines still conflict (the
-- invariant the old constraint protected) while distinct per-dev rows
-- coexist.

ALTER TABLE allocation ADD COLUMN teammate_id UUID REFERENCES teammate(id);

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'allocation'::regclass
     AND contype = 'x';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE allocation DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE allocation ADD CONSTRAINT allocation_scope_dev_kind_eff_excl
  EXCLUDE USING gist (
    scope_type WITH =,
    scope_id WITH =,
    COALESCE(teammate_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    allocation_kind WITH =,
    effective WITH &&
  );

CREATE INDEX allocation_teammate_idx ON allocation (teammate_id) WHERE teammate_id IS NOT NULL;
