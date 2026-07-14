#!/usr/bin/env sh
# SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/otel-headers-helper.sh. Re-generate with: npm run sync:copilot-plugin
# otelHeadersHelper — called by Claude Code every ~29 minutes to refresh
# the Azure Monitor Bearer for OTLP emission. Per RN-15 §Stream 3, the
# helper must print a JSON object with one Authorization header to stdout.
#
# Contract (unchanged): on success, print the bearer JSON to stdout and
# exit 0. On failure, print nothing parseable to stdout and exit non-zero —
# the exporter then keeps its previous (now-stale) header and silently
# drops logs once it expires. THAT silent drop is the ADR-0005 disaster.
#
# Auth (ADR-0005 slice 2b — durable, auto-refreshing emission auth; OAuth-only):
#   Present a short-lived OAuth `tokenscope.emit` ACCESS token to /bearer. The
#   access token is cached on disk with its expiry and re-minted via the
#   refresh_token grant against the OAuth token endpoint when missing/near-expiry.
#   This auto-refresh is what kills the silent-death: the durable refresh token
#   never expires under active use, so /bearer never 401s "Session expired".
#   (The legacy per-instance 12h session token has been removed entirely.)
#
# SELF-HEAL a superseded cached token (ADR-0007 follow-up): if a CACHED OAuth
# access token is rejected by /bearer (401/403), another refresh (a concurrent CW
# on the same host, an out-of-band refresh, or a deploy) likely superseded it —
# the oauth_token row holds ONE access-token hash. We drop the cache, force ONE
# fresh refresh, and retry /bearer once, so a superseded token does NOT drop an
# emit cycle or trip the proactive "re-provision" warning. A genuinely revoked
# credential fails the refresh (we exit) or 401s the retry too (handled as fatal).
#
# What this script adds (ADR-0005 decision 4 — loud helper failure):
#   - On a non-200 /bearer response (or a failed token refresh), print a clear
#     human warning to STDERR and write a sentinel file so /tokenscope:status
#     (and any other tooling) can surface that emission auth is broken.
#   - On success, clear the sentinel.
# Token material (refresh token, access token) is NEVER written to stderr or the
# sentinel.
#
# Required env:
#   TOKENSCOPE_BEARER_ENDPOINT   — e.g. https://attestation/api/v1/instances/{instanceId}/bearer
# Auth env (OAuth — all three required):
#   TOKENSCOPE_OAUTH_REFRESH_TOKEN + TOKENSCOPE_OAUTH_TOKEN_ENDPOINT + TOKENSCOPE_OAUTH_CLIENT_ID
# Optional env:
#   TOKENSCOPE_STATE_DIR         — where the sentinel + token cache live (default $HOME/.tokenscope)
set -eu

# POSIX sh has no `pipefail`; we avoid pipes in the failure path instead.

STATE_DIR="${TOKENSCOPE_STATE_DIR:-$HOME/.tokenscope}"
SENTINEL="${STATE_DIR}/emit-failure.json"
ACCESS_CACHE="${STATE_DIR}/oauth-access.json"
# Re-mint the access token if it expires within this many seconds.
EXPIRY_SKEW=120

# Clear the failure sentinel (best-effort; never fail the helper over it).
clear_sentinel() {
  [ -f "$SENTINEL" ] && rm -f "$SENTINEL" 2>/dev/null
  return 0
}

# Write/refresh the failure sentinel. Args: $1 = http status, $2 = message.
# JSON is hand-built (no jq dependency); the message is sanitised of quotes
# and backslashes so it can't break the JSON. Token material is never included.
write_sentinel() {
  _status="$1"
  _msg="$2"
  _ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
  # Strip characters that would break a bare JSON string literal.
  _msg_safe="$(printf '%s' "$_msg" | tr -d '"\\\n\r' | cut -c1-300)"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  printf '{"ts":"%s","http_status":%s,"message":"%s"}\n' \
    "$_ts" "$_status" "$_msg_safe" >"$SENTINEL" 2>/dev/null || true
  return 0
}

# Extract a JSON string field value (best-effort, no jq). Args: $1=body $2=field.
json_str() {
  printf '%s' "$1" \
    | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" \
    | head -n1
}
# Extract a JSON numeric field value (best-effort, no jq). Args: $1=body $2=field.
json_num() {
  printf '%s' "$1" \
    | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" \
    | head -n1
}

now_epoch() { date -u +%s 2>/dev/null || echo 0; }

