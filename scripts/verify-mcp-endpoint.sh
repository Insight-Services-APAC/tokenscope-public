#!/usr/bin/env bash
#
# verify-mcp-endpoint.sh — prove the MCP endpoint is REACHABLE on a deployed
# target, without a credential.
#
# WHY THIS EXISTS. MCP is a crucial product surface and it shipped dead to dev:
# a Host allowlist that was right on Front-Door-fronted environments and wrong
# on the WAF-fronted one rejected every request with `Invalid Host header`.
# Nothing noticed. deploy.yml's health check cannot help — for dev it exits with
# `UNVERIFIED` because the GitHub runner can neither resolve the internal
# Container App FQDN nor reach the WAF host — and `/healthz` says nothing about
# MCP anyway.
#
# WHAT IT ASSERTS, and why an unauthenticated probe is sufficient. The handler
# validates the Host allowlist BEFORE authenticating, so the status alone
# separates the two failure modes:
#
#   401 + WWW-Authenticate: Bearer resource_metadata=…  → transport reachable,
#        Host accepted, OAuth discovery advertised. This is PASS.
#   403 + "Invalid Host header"                          → the deployment is
#        fronted by a proxy the app does not know it is behind. This is the
#        dev outage, and it is now one curl away.
#   anything else                                        → fail loudly.
#
# It deliberately does NOT mint a token: a check that needs a credential is a
# check nobody runs after a deploy.
#
# Usage:
#   scripts/verify-mcp-endpoint.sh https://tokenscope.example.com
#   scripts/verify-mcp-endpoint.sh            # defaults to $MCP_VERIFY_BASE_URL
#   scripts/verify-mcp-endpoint.sh <backend-fqdn> --expect-origin https://public.host
#
# --expect-origin states which origin OAuth discovery SHOULD advertise. Default
# is the URL you probed; override it only when deliberately probing a backend
# FQDN on a deployment that pins a different public origin.
#
# Run it from a network that can actually reach the target (for dev: inside the
# corporate zone — NOT a stock GitHub runner, which reaches neither dev's
# internal FQDN nor its WAF host).
set -euo pipefail

BASE_URL=""
EXPECT_ORIGIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --expect-origin)
      [ $# -ge 2 ] || { echo "--expect-origin needs a value" >&2; exit 2; }
      EXPECT_ORIGIN="${2%/}"
      shift 2
      ;;
    -*)
      echo "unknown option: $1" >&2
      exit 2
      ;;
    *)
      BASE_URL="$1"
      shift
      ;;
  esac
done
BASE_URL="${BASE_URL:-${MCP_VERIFY_BASE_URL:-}}"
if [ -z "$BASE_URL" ]; then
  echo "usage: $0 <base-url> [--expect-origin <url>]" >&2
  echo "       e.g. $0 https://tokenscope.example.com" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"
MCP_URL="$BASE_URL/api/v1/mcp"

echo "→ probing $MCP_URL (no credential)"

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

# -D - captures headers so the WWW-Authenticate assertion is on the real
# response, not inferred from the status.
# Capture curl's OWN exit status separately from the HTTP status. `|| true`
# alone would let a transport error that still emitted 401 headers (truncated
# body, TLS failure mid-stream, connection reset) reach the PASS branch — a
# verification script that can pass on a broken connection is worse than none.
set +e
HEADERS="$(
  curl -sS -m 30 -o "$BODY_FILE" -D - -w '\n__STATUS__=%{http_code}\n' \
    -X POST "$MCP_URL" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify-mcp-endpoint","version":"1.0.0"}}}' \
    2>/tmp/verify-mcp-curl-err.$$
)"
CURL_RC=$?
set -e
CURL_ERR="$(cat "/tmp/verify-mcp-curl-err.$$" 2>/dev/null || true)"
rm -f "/tmp/verify-mcp-curl-err.$$"

STATUS="$(printf '%s' "$HEADERS" | sed -n 's/^__STATUS__=//p' | tail -1)"
BODY="$(cat "$BODY_FILE")"

if [ "$CURL_RC" -ne 0 ]; then
  echo "✗ FAIL — curl exited $CURL_RC talking to $MCP_URL: ${CURL_ERR:-(no stderr)}" >&2
  echo "         Treating a transport error as a failure, never as a pass." >&2
  exit 1
fi
if [ -z "$STATUS" ] || [ "$STATUS" = "000" ]; then
  echo "✗ FAIL — no HTTP response from $MCP_URL (unreachable from this network)." >&2
  echo "         Run this from a network that can reach the target." >&2
  exit 1
fi

