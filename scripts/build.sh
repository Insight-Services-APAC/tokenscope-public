#!/usr/bin/env bash
#
# `npm run build` — Nuxt production build with an explicit V8 heap cap.
#
# WHY. Node sizes its default heap from the machine's RAM: ~4 GB on a 16 GB
# GitHub runner, but ~2 GB on the 10 GB devcontainer — and the Nitro server
# bundle (rollup, after the client and server compile) needs more than 2 GB.
# On 2026-09-01 the build died there with "FATAL ERROR: Reached heap limit
# Allocation failed - JavaScript heap out of memory" at 2 039 MB, and completed
# with the cap raised. CLAUDE.md rule 20 previously recorded the same build
# being OOM-killed (exit 137) as a trap to avoid; this is the fix.
#
# WHY 4096. It is the most V8 ever picks on its own (a 16 GB machine gets 4 GB),
# so no environment that builds today — the Dockerfile's stage 2 runs this same
# script, under `az acr build` and under `docker build` on the 4-core dev
# runner — gets a smaller cap than it had, and every environment now gets the
# same one instead of whatever its RAM implied. ci.yml does not run the build
# at all. It is a CAP, not a reservation: V8 only grows the heap as far as the
# build needs, so it costs nothing where the default already sufficed, and
# 4 GB leaves the 10 GB devcontainer (~7 GB free) room for a running Postgres
# and an editor beside it.
#
# Appended, not replaced: NODE_OPTIONS from the environment is kept, and a later
# --max-old-space-size wins in Node, so an operator can still override it.
set -euo pipefail

export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=4096"
exec npx nuxt build "$@"
