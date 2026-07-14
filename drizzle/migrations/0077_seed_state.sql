-- 0077: seed_state — a tiny version ledger for idempotent, re-runnable DATA seeds.
--
-- Schema migrations are tracked by filename in _drizzle_migrations; that mechanism is for DDL.
-- Data bootstraps (the canonical org structure) need their own "applied version" so they can run
-- ONCE on a fresh database and then re-run only when the seed's content is deliberately revised
-- (bump the SEED_*_VERSION constant in the seed). Keyed by seed name so multiple seeds can share it.
CREATE TABLE IF NOT EXISTS seed_state (
  name        text PRIMARY KEY,
  version     integer NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
