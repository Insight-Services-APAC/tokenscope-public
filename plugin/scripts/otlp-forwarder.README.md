# OTLP Content-Length forwarder — DORMANT (re-activatable)

`otlp-forwarder.mjs` is a tiny local HTTP proxy that buffers each OTLP/HTTP logs
export and forwards it to the real Azure Monitor DCE **with a `Content-Length`
header** (instead of `Transfer-Encoding: chunked`).

## Why it exists

Claude Code CLI **2.1.191–2.1.211** regressed its OTLP/HTTP logs export to send
`Transfer-Encoding: chunked` with no `Content-Length`. Azure Monitor DCEs (and
other endpoints that require a length) reject that with **400
`MissingContentLengthHeader`**, so telemetry silently vanished
(anthropics/claude-code#72671, filed 2026-07-01). This forwarder was the
zero-touch workaround: repoint the client's OTLP endpoint at `127.0.0.1:14318`,
which re-sends the body with a length.

## Status: OFF by default, version-aware AUTO (fixed upstream 2026-07-17)

**CLI 2.1.212 fixed it** — the export now carries `Content-Length` (and the
`trace_id`/`span_id`-with-`TRACEPARENT` bug too). Verified with a captured
header (see the re-test below). So the forwarder is **off by default** — direct
emission — and is **not** in the endpoint path on a fixed CLI.

The code is kept (not deleted) and, more importantly, the plugin **auto-enables
it for known-broken CLI versions**. #72671 was open and broken for two weeks; a
re-regression is plausible, so the shim re-arms itself with no user action for
any CLI version in a broken range — and turns itself back off on a fixed one.

## The policy: `plugin/scripts/otlp-shim-policy.mjs`

The single source of truth is `resolveShim()`. It reads the version of the CLI
that launched the session from the env Claude sets at spawn
(`CLAUDE_CODE_EXECPATH=.../versions/X.Y.Z`, else `AI_AGENT=claude-code_X-Y-Z…`
— never spawns `claude`) and consults `OTLP_BROKEN_RANGES`:

```js
export const OTLP_BROKEN_RANGES = [
  { from: [2, 1, 191], to: [2, 1, 212], issue: 'anthropics/claude-code#72671' },
]
```

**To re-arm the shim fleet-wide after a future re-regression, append one range
here** (half-open `[from, to)`) — that is the only change needed. Re-validate
first with the re-test below, then bump the plugin version to ship it.

| `TOKENSCOPE_OTLP_PROXY` | CLI version | Behaviour |
|---|---|---|
| unset (default) | in a broken range | **AUTO-ON** — endpoint repointed to the forwarder, forwarder spawned, one-line session-start note. |
| unset (default) | fixed / unknown | **OFF** — direct emission. Auto-restores a still-proxied endpoint from the DCE stash. |
| `1` | any | **Forced ON** (a suspected regression not yet in the table). |
| `0` | any | **Forced OFF** (escape hatch). |

## Shared-home hosts (multiple CWs, mixed CLI versions)

Our CWs share one host home dir — and thus one `~/.claude/settings.json`. During
a CLI upgrade the host can briefly run **both** an affected and a fixed CLI. The
forwarder path is correct for a fixed CLI too (it just adds `Content-Length`), so
the safe shared state is "endpoint at the proxy while the forwarder is live." To
avoid a fixed-CLI session ripping the shared endpoint back to the DCE out from
under an affected sibling (which would silently drop that sibling's telemetry),
`selfHealGlobalOtlpEndpoint` **keeps a live proxy endpoint only while the
forwarder is confirmed healthy** — answering `/healthz`, resolving *our* stateDir,
and ready (the same `decideForwarderAction` verdict `spawnOtlpForwarder` uses, so
the two can't drift). If the forwarder is gone (connection refused), **wedged**
(bound but not answering — `hung`), or **stale** (a leaked-HOME instance
answering with a mismatched dir → wrong DCE relay), it reverts to the direct DCE:
none of those serve anyone, and once the fleet is all fixed-CLI nothing respawns
or replaces them, so leaving the endpoint pinned would strand every future
session on a dead/wrong proxy. A broken-CLI sibling that still needs the
forwarder re-spawns it via its own SessionStart (`spawnOtlpForwarder`
kill+respawn). Residual: if the forwarder is momentarily down and a fixed session
reverts to the DCE in that gap, a subsequently-launched affected session reads
the DCE at launch and drops that one session's telemetry until its own
SessionStart repoints (it self-corrects). The window is small and bounded to a
mixed-version host mid-migration.

## Re-validate before trusting a re-arm

Don't rely on a table edit alone — confirm the current CLI is actually broken:
```bash
bash plugin/scripts/retest-72671.sh
```
It reports `FIX #1 (Content-Length…): PASS|FAIL`. A **FAIL** means the CLI is
affected — add its version to a range in `OTLP_BROKEN_RANGES` (or force
`TOKENSCOPE_OTLP_PROXY=1` locally). Confirm the running forwarder with
`curl -s http://127.0.0.1:14318/healthz` (`ready:true`, `dir` ends in your real
`~/.tokenscope`).

Wiring: `plugin/scripts/otlp-shim-policy.mjs` (the decision) →
`plugin/hooks/session-start.mjs` (`spawnOtlpForwarder`,
`selfHealGlobalOtlpEndpoint`, the auto note) + `plugin/scripts/env-builder.mjs`
(`applyOtlpProxyRepoint`, the reversible repoint + DCE stash).

## Reusable elsewhere

`otlp-forwarder.mjs` is self-contained and generic — a "normalise OTLP/HTTP to
Content-Length" proxy. Any OTLP emitter with the same chunked-vs-length problem
(e.g. a Copilot telemetry path) can point at it; it only needs the DCE URL in
`~/.tokenscope/otlp-forward.json` (`dceLogsEndpoint`).

See also: `docs/design/` emission principles, and the project memory note
`cc-72671-shim-status`.