case "$STATUS" in
  401)
    # The RFC 9728 pointer is what actually makes an MCP client start OAuth; a
    # bare 401 without it is indistinguishable from a broken endpoint on the
    # client side. Assert the POINTER'S VALUE, not merely that the parameter
    # appears: a metadata URL on the wrong origin sends the client to OAuth
    # against a host it cannot reach, which is a different outage wearing the
    # same 401.
    # `|| true` is load-bearing: under `set -euo pipefail`, grep finding
    # nothing fails the pipeline and aborts the script mid-assignment, so the
    # "401 with no pointer" diagnostic below was unreachable dead code. It
    # exited 1 with no message at all — the failure mode this script exists to
    # replace. Found by adversarial review, reproduced before fixing.
    POINTER="$(printf '%s' "$HEADERS" \
      | grep -i 'www-authenticate:' \
      | sed -n 's/.*resource_metadata="\([^"]*\)".*/\1/p' | tail -1 || true)"
    if [ -z "$POINTER" ]; then
      echo "✗ FAIL — 401 with no quoted resource_metadata pointer." >&2
      echo "         An MCP client cannot discover the OAuth flow from this response." >&2
      printf '%s\n' "$HEADERS" >&2
      exit 1
    fi
    # Must be an ABSOLUTE http(s) URL at the RFC 9728 well-known path, with no
    # userinfo. A relative, truncated, or credential-bearing value is a pointer
    # no client should follow.
    # Authority = anything that is not a delimiter. Stated as a NEGATED class so
    # the rule reads as the rule ("no slash, whitespace, userinfo, query or
    # fragment between the scheme and the well-known path") instead of as an
    # allowlist of URL punctuation. The allowlist form was correct — verified
    # against IPv6 literals, ports, userinfo and relative URLs — but it contains
    # a literal `[` and a trailing `-`, so it LOOKS unterminated. PR review read
    # it as a bug; a reviewer who "fixes" that would break the check silently,
    # and this script's whole job is to not fail silently.
    if ! printf '%s' "$POINTER" \
      | grep -Eq '^https?://[^/[:space:]@?#]+/\.well-known/oauth-protected-resource$'; then
      echo "✗ FAIL — resource_metadata is not a clean absolute RFC 9728 metadata URL: $POINTER" >&2
      echo "         Expected scheme://authority/.well-known/oauth-protected-resource" >&2
      echo "         with no userinfo, query or fragment." >&2
      exit 1
    fi
    # STRICT BY DEFAULT. A pointer to the wrong origin sends the client to OAuth
    # against a host it may not reach — an MCP outage wearing a 401. So the
    # advertised origin must equal what we probed, UNLESS the caller says
    # otherwise: probing a backend FQDN on a deployment with a pinned public
    # origin correctly advertises the public one, and --expect-origin is how
    # you state that intent rather than have the script guess.
    POINTER_ORIGIN="$(printf '%s' "$POINTER" | sed -E 's|^(https?://[^/]+).*|\1|')"
    WANT_ORIGIN="${EXPECT_ORIGIN:-$BASE_URL}"
    if [ "$POINTER_ORIGIN" != "$WANT_ORIGIN" ]; then
      echo "✗ FAIL — OAuth discovery points at the wrong origin." >&2
      echo "         advertised: $POINTER_ORIGIN" >&2
      echo "         expected:   $WANT_ORIGIN" >&2
      echo "         A client following this OAuths against an origin you did not probe." >&2
      echo "         If that is intended (probing a backend FQDN behind a pinned" >&2
      echo "         APP_PUBLIC_ORIGIN), re-run with --expect-origin $POINTER_ORIGIN" >&2
      exit 1
    fi
    echo "✓ PASS — 401 with an RFC 9728 pointer to $POINTER"
    echo "         Transport reachable, Host accepted, OAuth discovery advertised."
    exit 0
    ;;
  403)
    if printf '%s' "$BODY" | grep -qi 'invalid host header'; then
      echo "✗ FAIL — the deployment's Host is NOT in the MCP allowlist." >&2
      echo "         Body: $BODY" >&2
      echo "         This is the dev-outage signature: a fronting proxy is rewriting" >&2
      echo "         Host to a value the app does not recognise as itself. See" >&2
      echo "         server/utils/public-url.ts selfAddressableHosts()." >&2
      exit 1
    fi
    echo "✗ FAIL — 403 from the MCP endpoint: $BODY" >&2
    exit 1
    ;;
  *)
    echo "✗ FAIL — unexpected status $STATUS from $MCP_URL" >&2
    echo "         Body: $BODY" >&2
    exit 1
    ;;
esac
