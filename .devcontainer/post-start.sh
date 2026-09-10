#!/usr/bin/env bash
#
# Devcontainer post-start: bring the local PostgreSQL 16 back up.
#
# post-create.sh installs and configures it once; a stopped container does not
# restart its services, so this runs on every start. Idempotent — `service start`
# on a running server is a no-op.
set -euo pipefail

sudo service postgresql start

for _ in $(seq 1 30); do
  pg_isready -q -h 127.0.0.1 -p 5432 && exit 0
  sleep 1
done
echo "postgresql did not become ready on 127.0.0.1:5432 — integration tests will fail; see .devcontainer/post-create.sh" >&2
exit 1
