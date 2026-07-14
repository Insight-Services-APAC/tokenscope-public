-- Bill-driven user placement (directory/tree/user sync).
-- Design: docs/design/org-tree-and-bill-driven-placement.md
--
-- Cost-bearing users (in a provider bill / holding a seat) become teammates and are
-- placed in the curated region→org_unit tree by matching their Entra cost centre to
-- a cost-owning unit's cost_centre_code. No 15,500-user directory dump; only
-- license/cost users. Adversarially reviewed twice — this migration carries the H-A,
-- H3, and M-B fixes.

-- ── H3: the cost-centre join key — exact, GLOBALLY UNIQUE, normalised ──────────
-- A cost-centre number is an org-wide accounting identifier → unique across regions
-- (the bill carries no region, so a per-region code would be ambiguous → mis-charge).
-- A reused code fails at admin-time (visible), never silently mis-charges.
ALTER TABLE org_unit ADD COLUMN IF NOT EXISTS cost_centre_code text;
CREATE UNIQUE INDEX IF NOT EXISTS org_unit_cost_centre_code_unique
  ON org_unit (lower(btrim(cost_centre_code)))
  WHERE cost_centre_code IS NOT NULL;

-- ── H-A: teammate.region_id can never drift from its org_unit's region ─────────
-- region_id and org_unit_id were independent NOT-NULL FKs that nothing kept
-- consistent; the JIT defaulted region_id to the first region (APAC). Placement
-- re-homes org_unit_id, so region_id MUST follow. Make it DERIVED: always set from
-- the org_unit's region on insert/update — so a region/CoU mismatch is impossible.
CREATE OR REPLACE FUNCTION teammate_sync_region_id() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  SELECT ou.region_id INTO NEW.region_id FROM org_unit ou WHERE ou.id = NEW.org_unit_id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS teammate_region_consistency ON teammate;
CREATE TRIGGER teammate_region_consistency
  BEFORE INSERT OR UPDATE ON teammate
  FOR EACH ROW EXECUTE FUNCTION teammate_sync_region_id();

-- ── The holding home for users we can't place (L1) ────────────────────────────
-- A system __unassigned__ region + a non-cost-owning __UNPLACED__ unit: unplaced
-- users home there and roll up to the (unassigned) region with NO cost centre —
-- "unattributed to a cost centre", never $0, never lost; placement moves them to a
-- real node later. Created ON DEMAND by placement-store.unplacedOrgUnitId(), NOT
-- seeded here: a migration-time seed adds rows that pollute other tests' fixtures
-- that do `SELECT ... FROM region/org_unit LIMIT 1` (it broke connector-health).
-- INTERIM: this is a SINGLE global holding region, NOT the per-region node the design
-- targets — the bill path has no region signal for an unplaced user. Per-region
-- holding lands with the manager-chain region-derivation follow-up (Entra manager walk
-- → region leader). See docs/design/org-tree-and-bill-driven-placement.md §Impl status.

-- ── M-B: durable owed-bill queue (decoupled from the 30-day re-pull) ───────────
-- A bill for an as-yet-unprovisioned user can't be written to actual_spend
-- (teammate_id NOT NULL FK). Instead the bill writers ENQUEUE the owed bill here;
-- the placement worker provisions+places the user, then REPLAYS these rows into
-- actual_spend. Durable, so a >30-day placement delay can't age the bill out of the
-- poll window and lose it. Idempotent on the natural bill key.
CREATE TABLE IF NOT EXISTS pending_placement (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,              -- 'anthropic' | 'github'
  actual_source  text NOT NULL,              -- the actual_spend.source to write on replay
  identity_email text NOT NULL,              -- provider-attested bill identity (lowercased)
  tool           text NOT NULL,              -- 'claude-code' | 'copilot-cli'
  date           date NOT NULL,
  cost_usd       numeric(14,6) NOT NULL,
  input_tokens   bigint NOT NULL DEFAULT 0,
  output_tokens  bigint NOT NULL DEFAULT 0,
  raw_payload    jsonb,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  placed_at      timestamptz,                -- set when replayed into actual_spend
  CONSTRAINT pending_placement_bill_unique UNIQUE (provider, actual_source, identity_email, tool, date)
);
-- The worker scans un-replayed rows oldest-first; alert if any age past a grace window.
CREATE INDEX IF NOT EXISTS pending_placement_unplaced ON pending_placement (first_seen_at) WHERE placed_at IS NULL;
