#!/usr/bin/env bash
# Production container entrypoint.
#
# Migrate-on-boot pattern: idempotent (drizzle/migrate.ts tracks applied
# migrations in _drizzle_migrations). Safe on every replica restart.
set -euo pipefail

# Pre-flight: probe every provisioned private-endpoint dependency and log each
# one's reachability BEFORE migrations, so a network gap surfaces as a named
# per-service line (e.g. `postgres: UNREACHABLE …:5432 [timeout]`) instead of a
# cryptic migration abort. Aborts boot only on a CRITICAL service (Postgres);
# an un-wired but unused PE (Redis/KV) warns but does not block.
echo "[entrypoint] preflight: probing dependency reachability..."
node node_modules/.bin/tsx scripts/preflight-run.ts || {
  echo "[entrypoint] preflight failed: a critical dependency is unreachable; aborting boot"
  exit 1
}

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] applying migrations..."
  node node_modules/.bin/tsx drizzle/migrate.ts || {
    echo "[entrypoint] migration failed; aborting boot"
    exit 1
  }
  # Bootstrap the real regions on a FRESH database only (SEED_REGIONS_IF_EMPTY
  # makes it a no-op when any region exists), so first Entra sign-in can
  # JIT-provision instead of failing on "no region rows". Idempotent + safe on
  # every replica restart. Non-fatal: a hiccup here must not take the app down,
  # and the next boot retries.
  echo "[entrypoint] ensuring bootstrap regions..."
  SEED_REGIONS_IF_EMPTY=true node node_modules/.bin/tsx drizzle/seed-regions.ts || \
    echo "[entrypoint] region bootstrap failed (non-fatal); first sign-in may loop until regions exist"
  # Bootstrap the canonical org structure (each region's BU/practice tree). VERSIONED:
  # SEED_ORG_STRUCTURE_IF_OUTDATED applies it only while seed_state.version is behind the
  # seed's SEED_ORG_STRUCTURE_VERSION (a fresh DB, or a deliberate version bump rolling a
  # structural change to every env on its next deploy), then no-ops — never overriding manual
  # UI edits. Same migrate-on-boot discipline as the region bootstrap above; non-fatal so a
  # hiccup can't take the app down.
  echo "[entrypoint] ensuring org structure (versioned)..."
  SEED_ORG_STRUCTURE_IF_OUTDATED=true node node_modules/.bin/tsx drizzle/seed-org-structure.ts || \
    echo "[entrypoint] org-structure seed failed (non-fatal); structure can be seeded later"
else
  echo "[entrypoint] DATABASE_URL unset; skipping migrations"
fi

echo "[entrypoint] starting Nitro server on :${NITRO_PORT:-3000}..."
exec node .output/server/index.mjs
