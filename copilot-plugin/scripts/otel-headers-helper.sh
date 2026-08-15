#!/bin/sh
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
# Args (NOT env — see THE STATE DIR below). Both must be ABSOLUTE paths; an
# unknown argument is refused outright rather than ignored:
#   --state-dir <path>           — where the sentinel + token cache live
#                                  (default: ~/.tokenscope under the PASSWD home)
#   --tool-dir <path>            — prepend a directory to PATH ahead of the
#                                  trusted ones (test stubs / local debugging)
set -eu

# POSIX sh has no `pipefail`; we avoid pipes in the failure path instead.

# ── A TRUSTED PATH, BEFORE THE FIRST EXTERNAL COMMAND ────────────────────────
#
# Everything below runs `curl`, `id`, `date`, `sed`, `awk`, `mkdir`, `rm` by NAME,
# and this script is handed TOKENSCOPE_OAUTH_REFRESH_TOKEN — the durable emit
# credential. `PATH` is repo-settable and reaches this process (Claude Code
# invokes this script itself with the merged settings environment; see THE STATE
# DIR below and docs/security-sprint/repo-env-inheritance-capture.md), so without
# this line a repository chooses the `curl` that the refresh token is handed to.
#
# PREPEND rather than replace. Replacing outright would break hosts whose `curl`
# lives somewhere else entirely (Homebrew on Apple silicon, Nix, a locked-down
# image with tools under /opt) and the failure mode there is silent zero
# telemetry, which is worse than the threat. Prepending means a system tool wins
# wherever one exists, and an unusual host still resolves through the inherited
# PATH. Also the reason the shebang is `#!/bin/sh` and not `/usr/bin/env sh`:
# `env` would resolve the INTERPRETER through the untrusted PATH, before this
# line ever runs.
#
# NOT a complete sandbox — see the residual in
# docs/security-sprint/owner-decisions.md §0. `curl` still inherits proxy and CA
# variables (`http_proxy`, `CURL_CA_BUNDLE`, `SSL_CERT_FILE`) from the same
# untrusted environment; `-q` on every invocation neutralises `.curlrc`/`CURL_HOME`
# but those variables are legitimate on corporate hosts and cannot be dropped here
# without breaking them.
# `--tool-dir <abs path>` prepends one more directory AHEAD of the trusted ones.
# It exists for the test suite, which drives this script against stub `curl` /
# `id` binaries, and for local debugging. It is safe for the same reason
# `--state-dir` is: argv is the one channel the settings merge cannot contribute
# to, so reaching it already requires executing code on this machine. Parsed
# below with the other arguments; applied here as an ordinary PATH prefix.
TRUSTED_PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
PATH="${TRUSTED_PATH}:$PATH"
export PATH

# ── THE STATE DIR: an ARGUMENT, never an environment variable ────────────────
#
# This directory is where the freshly minted emit ACCESS TOKEN is cached
# (`oauth-access.json`) and where a stored durable credential is read back from
# (`config.json`). It decides who receives a secret, so its provenance has to be
# something a repository cannot write.
#
# `TOKENSCOPE_STATE_DIR` USED TO CHOOSE IT, AND WAS REACHABLE. Claude Code merges
# a repository's `.claude/settings.json` `env` block into the environment, and
# `otelHeadersHelper` is invoked BY CLAUDE CODE — a sibling process of any hook,
# spawned every ~29 minutes to mint the bearer. Captured against Claude Code
# 2.1.232 (docs/security-sprint/repo-env-inheritance-capture.md): a repo shipping
# `{"env":{"TOKENSCOPE_STATE_DIR":"<repo>/exfil"}}` got a live access token
# written into its own working tree.
#
# `session-start.mjs`'s `hookStateDir()` CANNOT close that. It repairs the HOOK
# process's own `process.env`; it has no reach into a process Claude Code spawns
# beside it. The capture above was re-run with that fix installed and the token
# still landed in the repo-chosen directory.
#
# So the channel moves to one the merge cannot reach: **argv**. Nothing in a
# settings file contributes arguments to `otelHeadersHelper` — Claude Code
# invokes the bare script — so an argument is authorable only by a caller that
# already executes code on this machine. Our own callers pass the state dir they
# resolved (`plugin-runtime.mjs`'s `runEmitHelper`, `backfill.mjs`,
# `copilot-forwarder.mjs`, `status.mjs`); Claude Code passes nothing and lands on
# the passwd-home default, which is the right answer precisely because its
# environment is the untrusted one.
#
# `$HOME` is excluded for the same reason and by the same capture: it is equally
# repo-settable, and `os.homedir()`/`~` would follow it. `passwd_home` reads the
# passwd database, which no environment variable can move — the sh mirror of
# `real-home.mjs`'s `userInfo().homedir`.
#
# NOT a behaviour toggle: with no argument this resolves to exactly the path the
# JS side's `stateDir()` resolves with no pin set, so an unpinned device is
# byte-identical to before.