# Percent-encode a value for an application/x-www-form-urlencoded body (POSIX sh,
# no external deps). Unreserved chars (RFC 3986: ALPHA / DIGIT / - . _ ~) pass
# through; everything else becomes %XX. The server mints base64url tokens today,
# so this is currently a no-op — but a future token containing '+', '&' or '='
# would silently corrupt the grant if interpolated raw. ASCII-safe (the values
# are server-minted ASCII; multi-byte input is not expected here).
urlencode() {
  _ue_in="$1"
  _ue_out=""
  while [ -n "$_ue_in" ]; do
    _ue_rest="${_ue_in#?}"
    _ue_c="${_ue_in%"$_ue_rest"}"
    case "$_ue_c" in
      [A-Za-z0-9._~-]) _ue_out="${_ue_out}${_ue_c}" ;;
      *) _ue_out="${_ue_out}$(printf '%%%02X' "'${_ue_c}")" ;;
    esac
    _ue_in="$_ue_rest"
  done
  printf '%s' "$_ue_out"
}

# ── OAuth refresh_token grant ─────────────────────────────────────────────────
# Run the refresh grant; on success set AUTH_TOKEN + persist the access cache. On
# failure write the sentinel + exit 1 (a failed refresh means the durable
# credential is dead — a retry cannot help). The refresh token rides in via STDIN
# (--data-binary @-) so it never appears in argv / a `ps` listing.
oauth_refresh() {
  _now="$(now_epoch)"
  TOK_STATUS=000
  # Percent-encode the interpolated values: a '+', '&' or '=' in either would
  # otherwise silently corrupt the form body → refresh fails → emission dies.
  _tok_form="grant_type=refresh_token&client_id=$(urlencode "${TOKENSCOPE_OAUTH_CLIENT_ID}")&refresh_token=$(urlencode "${TOKENSCOPE_OAUTH_REFRESH_TOKEN}")"
  _tok_response="$(
    printf '%s' "$_tok_form" | curl -s --connect-timeout 5 --max-time 10 -w '\n%{http_code}' \
      -X POST \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data-binary @- \
      "${TOKENSCOPE_OAUTH_TOKEN_ENDPOINT}" 2>/dev/null
  )" || _tok_response=""

  _tok_body=""
  if [ -n "$_tok_response" ]; then
    TOK_STATUS="$(printf '%s' "$_tok_response" | tail -n1)"
    _tok_body="$(printf '%s' "$_tok_response" | sed '$d')"
  fi

  if [ "$TOK_STATUS" != "200" ]; then
    _err="$(json_str "$_tok_body" error)"
    [ -z "$_err" ] && _err="token refresh failed"
    echo "TokenScope: emission auth FAILED (OAuth refresh HTTP ${TOK_STATUS} ${_err}) — telemetry is being DROPPED. The durable credential may have lapsed; re-provision emit via the tokenscope-setup MCP prompt or run /tokenscope:status." >&2
    write_sentinel "$TOK_STATUS" "oauth refresh failed: ${_err}"
    exit 1
  fi

  _new_access="$(json_str "$_tok_body" access_token)"
  _new_expires_in="$(json_num "$_tok_body" expires_in)"
  [ -z "$_new_expires_in" ] && _new_expires_in=0
  if [ -z "$_new_access" ]; then
    echo "TokenScope: emission auth FAILED (OAuth refresh returned no access_token) — telemetry is being DROPPED. Run /tokenscope:status." >&2
    write_sentinel "$TOK_STATUS" "oauth refresh returned no access_token"
    exit 1
  fi

  # Persist the new access token + an absolute expiry epoch. The cache holds token
  # material → 0600 perms, never echoed. Write to a per-process temp then
  # atomically rename so a concurrent session never reads a half-written file.
  _new_exp_at="$((_now + _new_expires_in))"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  _umask="$(umask)"
  umask 077
  _tmp_cache="${ACCESS_CACHE}.tmp.$$"
  if printf '{"access_token":"%s","expires_at":%s}\n' "$_new_access" "$_new_exp_at" >"$_tmp_cache" 2>/dev/null; then
    mv -f "$_tmp_cache" "$ACCESS_CACHE" 2>/dev/null || rm -f "$_tmp_cache" 2>/dev/null
  else
    rm -f "$_tmp_cache" 2>/dev/null
  fi
  umask "$_umask"
  AUTH_TOKEN="$_new_access"
}

# ── Present the chosen credential to /bearer ──────────────────────────────────
# GET /bearer with AUTH_TOKEN; set HTTP_STATUS + BODY (no exit). We do NOT use
# `curl -f` (which discards the body and status); instead ask curl to append the
# numeric status on its own trailing line so we can branch on it and still
# surface the server's message.
present_bearer() {
  HTTP_STATUS=000
  BODY=""
  _resp="$(
    curl -s --connect-timeout 5 --max-time 10 -w '\n%{http_code}' \
      -H "Authorization: Bearer ${AUTH_TOKEN}" \
      "${TOKENSCOPE_BEARER_ENDPOINT}" 2>/dev/null
  )" || _resp=""
  if [ -n "$_resp" ]; then
    HTTP_STATUS="$(printf '%s' "$_resp" | tail -n1)"
    BODY="$(printf '%s' "$_resp" | sed '$d')"
  fi
}

