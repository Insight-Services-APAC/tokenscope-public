#!/usr/bin/env bash
# Dev server launcher — reaps anything already serving the port before starting.
#
# 2026-07-29: eight orphaned `nuxt dev` servers accumulated in this project's cw
# (all PPID 1, ~19GB combined) and starved the host until the kernel OOM killer
# fired. Memory pressure hit 57% (PSI full, avg300); input froze for minutes.
# Two independent causes, both addressed here:
#
#   1. Nothing reaped the previous server, so every relaunch leaked one.
#   2. They ran with `--host 127.0.0.1`. Inside a container, podman forwards
#      `-p 3450:3450` to eth0, NOT to loopback — so the host browser got
#      connection-refused every time. Each apparently-failed start prompted
#      another launch, which is how one leak became eight. This script always
#      binds 0.0.0.0; do not override it.
#
# Reaping is PORT-based rather than wrapper-based on purpose: the leaked servers
# were started by invoking `nuxt dev` directly, bypassing `npm run dev`.
set -euo pipefail

PORT="${PORT:-3450}"

# Scan /proc instead of using `pkill -f`: any pattern broad enough to match the
# server also matches the shell running the pkill, so pkill can kill its own
# caller. Skipping $$ and $PPID explicitly is deterministic; a pattern is not.
reap_port() {
    local port="$1" pid cmd alive victims=()

    for d in /proc/[0-9]*; do
        pid="${d#/proc/}"
        [ "$pid" = "$$" ] && continue
        [ "$pid" = "${PPID:-0}" ] && continue
        [ -r "$d/cmdline" ] || continue
        cmd="$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null || true)"
        case "$cmd" in
            *nuxt*"--port $port"*|*nuxt*"--port=$port"*) victims+=("$pid") ;;
        esac
    done

    if [ ${#victims[@]} -eq 0 ]; then
        return 0
    fi

    echo "dev.sh: reaping ${#victims[@]} existing nuxt process(es) on port $port: ${victims[*]}"
    kill -TERM "${victims[@]}" 2>/dev/null || true

    for _ in $(seq 1 10); do
        sleep 1
        alive=0
        for pid in "${victims[@]}"; do
            [ -d "/proc/$pid" ] && alive=1
        done
        [ "$alive" = 0 ] && return 0
    done

    echo "dev.sh: some survived SIGTERM — sending SIGKILL"
    kill -KILL "${victims[@]}" 2>/dev/null || true
    sleep 1
}

reap_port "$PORT"

# Resolve nuxt explicitly: node_modules/.bin is on PATH under `npm run`, but not
# when this script is invoked directly as `bash scripts/dev.sh`.
if [ -x ./node_modules/.bin/nuxt ]; then
    exec ./node_modules/.bin/nuxt dev --host 0.0.0.0 --port "$PORT" "$@"
else
    exec npx nuxt dev --host 0.0.0.0 --port "$PORT" "$@"
fi
