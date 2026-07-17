#!/usr/bin/env bash
# Local-but-real spike runner: real `claude` → reshaped telemetry store →
# real read-joiner → attribution_record, asserted by real-claude-spike.ts.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

export DATABASE_URL="${DATABASE_URL:-postgresql://tokenscope:tokenscope@${CW_WORKER_NAME:-tokenscope}-postgres:5432/tokenscope}"
export NUXT_AZURE_MONITOR_ENDPOINT="http://127.0.0.1:4319"

echo "[spike] dev stack up (postgres)…"
bash scripts/dev-stack.sh up >/tmp/spike-devstack.log 2>&1 || true
sleep 4

echo "[spike] starting reshaped telemetry store on :4319…"
# Kill any prior local store on the port (by port — never a pattern that
# would match this script's own text).
(lsof -ti tcp:4319 2>/dev/null | xargs -r kill -9) 2>/dev/null || true
sleep 1
PORT=4319 node tools/fake-azure-monitor/server.js >/tmp/spike-store.log 2>&1 &
STORE_PID=$!
sleep 1

echo "[spike] migrate + seed…"
SEED_RESET=true npx tsx drizzle/migrate.ts >/tmp/spike-migrate.log 2>&1 \
  && SEED_RESET=true npx tsx drizzle/seed.ts >/tmp/spike-seed.log 2>&1 \
  || { echo "[spike] migrate/seed FAILED"; tail -20 /tmp/spike-seed.log /tmp/spike-migrate.log; kill "$STORE_PID" 2>/dev/null; exit 1; }

echo "[spike] running real-claude spike…"
npx tsx tests/e2e/real-claude-spike.ts
RC=$?

kill "$STORE_PID" 2>/dev/null || true
echo "[spike] store health: $(curl -sf http://127.0.0.1:4319/ 2>/dev/null || echo '(stopped)')"
exit "$RC"
