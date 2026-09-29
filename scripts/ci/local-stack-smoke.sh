#!/usr/bin/env bash
# Local stack smoke: follow docs/RUN-LOCALLY.md from a fresh checkout and prove
# the emit → attribute loop works. Run by CI (Local stack smoke job); runs here
# too. Tears everything down on exit.
#
#   bash scripts/ci/local-stack-smoke.sh
#
# Uses .env as RUN-LOCALLY describes (created from .env.example if absent).
# Exported variables win over .env, which is how a cw container points it at
# the stack's container names. Refuses to run while a dev stack is already up:
# it migrates, seeds and finally removes the stack it tests.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PORT="${PORT:-3450}"
LOG="$(mktemp -d)/dev.log"
DEV_PID=""
CREATED_ENV=0
STARTED_STACK=0

cleanup() {
  local rc=$?
  set +e
  # The dev server runs in its own process group; kill the whole group, since
  # killing the npm wrapper alone leaves nuxt running.
  [ -n "$DEV_PID" ] && kill -TERM -- "-$DEV_PID" 2>/dev/null || true
  [ "$STARTED_STACK" = 1 ] && npm run -s dev:stack:down >/dev/null 2>&1
  [ "$CREATED_ENV" = 1 ] && rm -f .env .env.bak
  exit "$rc"
}
trap cleanup EXIT

step() { echo "==> $*"; }

# 1. Configure (RUN-LOCALLY §1)
if [ ! -f .env ]; then
  cp .env.example .env
  for k in NUXT_SESSION_SECRET NUXT_HMAC_SESSION_KEY NUXT_INTERNAL_WORKER_HMAC_KEY; do
    sed -i.bak "s|^$k=.*|$k=$(openssl rand -base64 48 | tr -d '\n')|" .env
  done
  rm -f .env.bak
  CREATED_ENV=1
fi
# The same values the app reads, for the checks below; exported ones win.
exported=$(export -p)
set -a; . ./.env; set +a
eval "$exported"
DB_URL="${DATABASE_URL}"
AZMON="${NUXT_AZURE_MONITOR_ENDPOINT}"

# 2. Start (RUN-LOCALLY §2)
if npm run -s dev:stack:status 2>/dev/null | tail -n +2 | grep -q .; then
  echo "A dev stack is already running; stop it first (npm run dev:stack:down)." >&2
  exit 1
fi
step "dev:stack"
STARTED_STACK=1
if ! npm run -s dev:stack; then
  # Show why: the logs of every stack container that exited.
  for c in $(docker ps -a --filter status=exited --filter "name=${CW_WORKER_NAME:-tokenscope}-" --format '{{.Names}}'); do
    echo "--- $c"; docker logs --tail 30 "$c" 2>&1
  done
  exit 1
fi
step "db:migrate"
npm run -s db:migrate > /dev/null
step "db:seed"
npm run -s db:seed > /dev/null
step "dev server"
PORT="$PORT" setsid nohup npm run -s dev > "$LOG" 2>&1 &
DEV_PID=$!
for i in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/health" || true)
  [ "$code" = 200 ] && break
  kill -0 "$DEV_PID" 2>/dev/null || { echo "dev server exited"; tail -40 "$LOG"; exit 1; }
  sleep 2
done
[ "$code" = 200 ] || { echo "app never answered /api/health"; tail -40 "$LOG"; exit 1; }
echo "    app healthy"

q() { node -e "
const postgres = require('postgres'); const sql = postgres(process.argv[1], { max: 1 });
sql.unsafe(process.argv[2]).then((r) => { process.stdout.write(String(r[0].n)); return sql.end() })
  .catch((e) => { console.error(e.message); process.exit(1) })" "$DB_URL" "$1"; }
RECORDS="select count(*)::int as n from attribution_record"
TOKENS="select coalesce(sum(total_tokens), 0)::bigint as n from attribution_aggregate"

# Baseline: the seed already has attributed spend, so roll it up first and
# measure growth from here. Only what emit:data sends can move these.
step "baseline"
npm run -s worker -- aggregate-rollup > /dev/null
attr0=$(q "$RECORDS"); tok0=$(q "$TOKENS")
echo "    attribution_record=$attr0 aggregate tokens=$tok0"

# 3. Put data in it (RUN-LOCALLY §3)
step "telemetry store health"
curl -sf "$AZMON/v1/health" > /dev/null
step "emit:data"
npm run -s emit:data | tail -1
for w in azure-monitor-read aggregate-rollup usage-rollup; do
  step "worker $w"
  npm run -s worker -- "$w" > /dev/null
done

# 4. Assert the loop closed: the emitted telemetry was attributed and rolled
#    into the dashboard aggregates.
step "assert"
attr=$(q "$RECORDS"); tok=$(q "$TOKENS")
echo "    attribution_record=$attr aggregate tokens=$tok"
[ "$attr" -gt "$attr0" ] || { echo "FAIL: emitted telemetry was not attributed"; exit 1; }
[ "$tok" -gt "$tok0" ] || { echo "FAIL: attributed telemetry did not reach the aggregates"; exit 1; }
curl -sf "http://127.0.0.1:$PORT/api/v1/meta/build" > /dev/null
echo "OK: local stack smoke passed"
