#!/usr/bin/env bash
# Dev stack helper — brings the local stack up/down/status via docker compose.
#
# On a workstation the stack publishes to 127.0.0.1 (docker-compose.yml). Inside
# a cw container (CW_NETWORK set) it adds docker-compose.cw.yml: no published
# ports, services on the cw network by container name.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

cmd="${1:-up}"

compose=(docker compose -f docker-compose.yml)
if [ -n "${CW_NETWORK:-}" ]; then
  compose+=(-f docker-compose.cw.yml)
fi

case "$cmd" in
  up)
    echo "Starting TokenScope dev stack${CW_NETWORK:+ on cw network $CW_NETWORK}..."
    "${compose[@]}" up -d --build --remove-orphans --wait
    echo ""
    echo "Stack:"
    "${compose[@]}" ps
    echo ""
    echo "Next: npm run dev (binds 0.0.0.0:3450)"
    ;;
  down)
    echo "Stopping TokenScope dev stack..."
    "${compose[@]}" down --remove-orphans
    ;;
  status)
    "${compose[@]}" ps
    ;;
  *)
    echo "usage: $0 [up|down|status]" >&2
    exit 64
    ;;
esac
