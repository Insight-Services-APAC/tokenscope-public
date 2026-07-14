-- 0020: activity tagging — an orthogonal axis on attribution.
-- Design: docs/design/activity-tagging-attribution.md; ADR-0004 Amendment 1.
--
-- Activity (documentation / development / testing / release / research / ...) is
-- INDEPENDENT of project attribution: it applies to both budgeted (project) and
-- unattributed (personal-lane) spend. It is a developer-set LABEL, never a gate,
-- set retroactively in the UI (no emitted attribute, no client surface).

-- session_assignment gains an optional activity; project_id becomes optional so a
-- session can be tagged with an activity but NO project (the personal lane). The
-- CHECK keeps a row meaningful: at least one of project_id / activity present.
ALTER TABLE session_assignment ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE session_assignment ADD COLUMN activity TEXT;
ALTER TABLE session_assignment
  ADD CONSTRAINT session_assignment_project_or_activity
  CHECK (project_id IS NOT NULL OR activity IS NOT NULL);

-- attribution_record gains a denormalised activity, stamped by the joiner / the
-- assign endpoint for ATTRIBUTED sessions (within-project activity rollups).
-- Nullable. Unattributed spend produces no attribution_record row (project_id is
-- NOT NULL there), so activity-BY-SPEND for the personal lane is deferred — the
-- label lives on session_assignment, the spend is the reconciliation gap.
ALTER TABLE attribution_record ADD COLUMN activity TEXT;
CREATE INDEX attribution_record_activity
  ON attribution_record (activity) WHERE activity IS NOT NULL;

-- activity_type — the hybrid vocabulary's suggestion list. A NULL region_id is a
-- global/standard entry; a region-scoped entry is that region's own addition. The
-- value stored on session_assignment / attribution_record is a plain string: if it
-- matches a published label it aggregates firm-wide, if free-form it stays personal.
CREATE TABLE activity_type (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id   UUID REFERENCES region(id),
  label       TEXT NOT NULL,
  is_standard BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One label per scope (global vs a given region), case-insensitive so the picker
-- never offers documentation + Documentation as two entries. Two PARTIAL indexes
-- rather than a COALESCE-to-sentinel, so a global label and a region label can
-- never alias through a sentinel uuid.
CREATE UNIQUE INDEX activity_type_global_label_unique
  ON activity_type (lower(label)) WHERE region_id IS NULL;
CREATE UNIQUE INDEX activity_type_region_label_unique
  ON activity_type (region_id, lower(label)) WHERE region_id IS NOT NULL;

-- Seed the standard global set (the picker offers these first; free-form is still
-- allowed per the hybrid model).
INSERT INTO activity_type (region_id, label, is_standard, sort_order) VALUES
  (NULL, 'documentation', TRUE, 10),
  (NULL, 'development',   TRUE, 20),
  (NULL, 'testing',       TRUE, 30),
  (NULL, 'release',       TRUE, 40),
  (NULL, 'research',      TRUE, 50),
  (NULL, 'admin',         TRUE, 60);
