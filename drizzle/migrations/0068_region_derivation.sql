-- Org Entra read — region derivation for unplaced users.
-- Design: docs/design/org-entra-region-derivation.md
--
-- Follow-up to 0066 (bill-driven placement): unplaced users (no cost-centre match) are
-- derived into their REAL region via Entra `department` (curated map) or, as a fallback,
-- a manager-chain walk to a configured region leader. Mirrors the proven Insight AEUF
-- pattern (app-only User.Read.All). Adds the two curated-config tables; the Global/Shared
-- region and per-region __UNPLACED__ holding nodes are created ON DEMAND by the store
-- (NOT seeded here — a migration-time seed pollutes other tests' SELECT ... LIMIT 1
-- fixtures, same reason as the 0066 __unassigned__ node).
--
-- FK posture: region_id is plain NO ACTION (RESTRICT-like), never CASCADE — a region
-- delete must FAIL (clean 409 via the delete endpoint's emptiness check, which this
-- change extends) rather than silently drop curated mappings and re-scope spend.

-- ── department → region (primary signal; admin-curated, AEUF department_to_practice) ──
-- PK is the normalised (trim+lower) department so lookup is case-insensitive; the
-- original casing is kept for display. `department` is a base Entra user property
-- (app-only readable), already fetched in DirectoryUser.
CREATE TABLE IF NOT EXISTS department_to_region (
  department_lower text PRIMARY KEY,
  department       text NOT NULL,
  region_id        uuid NOT NULL REFERENCES region(id),
  created_by       uuid REFERENCES teammate(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz
);

-- ── region leaders (manager-walk fallback target) ─────────────────────────────────────
-- Keyed on the leader's Entra `oid` (stable + unspoofable; the /manager hop returns the
-- manager's id). leader_email is display/admin only. Soft-revoke mirrors cou_owner
-- (active = revoked_at IS NULL). One ACTIVE leader oid maps to exactly one region.
CREATE TABLE IF NOT EXISTS region_leader (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id     uuid NOT NULL REFERENCES region(id),
  leader_oid    text NOT NULL,
  leader_email  text NOT NULL,
  kind          text NOT NULL DEFAULT 'region-svp',
  display_name  text,
  added_by      uuid REFERENCES teammate(id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES teammate(id),
  CONSTRAINT region_leader_kind_check CHECK (kind IN ('region-svp', 'shared-function-global'))
);
CREATE UNIQUE INDEX IF NOT EXISTS region_leader_oid_active_unique
  ON region_leader (leader_oid) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS region_leader_region_active
  ON region_leader (region_id) WHERE revoked_at IS NULL;
