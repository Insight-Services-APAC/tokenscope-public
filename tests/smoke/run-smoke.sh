#!/usr/bin/env bash
# TokenScope smoke runner.
#
# Boots the Nuxt dev server in the background, waits for it to respond,
# runs the playwright-cli smoke checks against it, then tears down.
# Per AGENTS.md §Testing Trophy: smoke is the every-push tier — it must
# stay fast (target < 60 s) and assertion-poor (only "app booted and the
# critical chrome rendered").
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PORT="${SMOKE_PORT:-3450}"
HOST="${SMOKE_HOST:-127.0.0.1}"
URL="http://${HOST}:${PORT}"
LOG="$(mktemp)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Stopping dev server (pid $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG"
}
trap cleanup EXIT

echo "Starting Nuxt dev server on ${URL}..."
# NUXT_TELEMETRY_DISABLED stops `nuxt dev` from prompting for consent on
# first-run, which would hang a fresh CI runner. NUXT_SESSION_SECRET is
# required by server/auth/session.ts; smoke doesn't actually mint a
# session (no cookie is set), but the module fails fast on missing secret
# so the value must satisfy the >= 32-char floor.
# NUXT_OIDC_AUTH_DEV_MODE=true is REQUIRED: the smoke asserts the four
# persona-* buttons, which login.vue renders only under dev-mode
# (config.public.authDevMode). Without it the login page shows the
# production Entra button instead and the smoke fails on persona-developer.
NUXT_TELEMETRY_DISABLED=1 \
NUXT_OIDC_AUTH_DEV_MODE=true \
NUXT_PUBLIC_AUTH_DEV_MODE=true \
NUXT_SESSION_SECRET=smoke-secret-padding-to-32-or-more-chars \
npx nuxt dev --host "$HOST" --port "$PORT" > "$LOG" 2>&1 &
SERVER_PID=$!

# Wait up to 90 s for the dev server to respond to /. Nuxt's first compile
# in CI can be slow, but anything past 90 s indicates a real failure.
echo "Waiting for ${URL}..."
for i in $(seq 1 90); do
  if curl -sf -o /dev/null -m 2 "${URL}/"; then
    echo "Dev server up after ${i}s"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Dev server crashed. Log tail:"
    tail -80 "$LOG"
    exit 1
  fi
  sleep 1
done

if ! curl -sf -o /dev/null -m 5 "${URL}/"; then
  echo "Dev server did not respond within 90s. Log tail:"
  tail -80 "$LOG"
  exit 1
fi

echo "Running playwright-cli smoke checks..."
BASE_URL="$URL" node tests/smoke/chrome.smoke.mjs
echo "Smoke OK"