if [ -z "${TOKENSCOPE_BEARER_ENDPOINT:-}" ]; then
  echo "TokenScope: emission auth NOT CONFIGURED — TOKENSCOPE_BEARER_ENDPOINT not set (connect + provision emit via the tokenscope-setup MCP prompt first). Telemetry will not emit." >&2
  write_sentinel 0 "TOKENSCOPE_BEARER_ENDPOINT not set"
  exit 1
fi

# ── Require OAuth auth ─────────────────────────────────────────────────────────
# OAuth is the ONLY emission credential. If it is not fully configured, fail loud
# (the legacy per-instance session token has been removed entirely).
if [ -z "${TOKENSCOPE_OAUTH_REFRESH_TOKEN:-}" ] \
  || [ -z "${TOKENSCOPE_OAUTH_TOKEN_ENDPOINT:-}" ] \
  || [ -z "${TOKENSCOPE_OAUTH_CLIENT_ID:-}" ]; then
  echo "TokenScope: emission auth NOT CONFIGURED — no OAuth credential (TOKENSCOPE_OAUTH_REFRESH_TOKEN/_TOKEN_ENDPOINT/_CLIENT_ID); run the tokenscope-setup MCP prompt. Telemetry will not emit." >&2
  write_sentinel 0 "no OAuth credential configured"
  exit 1
fi

# AUTH_TOKEN is the credential presented to /bearer. USED_CACHE records whether we
# presented a CACHED OAuth token (vs a freshly-refreshed one) — only a cached
# token's 401 is worth a refresh-and-retry; a fresh token's 401 is genuine.
AUTH_TOKEN=""
USED_CACHE=0

# ── Use a valid cached access token, else refresh ───────────────────────────────
CACHED_TOKEN=""
CACHED_EXP=0
if [ -f "$ACCESS_CACHE" ]; then
  _cache="$(cat "$ACCESS_CACHE" 2>/dev/null || echo '')"
  CACHED_TOKEN="$(json_str "$_cache" access_token)"
  CACHED_EXP="$(json_num "$_cache" expires_at)"
  [ -z "$CACHED_EXP" ] && CACHED_EXP=0
fi

NOW="$(now_epoch)"
if [ -n "$CACHED_TOKEN" ] && [ "$CACHED_EXP" -gt "$((NOW + EXPIRY_SKEW))" ] 2>/dev/null; then
  AUTH_TOKEN="$CACHED_TOKEN"
  USED_CACHE=1
else
  oauth_refresh # sets AUTH_TOKEN, or exits 1 on a failed refresh
fi

present_bearer

# SELF-HEAL: a CACHED OAuth token rejected by /bearer was likely superseded
# (concurrent refresh / out-of-band / deploy). Force ONE fresh refresh + retry.
if [ "$USED_CACHE" = 1 ] && { [ "$HTTP_STATUS" = "401" ] || [ "$HTTP_STATUS" = "403" ]; }; then
  rm -f "$ACCESS_CACHE" 2>/dev/null
  oauth_refresh # forces a fresh token (or exits 1 if the credential is truly dead)
  present_bearer
fi

case "$HTTP_STATUS" in
  200)
    clear_sentinel
    printf '%s\n' "$BODY"
    exit 0
    ;;
  401 | 403)
    # Reached here means a FRESH token (just refreshed, or the retry above) was
    # still rejected — the credential is revoked or the instance ended. Drop the
    # cache so the next run forces a full refresh; surface the server's message.
    rm -f "$ACCESS_CACHE" 2>/dev/null
    SERVER_MSG="$(json_str "$BODY" statusMessage)"
    [ -z "$SERVER_MSG" ] && SERVER_MSG="$(json_str "$BODY" detail)"
    [ -z "$SERVER_MSG" ] && SERVER_MSG="Session expired or revoked"
    echo "TokenScope: emission auth FAILED (HTTP ${HTTP_STATUS} ${SERVER_MSG}) — telemetry is being DROPPED. Run /tokenscope:status or re-provision emit via the tokenscope-setup MCP prompt." >&2
    write_sentinel "$HTTP_STATUS" "$SERVER_MSG"
    exit 1
    ;;
  000)
    echo "TokenScope: emission auth FAILED (could not reach ${TOKENSCOPE_BEARER_ENDPOINT}) — telemetry may be DROPPED. Check connectivity; run /tokenscope:status." >&2
    write_sentinel 0 "network error reaching bearer endpoint"
    exit 1
    ;;
  *)
    echo "TokenScope: emission auth FAILED (HTTP ${HTTP_STATUS}) — telemetry may be DROPPED. Run /tokenscope:status or re-provision emit via the tokenscope-setup MCP prompt." >&2
    write_sentinel "$HTTP_STATUS" "bearer endpoint returned HTTP ${HTTP_STATUS}"
    exit 1
    ;;
esac
