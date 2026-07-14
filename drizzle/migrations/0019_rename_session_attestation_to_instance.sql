-- 0019: Rename session_attestation -> instance_attestation (and its health
-- sibling) so the TABLE NAME matches the topology.
--
-- The table has ALWAYS been the per-INSTANCE (device / enrolment) record; its
-- id column was renamed session_id -> instance_id in 0016. This migration
-- finishes the job by renaming the tables themselves. Pure rename, no
-- behavioural change.
--
-- ALTER TABLE ... RENAME is data-safe: rows, PK, FKs, indexes and RLS policies
-- all move with the table. Postgres does NOT auto-rename the dependent
-- identifiers (PK / index / constraint / policy names keep their
-- session_attestation_* spelling but keep working), so we rename the ones whose
-- exact names are confirmed from 0001/0002/0003/0015 for tidiness.

-- ── Tables ────────────────────────────────────────────────────────────
ALTER TABLE session_attestation        RENAME TO instance_attestation;
ALTER TABLE session_attestation_health RENAME TO instance_attestation_health;

-- ── instance_attestation: indexes (explicit names from 0001) ──────────
ALTER INDEX IF EXISTS session_attestation_teammate_ts RENAME TO instance_attestation_teammate_ts;
ALTER INDEX IF EXISTS session_attestation_cou_ts      RENAME TO instance_attestation_cou_ts;
ALTER INDEX IF EXISTS session_attestation_region_ts   RENAME TO instance_attestation_region_ts;

-- ── instance_attestation: PK + unique (Postgres deterministic auto-names) ──
-- Inline PRIMARY KEY -> <table>_pkey; UNIQUE column -> <table>_<col>_key.
ALTER INDEX IF EXISTS session_attestation_pkey                    RENAME TO instance_attestation_pkey;
ALTER INDEX IF EXISTS session_attestation_session_token_hash_key  RENAME TO instance_attestation_session_token_hash_key;

-- ── instance_attestation: CHECK constraint (explicit name from 0015) ──
ALTER TABLE instance_attestation
  RENAME CONSTRAINT session_attestation_attested_has_project
  TO instance_attestation_attested_has_project;

-- ── instance_attestation: RLS policy (explicit name from 0002) ────────
ALTER POLICY session_attestation_region_scope ON instance_attestation
  RENAME TO instance_attestation_region_scope;

-- ── instance_attestation_health: indexes (explicit names from 0003) ───
ALTER INDEX IF EXISTS session_attestation_health_session         RENAME TO instance_attestation_health_session;
ALTER INDEX IF EXISTS session_attestation_health_status_detected RENAME TO instance_attestation_health_status_detected;

-- ── instance_attestation_health: PK (deterministic auto-name) ─────────
ALTER INDEX IF EXISTS session_attestation_health_pkey RENAME TO instance_attestation_health_pkey;
