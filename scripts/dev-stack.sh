#!/usr/bin/env bash
# Dev stack helper — brings the 5 sibling containers up/down/status via docker compose.
#
# Wraps `docker compose` so callers don't have to remember the
# CW_NETWORK / CW_WORKER_NAME env-var dance.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

cmd="${1:-up}"

case "$cmd" in
  up)
    echo "Starting TokenScope dev stack on network ${CW_NETWORK:-bridge}..."
    docker compose up -d --build --remove-orphans
    echo ""
    echo "Stack:"
    docker compose ps
    echo ""
    echo "Next: npm run dev (binds 0.0.0.0:3450)"
    ;;
  down)
    echo "Stopping TokenScope dev stack..."
    docker compose down --remove-orphans
    ;;
  status)
    docker compose ps
    ;;
  *)
    echo "usage: $0 [up|down|status]" >&2
    exit 64
    ;;
esac
