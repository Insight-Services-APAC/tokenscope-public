#!/usr/bin/env bash
# Parity capture — the entry point everything documents. The capture itself is
# `scripts/parity-capture.mjs` (read its header for what the gate does and why);
# the shot matrix is `scripts/parity-jobs.mjs`, unit-tested by T29.
#
# It moved to Node in fix-sprint D29 for two reasons. `@playwright/cli` ships an
# x86-64 Chrome and cannot run on the aarch64 dev boxes; and its sessions are
# keyed by NAME globally per host, so two agents running the gate concurrently
# drove the same browser and one read the other's screenshots as its own.
#
#   ./scripts/parity-shots.sh region                   # one reporting scope
#   ./scripts/parity-shots.sh region cost-centres finance
#   ./scripts/parity-shots.sh usage projects project   # developer pages
#
# Env (all optional): PARITY_OUT APP_BASE PROTO_PORT PROTO2_PORT PARITY_PERSONA
# PARITY_PROJECT PARITY_TEAMMATE PARITY_SRC PARITY_PROTO_VIEWER PARITY_TIMEOUT
# PARITY_WIDTHS (default "1120 1600") PARITY_STATES (default "mid d1")
# PARITY_CLOCK_MID (pin the mid-month state too, for a reproducible shot).
#
# The default scope set expands WORD-WISE — `${@:-…}` is deliberately unquoted.
# Quoted, it collapses into one word and a bare run rejects its own default list.
#
# Requires: dev stack up, `npm run dev` on :3450 with NUXT_OIDC_AUTH_DEV_MODE=true
# and NUXT_SESSION_SECRET set, against a migrated database.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/parity-capture.mjs ${@:-region cost-centres finance}