# The account's real home, read from the passwd DATABASE rather than $HOME, via
# whichever of the three sources this platform actually keeps accounts in:
# `getent` (Linux), `dscl` (macOS Directory Services), then /etc/passwd. Falls
# back to $HOME — loudly — only when all three yield nothing, which is a genuinely
# unusual host rather than, as an earlier version of this had it, every Mac.
passwd_home() {
  _u="$(id -un 2>/dev/null || printf '')"
  _h=''
  # NO `eval`. This was `eval echo "~$_u"`, relying on tilde expansion to consult
  # passwd. Two problems: `$_u` comes from `id`, which is resolved by NAME (see
  # the trusted PATH above — before that line existed it was outright
  # attacker-selectable), so its output reached `eval` as shell syntax; and `echo`
  # mangles backslashes in some shells, corrupting a home that contains one.
  # `getent` first, then a direct /etc/passwd read, both with `printf`. Neither
  # interprets its input.
  if [ -n "$_u" ]; then
    # Linux/glibc: the passwd database, whatever NSS backend it lives in.
    _h="$(getent passwd "$_u" 2>/dev/null | cut -d: -f6 || printf '')"
    # macOS: NO `getent`, and regular accounts are NOT in /etc/passwd — that file
    # holds only system accounts there, so the awk branch below silently finds
    # nothing and every Mac would fall through to the $HOME fallback this
    # function exists to avoid. Directory Services is the real passwd database on
    # macOS; `dscl` is the supported way to read it and ships with the OS.
    if [ -z "$_h" ]; then
      _h="$(dscl . -read "/Users/$_u" NFSHomeDirectory 2>/dev/null \
            | sed -n 's/^NFSHomeDirectory: //p' | head -n1 || printf '')"
    fi
    # Last structured source: a local passwd file (musl/Alpine, minimal images,
    # and macOS system accounts).
    if [ -z "$_h" ] && [ -r /etc/passwd ]; then
      _h="$(awk -F: -v u="$_u" '$1 == u { print $6; exit }' /etc/passwd 2>/dev/null || printf '')"
    fi
  fi
  case "$_h" in
    '')
      # LAST RESORT, and it re-opens what the anchor exists to close: this branch
      # follows $HOME, so on a box with no passwd entry for the uid (a minimal
      # container) a moved HOME chooses where the token cache lands again. Say so
      # — a silent fallback here is indistinguishable from the anchor working,
      # which is the whole failure class. Exactly what real-home.mjs does in its
      # matching branch, and for the same reason.
      echo "[tokenscope] WARN: no passwd entry for this uid; state dir falls back to \$HOME (leak-susceptible). Pass --state-dir to pin it." >&2
      _h="${HOME:-}"
      ;;
  esac
  echo "$_h"
}

