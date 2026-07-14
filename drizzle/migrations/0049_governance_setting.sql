-- 0049: governance_setting — configurable thresholds ("dials") for the LIVE
-- detection mechanisms: the velocity spike flag and the reconciliation
-- gap/epsilon/lag dials. Same platform-settable, region-overridable shape as
-- project_lifecycle_policy (mig 0028), but KEYED: each dial is an independent
-- numeric owned by a different mechanism, so one row per (key, scope) beats a
-- wide column-per-dial table that every new dial would have to ALTER.
-- value_numeric is typed NUMERIC (every current dial is a number) — NOT jsonb;
-- a future non-numeric dial earns its own column, not a type erasure.

CREATE TABLE governance_setting (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT NOT NULL,
  scope_type    TEXT NOT NULL CHECK (scope_type IN ('platform', 'region')),
  scope_id      UUID REFERENCES region(id),
  value_numeric NUMERIC NOT NULL,
  updated_by    UUID REFERENCES teammate(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Platform scope has NULL scope_id; a region override must name a region.
  CONSTRAINT governance_setting_scope_shape CHECK (
    (scope_type = 'platform' AND scope_id IS NULL) OR
    (scope_type = 'region'   AND scope_id IS NOT NULL)
  )
);

-- One platform row per key; at most one override per (key, region). Plain
-- column targets (unlike 0028's ((TRUE)) expression singleton) so ON CONFLICT
-- arbiter inference can hit both indexes from the admin upsert.
CREATE UNIQUE INDEX governance_setting_platform_key_unique
  ON governance_setting (key) WHERE scope_type = 'platform';
CREATE UNIQUE INDEX governance_setting_region_key_unique
  ON governance_setting (key, scope_id) WHERE scope_type = 'region';

-- RLS: dials are not sensitive — readable by any authenticated user (the
-- resolved-dials endpoint serves them to every role); writes admin-shaped.
-- NOTE RLS is inert at runtime today (owner connection) — the app-layer
-- requireRole / requireRegionScope gates are the live path.
ALTER TABLE governance_setting ENABLE ROW LEVEL SECURITY;

CREATE POLICY governance_setting_read ON governance_setting
  FOR SELECT
  USING (true);

CREATE POLICY governance_setting_write ON governance_setting
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin', 'admin'));

-- Seed the platform defaults to the previously hard-coded constants so
-- behaviour is unchanged until an admin overrides:
--   velocity.spike_threshold        0.25  (velocity-watch + rollup flag bar)
--   reconciliation.gap_threshold    0.10  (OTel-vs-Anthropic gap worker, EVS)
--   reconciliation.epsilon_usd      0.01  (engine matched-band floor)
--   reconciliation.lag_buffer_hours 48    (engine walk-back lag buffer)
INSERT INTO governance_setting (key, scope_type, scope_id, value_numeric) VALUES
  ('velocity.spike_threshold',        'platform', NULL, 0.25),
  ('reconciliation.gap_threshold',    'platform', NULL, 0.1),
  ('reconciliation.epsilon_usd',      'platform', NULL, 0.01),
  ('reconciliation.lag_buffer_hours', 'platform', NULL, 48);
