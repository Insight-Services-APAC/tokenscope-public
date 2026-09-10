#!/usr/bin/env bash
#
# Devcontainer post-create: a local PostgreSQL 16 for the integration suite.
#
# WHY A LOCAL SERVER. This devcontainer has no docker/podman socket (base image
# + node + github-cli features, nothing else), so tests/integration/helpers/db.ts
# cannot start its per-file `postgres:16` testcontainer — every integration file
# dies with "Could not find a working container runtime strategy". The helper's
# TEST_PG_URL path takes any PG-16 server and provisions a throwaway database
# per test file on it (same migrations, same per-file isolation); this script is
# that server, and devcontainer.json points TEST_PG_URL at it.
#
# WHY APT, NOT A DEVCONTAINER FEATURE. The base image is Ubuntu noble, whose own
# archive ships postgresql-16 + contrib — ltree, pgcrypto, btree_gist (the
# migrations) and pg_stat_statements (the db-performance probe) included. It is
# exactly the package that ran the suite green on 2026-09-01; a third-party
# feature would pin us to someone else's install script for the same result.
#
# WHAT IS DELIBERATELY LEFT AT THE PACKAGE DEFAULT.
#   - `shared_preload_libraries` stays empty: the db-performance route test
#     asserts the "extension installable, library NOT preloaded" configuration,
#     which is also what a testcontainer gives it.
#   - listen_addresses stays `localhost`: trust auth below is loopback-only, in
#     a single-user container holding nothing but test data.
#
# Idempotent — safe to re-run by hand.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends postgresql-16 postgresql-contrib

# Trust on loopback: the helper connects as `postgres` with no password. That
# superuser is what CREATE DATABASE, CREATE EXTENSION and the role-provisioning
# tests need; nothing in the suite needs more than the package provides.
sudo tee /etc/postgresql/16/main/pg_hba.conf >/dev/null <<'EOF'
# Written by .devcontainer/post-create.sh — loopback-only trust for the test suite.
local   all   all                 trust
host    all   all   127.0.0.1/32  trust
host    all   all   ::1/128       trust
EOF

sudo service postgresql restart

for _ in $(seq 1 30); do
  pg_isready -q -h 127.0.0.1 -p 5432 && break
  sleep 1
done
pg_isready -h 127.0.0.1 -p 5432

# Fail loud if the extensions the migrations need are not installable here.
available=$(psql -h 127.0.0.1 -U postgres -tA -c \
  "SELECT count(*) FROM pg_available_extensions
    WHERE name IN ('ltree', 'pgcrypto', 'btree_gist', 'pg_stat_statements')")
if [ "$available" != "4" ]; then
  echo "expected ltree, pgcrypto, btree_gist and pg_stat_statements to be installable; found $available of 4" >&2
  exit 1
fi
echo "postgresql 16 ready on 127.0.0.1:5432 — extensions available: ltree pgcrypto btree_gist pg_stat_statements"
