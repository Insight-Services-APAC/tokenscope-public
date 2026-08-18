#!/usr/bin/env bash
# E2E runner — boots the dev stack + nuxt dev + runs Playwright.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PORT="${E2E_PORT:-3450}"
URL="http://127.0.0.1:${PORT}"
LOG="$(mktemp)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG"
}
trap cleanup EXIT

echo "[e2e] starting dev stack..."
bash scripts/dev-stack.sh up >/dev/null 2>&1
sleep 6

export DATABASE_URL="${DATABASE_URL:-postgresql://tokenscope:tokenscope@${CW_WORKER_NAME:-tokenscope}-postgres:5432/tokenscope}"
# fake-azure-monitor endpoint — the OTel-source stand-in the journey spec
# emits spans into (and the server's read-joiner pulls from).
export NUXT_AZURE_MONITOR_ENDPOINT="${NUXT_AZURE_MONITOR_ENDPOINT:-http://${CW_WORKER_NAME:-tokenscope}-fake-azure-monitor:8080}"
export NUXT_OIDC_AUTH_DEV_MODE=true
# Runtime override of the public config so the demo persona grid renders
# even if a stale .nuxt baked authDevMode=false (e.g. a prior `nuxt prepare`).
export NUXT_PUBLIC_AUTH_DEV_MODE=true
# tryAuth only reads the dev persona-override cookie when this is set;
# without it dev mode is "anonymous local-dev" and pages redirect to /login.
export NUXT_ALLOW_PERSONA_OVERRIDE=true
export NUXT_SESSION_SECRET=${NUXT_SESSION_SECRET:-e2e-secret-padded-to-thirty-two-chars-or-more}
export NUXT_HMAC_SESSION_KEY=${NUXT_HMAC_SESSION_KEY:-e2e-hmac-padded-to-thirty-two-chars-or-more}
export NUXT_TELEMETRY_DISABLED=1
# Reporting responses are cached for 60 s by default (server/reporting/report-cache.ts,
# which documents this override as existing "so tests and the perf harness can toggle
# it"). Any E2E that mutates data and then asserts a reporting figure reads the PRE-
# mutation response otherwise — silently, and looking exactly like a broken pipeline.
export TOKENSCOPE_REPORT_CACHE_TTL_MS=0
export SEED_RESET=true
export BASE_URL="$URL"

echo "[e2e] migrate + seed..."
npx tsx drizzle/migrate.ts >/dev/null
npx tsx drizzle/seed.ts >/dev/null

# FAIL FAST ON A STALE SERVER. If something already answers on $PORT, the health
# check below is satisfied by THAT process and the whole suite runs against a
# server this script did not start — different code, different environment.
#
# This is not hypothetical: a `nuxt dev` left over from an earlier run held the
# port for hours. It predated a TOKENSCOPE_REPORT_CACHE_TTL_MS change, so every
# reporting assertion silently read a 60s-CACHED response, a passing spec was
# actually asserting pre-mutation state, and an entire "the regional report never
# shows fresh spend" investigation turned out to be this. The port check is the
# cheapest possible guard against a whole class of phantom findings.
#
# Probed by CONNECTING rather than by parsing `ss`: it is the property that
# actually matters, and it does not depend on ss filter syntax or on the socket
# being visible to this namespace.
if curl -sf -o /dev/null -m 2 "${URL}/api/v1/auth/me" 2>/dev/null; then
  echo "[e2e] ERROR: something already answers on ${URL} — refusing to run against a server this script did not start."
  echo "[e2e] Find it:  ps -eo pid,etimes,cmd | grep 'nuxt dev'   then kill that PID."
  echo "[e2e] Do NOT use pkill -f: it matches this shell's own command line and SIGTERMs your session."
  exit 1
fi

echo "[e2e] booting Nuxt on ${URL}..."
npx nuxt dev --host 127.0.0.1 --port "$PORT" > "$LOG" 2>&1 &
SERVER_PID=$!

for i in $(seq 1 90); do
  if curl -sf -o /dev/null -m 2 "${URL}/api/v1/auth/me"; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Nuxt crashed. Tail:"; tail -80 "$LOG"; exit 1
  fi
  sleep 1
done

echo "[e2e] running playwright..."
# `playwright-chromium` claims the `playwright` bin name in node_modules/.bin,
# so invoke @playwright/test's cli directly.
# Optional spec filter(s) forwarded as "$@"; no args = whole suite.
node node_modules/@playwright/test/cli.js test "$@" --project chromium
