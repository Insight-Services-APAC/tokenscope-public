-- 0028: project_lifecycle_policy — platform-settable, region-overridable cadence
-- for the end_date model. `grace_hours` (D2 spill buffer, how long after end an
-- in-flight session keeps billing the project before it spills) and `warn_days`
-- (D3 ending-soon window). Scope precedence: a region row overrides the single
-- platform row. Typed columns + CHECKs (NOT env vars — can't be set in-app; NOT
-- a generic key/value store — EAV throws away type safety for two known knobs).
-- Current-state row + the audit_event change log (no `effective` range: config
-- needs no point-in-time billing replay, and the joiner reads grace on every
-- event). See D9 in docs/design/project-lifecycle.md.

CREATE TABLE project_lifecycle_policy (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type  TEXT NOT NULL CHECK (scope_type IN ('platform', 'region')),
  scope_id    UUID REFERENCES region(id),
  grace_hours INTEGER NOT NULL CHECK (grace_hours >= 0),
  warn_days   INTEGER NOT NULL CHECK (warn_days >= 1),
  updated_by  UUID REFERENCES teammate(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Platform scope has NULL scope_id; a region override must name a region.
  CONSTRAINT project_lifecycle_policy_scope_shape CHECK (
    (scope_type = 'platform' AND scope_id IS NULL) OR
    (scope_type = 'region'   AND scope_id IS NOT NULL)
  )
);

-- Exactly one platform row (partial-unique on a constant), at most one per region.
CREATE UNIQUE INDEX project_lifecycle_policy_platform_singleton
  ON project_lifecycle_policy ((TRUE)) WHERE scope_type = 'platform';
CREATE UNIQUE INDEX project_lifecycle_policy_region_unique
  ON project_lifecycle_policy (scope_id) WHERE scope_type = 'region';

-- Seed the editable platform baseline (grace 2h, warn 7d) so EVERY environment
-- has a floor the resolver reads immediately on first deploy. The resolver also
-- hard-falls back to {2,7} if this row is ever absent — defence in depth.
INSERT INTO project_lifecycle_policy (scope_type, scope_id, grace_hours, warn_days)
VALUES ('platform', NULL, 2, 7);