# Parsed BEFORE the default is resolved: `--tool-dir` has to be in effect before
# passwd_home() runs, because that function shells out to `getent`/`awk`/`id`.
STATE_DIR=""
# Parse the ONE accepted argument. An unknown argument is refused rather than
# ignored, the same rule argv-guard.mjs applies to the redeem helpers: a flag
# this script does not implement is argv nobody in the product wrote.
while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir)
      [ $# -ge 2 ] || { echo "otel-headers-helper: --state-dir requires a value" >&2; exit 2; }
      # ABSOLUTE and non-empty. An empty value would make every path below start
      # at `/` (STATE_DIR="" → "/emit-failure.json"); a relative one would place
      # the token cache under whatever cwd this happened to be spawned in — which
      # for a Claude Code hook is the repository; and a leading `-` turns into an
      # option for the `mkdir`/`rm` that follow, despite the quoting. None is a
      # value any caller in this product passes, so refuse rather than normalise.
      case "$2" in
        /*) STATE_DIR="$2" ;;
        *) echo "otel-headers-helper: --state-dir must be a non-empty absolute path" >&2; exit 2 ;;
      esac
      shift 2
      ;;
    --tool-dir)
      [ $# -ge 2 ] || { echo "otel-headers-helper: --tool-dir requires a value" >&2; exit 2; }
      case "$2" in
        /*) PATH="$2:${TRUSTED_PATH}:$PATH"; export PATH ;;
        *) echo "otel-headers-helper: --tool-dir must be a non-empty absolute path" >&2; exit 2 ;;
      esac
      shift 2
      ;;
    *)
      echo "otel-headers-helper: unknown argument" >&2
      exit 2
      ;;
  esac
done
# No --state-dir ⇒ the passwd-home default. Resolved here, after argv, so the
# tools passwd_home() needs are resolved through the PATH argv just set up.
[ -n "$STATE_DIR" ] || STATE_DIR="$(passwd_home)/.tokenscope"
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

# ── endpoint pre-flight (S1 fix 3 — POSIX sh port of endpoint-guard.mjs) ──────
# Reject a non-https / leading-dash / empty endpoint BEFORE it ever reaches
# curl — the same validation plugin-runtime.mjs's assertSafeEndpoint applies
# JS-side, ported here because this script runs under `sh`, never Node.
# Loopback (127.0.0.1/localhost/::1, any port) is exempted from the https
# requirement — a locally-running dev server (TOKENSCOPE_API_BASE=
# http://localhost:3450) legitimately returns its OWN loopback address as
# both the bearer and OAuth token endpoint. On failure: write_sentinel + exit
# 1, the SAME loud-failure pattern every other guard in this script uses —
# never a silent skip. Args: $1 = endpoint value, $2 = label (for the message).
assert_safe_endpoint() {
  _ep="$1"
  _label="$2"
  case "$_ep" in
    '')
      echo "TokenScope: emission auth FAILED (${_label} is empty) — telemetry is being DROPPED." >&2
      write_sentinel 0 "${_label} is empty"
      exit 1
      ;;
    -*)
      echo "TokenScope: emission auth FAILED (${_label} must not start with '-') — telemetry is being DROPPED." >&2
      write_sentinel 0 "${_label} starts with '-'"
      exit 1
      ;;
  esac
  case "$_ep" in
    https://*) return 0 ;;
    http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*) return 0 ;;
    http://localhost|http://localhost:*|http://localhost/*) return 0 ;;
    http://\[::1\]|http://\[::1\]:*|http://\[::1\]/*) return 0 ;;
    *)
      echo "TokenScope: emission auth FAILED (${_label} must be https for an off-box host) — telemetry is being DROPPED." >&2
      write_sentinel 0 "${_label} must be https off-box"
      exit 1
      ;;
  esac
}

# The `--proto` value matching whichever scheme just validated, so curl is
# restricted to EXACTLY that protocol (defence against a scheme/URL parser
# differential between this script's `case` matching and curl's own parser —
# `--proto '=https'` for the common off-box case; `'=http'` for a validated
# loopback dev endpoint). Args: $1 = the already-validated endpoint value.
proto_for() {
  case "$1" in
    https://*) printf '=https' ;;
    *) printf '=http' ;;
  esac
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
    printf '%s' "$_tok_form" | curl -q -s --connect-timeout 5 --max-time 10 -w '\n%{http_code}' \
      --proto "$(proto_for "$TOKENSCOPE_OAUTH_TOKEN_ENDPOINT")" \
      -X POST \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data-binary @- \
      --url "${TOKENSCOPE_OAUTH_TOKEN_ENDPOINT}" 2>/dev/null
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

# ── Client version reporting (diagnostic) ─────────────────────────────────────
# Every version-specific incident this project has had ended in "go ask the human
# what version they are on": the 2.1.191 chunked-OTLP regression, the durable
# revert-key wedge, the forwarder self-heal, and most recently a device eight days
# behind on attribution where "does that user need to update?" was unanswerable
# from data. So the mint states what is actually running. This is the RIGHT place
# for it: /bearer is already called every ~29 minutes by a live device, the values
# describe the code that is doing the calling, and it costs two headers.
#
# The server treats these as UNTRUSTED diagnostic hints — never an authorisation
# or costing input — and stores a missing value as NULL ("not reported"), which is
# itself the signal that a device is on a build older than this one. So a value we
# cannot determine is OMITTED, never guessed or defaulted.

# Version of the TokenScope plugin this helper belongs to, read from the manifest
# sitting beside it. Anchored on $0 (the helper is invoked by absolute path,
# pinned into settings.json) so it reports the version of the code that ACTUALLY
# ran, not whatever is nominally installed — the two diverge exactly when a stale
# pinned path is the bug you are hunting.
#
# TWO LAYOUTS, because this script is VENDORED INTO BOTH PLUGINS (the parity gate
# scripts/check-copilot-plugin-sync.mjs keeps the copies identical, so one file
# must be correct in both trees):
#   plugin/scripts/…          → ../.claude-plugin/plugin.json   (Claude plugin)
#   copilot-plugin/scripts/…  → ../plugin.json                  (Copilot plugin)
# Probed in that order, first hit wins. Getting this wrong is invisible rather
# than loud: a manifest we cannot find yields NULL, which is indistinguishable
# from a device that has not upgraded — so the whole Copilot fleet would look
# stale forever and nobody would see an error.
detect_plugin_version() {
  _pv_dir="$(dirname "$0" 2>/dev/null || echo .)"
  for _pv_file in "${_pv_dir}/../.claude-plugin/plugin.json" "${_pv_dir}/../plugin.json"; do
    if [ -f "$_pv_file" ]; then
      _pv_body="$(cat "$_pv_file" 2>/dev/null || echo '')"
      PLUGIN_VERSION="$(json_str "$_pv_body" version)"
      [ -n "$PLUGIN_VERSION" ] && return 0
    fi
  done
  return 0
}

# Version of the Claude Code CLI that launched this session. Same two signals and
# same precedence as otlp-shim-policy.mjs::detectCliVersion.
#
# HONESTY NOTE — what is and is not verified here. Those signals are proven in the
# HOOK environment (the shim policy reads them there to decide whether to run the
# forwarder, and that decision has been correct in production). What is NOT
# verified is whether Claude Code exports them into the environment of the
# otelHeadersHelper subprocess it spawns for the ~29-minute refresh; that
# inheritance has not been captured, and this project's standing rule is not to
# infer emission behaviour. It is designed to be safe either way: if neither
# variable is present the header is simply OMITTED, the server stores NULL, and
# the plugin version — read from disk, not from the environment — still lands. So
# the worst case is a partially-reported device, never a wrong version and never a
# failed mint. The SessionStart hook's own invocation of this helper passes its
# process env through, so that path reports the CLI version regardless.
detect_cli_version() {
  # .../versions/2.1.212/... — backslashes are NORMALISED to forward slashes
  # first, so the pattern needs only one separator. The obvious `versions[/\]`
  # bracket form does work in the sed implementations tested here, but whether a
  # backslash inside a bracket expression is literal or an escape is exactly the
  # kind of thing that varies between GNU sed, BSD sed and busybox — and this
  # script runs on developer machines, not on a runner we control. `tr` removes
  # the question instead of betting on it. A non-matching value prints nothing, so
  # no `case` guard is needed — one code path, not two.
  CLI_VERSION="$(printf '%s' "${CLAUDE_CODE_EXECPATH:-}" | tr '\\' '/' | sed -n 's|.*versions/\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*|\1|p')"
  if [ -z "$CLI_VERSION" ]; then
    # e.g. AI_AGENT=claude-code_2-1-211_agent
    CLI_VERSION="$(printf '%s' "${AI_AGENT:-}" | sed -n 's|.*claude-code_\([0-9][0-9]*\)-\([0-9][0-9]*\)-\([0-9][0-9]*\).*|\1.\2.\3|p')"
  fi
}

# Drop anything that is not plausibly a version string. The value is interpolated
# into a curl argument and then into an HTTP header, so a stray space, quote, or
# newline is a correctness problem here and a rendering problem in the operator's
# console. The server sanitises independently (defence in depth) — this side
# guarantees we never SEND junk, that side guarantees we never STORE junk.
safe_version() {
  printf '%s' "$1" | tr -d '\000-\037' | sed -n 's|^\([A-Za-z0-9][A-Za-z0-9._+-]\{0,39\}\)$|\1|p'
}

PLUGIN_VERSION=""
CLI_VERSION=""
detect_plugin_version
detect_cli_version
PLUGIN_VERSION="$(safe_version "$PLUGIN_VERSION")"
CLI_VERSION="$(safe_version "$CLI_VERSION")"

# Build the curl header arguments once (present_bearer runs twice on the self-heal
# path). Uses curl's `-H Name:value` form, which word-splits into exactly TWO
# tokens per header (`-H` and `Name:value`) — that split is the intent, and the
# colon form keeps the value welded to its name. safe_version has already
# constrained both values to [A-Za-z0-9._+-], so neither token can carry further
# whitespace or a glob character, and the deliberate UNQUOTED expansion of
# $VERSION_HEADER_ARGS below therefore cannot split or glob into anything
# unintended. An undetermined value contributes no argument at all — the server
# then records NULL, which is the honest reading.
VERSION_HEADER_ARGS=""
if [ -n "$PLUGIN_VERSION" ]; then
  VERSION_HEADER_ARGS="-H X-TokenScope-Plugin-Version:${PLUGIN_VERSION}"
fi
if [ -n "$CLI_VERSION" ]; then
  VERSION_HEADER_ARGS="${VERSION_HEADER_ARGS} -H X-TokenScope-Client-Version:${CLI_VERSION}"
fi

# ── Present the chosen credential to /bearer ──────────────────────────────────
# GET /bearer with AUTH_TOKEN; set HTTP_STATUS + BODY (no exit). We do NOT use
# `curl -f` (which discards the body and status); instead ask curl to append the
# numeric status on its own trailing line so we can branch on it and still
# surface the server's message.
present_bearer() {
  HTTP_STATUS=000
  BODY=""
  _resp="$(
    # shellcheck disable=SC2086 -- word-splitting $VERSION_HEADER_ARGS is intended;
    # its tokens are charset-constrained by safe_version above.
    curl -q -s --connect-timeout 5 --max-time 10 -w '\n%{http_code}' \
      --proto "$(proto_for "$TOKENSCOPE_BEARER_ENDPOINT")" \
      -H "Authorization: Bearer ${AUTH_TOKEN}" \
      $VERSION_HEADER_ARGS \
      --url "${TOKENSCOPE_BEARER_ENDPOINT}" 2>/dev/null
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
assert_safe_endpoint "$TOKENSCOPE_BEARER_ENDPOINT" "TOKENSCOPE_BEARER_ENDPOINT"

# ── OAuth refresh token: env, else the device credential store fallback ──────
# Claude's repo-local tag no longer carries TOKENSCOPE_OAUTH_REFRESH_TOKEN (S1
# fix 4 — a hostile repo must not be able to exfiltrate the durable refresh
# credential merely by sitting in the working tree: `tag-repo.mjs` now strips
# it from the repo-local env copy it writes). When the env omits it, fall back
# to the device's OWN 0700 global state dir store (${STATE_DIR}/config.json →
# .oauth_refresh_token), which claude-redeem.mjs now writes on THIS lane and
# copilot-redeem.mjs already writes+reads on the Copilot lane
# (copilot-plugin/scripts/status.mjs) — ONE shared store, keyed by the SAME
# field name, so a tagged repo's session still finds the refresh token (from
# the device store, never from the repo) and removing it from the repo tag
# cannot brick emission.
if [ -z "${TOKENSCOPE_OAUTH_REFRESH_TOKEN:-}" ] && [ -f "${STATE_DIR}/config.json" ]; then
  _cfg="$(cat "${STATE_DIR}/config.json" 2>/dev/null || echo '')"
  _cfg_refresh="$(json_str "$_cfg" oauth_refresh_token)"
  if [ -n "$_cfg_refresh" ]; then
    TOKENSCOPE_OAUTH_REFRESH_TOKEN="$_cfg_refresh"
  fi
fi

# ── Require OAuth auth ─────────────────────────────────────────────────────────
# OAuth is the ONLY emission credential. If it is not fully configured, fail loud
# (the legacy per-instance session token has been removed entirely).
if [ -z "${TOKENSCOPE_OAUTH_REFRESH_TOKEN:-}" ] \
  || [ -z "${TOKENSCOPE_OAUTH_TOKEN_ENDPOINT:-}" ] \
  || [ -z "${TOKENSCOPE_OAUTH_CLIENT_ID:-}" ]; then
  echo "TokenScope: emission auth NOT CONFIGURED — no OAuth credential (TOKENSCOPE_OAUTH_REFRESH_TOKEN/_TOKEN_ENDPOINT/_CLIENT_ID, and none found in ${STATE_DIR}/config.json); run the tokenscope-setup MCP prompt. Telemetry will not emit." >&2
  write_sentinel 0 "no OAuth credential configured"
  exit 1
fi
assert_safe_endpoint "$TOKENSCOPE_OAUTH_TOKEN_ENDPOINT" "TOKENSCOPE_OAUTH_TOKEN_ENDPOINT"

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
