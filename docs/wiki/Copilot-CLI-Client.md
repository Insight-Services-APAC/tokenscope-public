# Copilot CLI Client

Built spec for **TokenScope maintainers**: how the GitHub Copilot CLI client is
wired — the `copilot-plugin/` package, the file-forwarder, the transcoder, and
the provisioning flow that makes a developer's `copilot` sessions emit attributable
token spend to Azure Monitor. This is the as-built mechanism.

See also: [Architecture](Architecture.md) · [Claude Code Client](Claude-Code-Client.md) ·
[API Reference](API-Reference.md).
Source of truth for the Copilot telemetry shape:
`docs/development/copilot-cli-telemetry-contract.md`.

> **Copilot v1 spend is indicative (tier-2/telemetry-only).** It is priced from
> the emitted AI-credit value (1 credit = $0.01 USD, verified 2026-06-01). An
> **off-PAT, App-mode _metrics_ reconciliation lane now exists** (`users-1-day`
> `ai_credits_used` × $0.01, PR #112 — the preferred posture; see
> `docs/design/github-pat-to-github-app-transition.md`), which cross-checks the
> emitted consumption per (teammate, day). It is **metrics-grade**, not the
> invoiced billing total: **billing-grade reconciliation** against GitHub's
> `ai_credit/usage` figure (gross/discount/net + USD) is still a planned follow-up
> and remains classic-PAT-only (the F2 worker, see `docs/build/copilot-followups.md`).

---

## Why Copilot needs a different host

Claude Code can emit OTLP logs directly to Azure Monitor (the "native OTel"
path). Copilot CLI **cannot**: as of v1, it only supports writing traces to a
local file (`COPILOT_OTEL_FILE_EXPORTER_PATH`) and posting OTLP/HTTP **JSON**
to an endpoint. Azure Monitor OTLP ingest is **protobuf-only** (415 on JSON),
and Azure Monitor has **no traces table** — only logs. A transcode step is
therefore required.

The **file-forwarder** (`copilot-plugin/scripts/copilot-forwarder.mjs`) is the only
v1 host. It is **per project**, not per host: Copilot runs container-per-project, so
each project root gets its own forwarder. All forwarder state — the span file, the
persisted byte-offset, and the singleton PID/heartbeat lock — lives WITH the project
in `<project-root>/.tokenscope.local/` (the daemon's launch cwd, passed by the hook
as `COPILOT_PROJECT_DIR`). Only the device credential stays in HOME
(`~/.tokenscope/config.json`), shared by every project on the host. On start the
forwarder self-heals the project's `.gitignore` so `.tokenscope.local/` is never
committed. It:

1. Tails the JSON-lines file by byte offset. It **never truncates or rotates** the
   file (Copilot holds the handle open mid-session; truncating would corrupt
   concurrent writes) — span-file growth is bounded by the container lifetime.
2. Filters `chat` spans only — excludes `invoke_agent` which carries duplicate
   totals (the double-count guard; see below).
3. Calls `transcodeChatSpans()` (`otlp-logs.mjs`) to produce the standard
   `api_request` OTLP-logs record shape (plus a separate non-billing `usage_signal`
   lane, see below).
4. Encodes to protobuf and forwards to Azure Monitor every ~60 seconds.
5. Mints the bearer via `otel-headers-helper.sh` (refresh + 401 self-heal) using
   credentials from `~/.tokenscope/config.json` only — **no dependency on
   `~/.claude`**.

A **Stop hook** triggers a final flush so the last turn is always captured (the
daemon lives on — it is a container-lifetime singleton shared by every session in the
project). A **SessionStart hook** starts the forwarder as a **heartbeat-guarded
singleton** (per project root — it does not double-spawn) and catch-up-forwards any
spans left behind by a hard-killed prior forwarder in that project.

---

## Double-count guard

Both `chat` and `invoke_agent` spans carry **identical** `gen_ai.usage.*` totals.
Summing both would double the token count. The transcoder filters on
`gen_ai.operation.name === 'chat'` exclusively. This is a **merge-blocker test**
(Slice 2, `tests/unit/plugin/copilot-transcoder.test.ts`).

---

## Attribution identity

| What | Where it comes from | Why |
|------|---------------------|-----|
| `instance_id` (teammate binding) | `~/.tokenscope/config.json` (minted by `provision_emit`) | Unspoofable — written by the local redeem helper, never by the Copilot client itself |
| `claude_session_id` (session grouping) | `gen_ai.conversation.id` span attr | Copilot's own session id; subagents share the parent's id |
| `project.code_hash` (project claim, B′) | Derived **per batch** from the project-root `.tokenscope` (the daemon's cwd), via `resolveRepoProjectCode` + `computeCodeHash` | The forwarder hashes the committed `.tokenscope` in the project root — the SAME shared resolver Claude Code uses, so both hash an identical repo to the same value. The config stamp is **explicitly not read** (a host-wide config hash is the per-HOME footgun the per-project model removes); no `.tokenscope` → untagged |
| `github.org` (+ mirrored `github.repository`) | The project's **git remote** (`remote.origin.url`), with an `invoke_agent` span-attr (`github.copilot.git.repository`) fallback | Stamped for org→enterprise keying (F2). Lowercased org; omitted when neither source yields one (untagged-enterprise is acceptable). Not an identity factor |
| `tool` | always `copilot-cli` (hardcoded by the forwarder) | Fixed — not controllable by the Copilot client |

> **Attribution is split by concern.** `instance_id` (the security invariant) and the
> emit endpoints come from `~/.tokenscope/config.json`, never from process env — that
> config is authoritative for those. The `project.code_hash` is a **different axis**:
> it is derived per batch from the project-root `.tokenscope` (the daemon's cwd), NOT
> from config. The ONLY shell-rc env var is `COPILOT_OTEL_FILE_EXPORTER_PATH` (Copilot's
> file exporter has no config-file activation) — now a **relative** per-project path
> (`.tokenscope.local/copilot-otel.jsonl`) resolved against the launch cwd, not a fixed
> path. That is what lets a plain `copilot` Just Work — even alongside Claude Code —
> with no per-tool OTel env in the shell.

---

## Provisioning flow

```
Developer runs tokenscope-setup skill
         │
         ▼
provision_emit { tool: 'copilot-cli' }   (MCP tool, OAuth-scoped)
         │
         ├─ locates/creates instance_attestation (tool='copilot-cli')
         └─ returns: handoff_code + redeem URL + CopilotBundle
                      │
                      ▼
   node copilot-redeem.mjs <handoff_code>   (runs locally)
         │
         ├─ POST /api/v1/setup/redeem { handoff_code }
         │  ← response: instance_id, bearer_endpoint, oauth_token_endpoint,
         │              logs_endpoint, OAuth emit credential
         │
         ├─ write ~/.tokenscope/config.json   (durable emit credential + endpoints;
         │                                      instance_id/endpoints authoritative — NO project hash)
         └─ write shell-rc env block           (ONLY COPILOT_OTEL_FILE_EXPORTER_PATH — a RELATIVE
                                                per-project path .tokenscope.local/copilot-otel.jsonl;
                                                OTEL_RESOURCE_ATTRIBUTES is NOT exported, see above)
```

Provisioning does **not** write `~/.copilot/config.json` — the SessionStart + Stop
lifecycle hooks ship in the plugin's `copilot-plugin/hooks/hooks.json` (the "B3 fix":
`copilot-redeem.mjs` no longer writes a competing hook config with inconsistent
casing/args).

The `CopilotBundle` returned by `redeem` (see `server/api/v1/setup/redeem.post.ts`)
is the Copilot-specific variant of the `telemetry.*` envelope — it contains the
file-exporter path and forwarder config instead of the Claude OTel plumbing.

---

## Transcoder contract

`transcodeChatSpans(spans, opts)` — with `opts = { instanceId, projectCodeHash }` —
in `otlp-logs.mjs`:

- Accepts both **file-exporter shape** (flat `{key: value}` attributes object) and
  **OTLP wire shape** (`[{key, value: {stringValue|intValue|doubleValue}}]` list).
- Token keys supported: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
  `gen_ai.usage.cache_creation_input_tokens`, `gen_ai.usage.cache_read_input_tokens`
  (also the nested `gen_ai.usage.cache_creation.input_tokens` variant — VS Code).
- `request_id` = span id (stable re-forward dedup key).
- `ts_event` = span `endTime` (not startTime — LLM call ends when the response is
  complete; matches what a direct emitter would emit).
- `github.copilot.nano_aiu` carried as a record attribute for server-side pricing.
- `query_source` stamped on every token record (`main` for an interactive turn —
  `github.copilot.initiator == 'user'` or absent — else `auto`), the SAME wire attr
  Claude emits so the server-side aux-overhead detector fires for Copilot too.

### Behavioural signal lane (`usage_signal`) — NON-billing

`transcodeSignalSpans(spans, { instanceId })` runs alongside the token path and emits
a **separate** record shape with `event.name = 'usage_signal'` and **no token
attributes** — so the billing reader (`api_request` + tokens>0) never sees it and
this lane carries zero billing risk. Signal → source span is 1:1 (no double-count):
`sig.tool_count` + `sig.ctx_pct` come from the `chat` span; `sig.mcp_count` +
`sig.turn_count` from the `invoke_agent` span (dropped by the token path's
double-count guard, but the turn-level source of truth for these). `sig.ctx_pct` is a
per-record context-window saturation ratio (a ratio, not USD — client-side derivation
is fine). A span with no signals emits no record.

---

## Server-side pricing (Copilot-only)

The read joiner (`server/workers/azure-monitor-reader.ts`) detects `tool='copilot-cli'`
and bypasses the token rate-card path entirely:

```
cost_usd = (nano_aiu / 1e9) × COPILOT_AI_CREDIT_USD   // COPILOT_AI_CREDIT_USD = 0.01
```

- Priced once on the `input` token-type record; output/cache records get `cost_usd = 0`.
- `rateCardId` / `rateCardVersion` are `NULL` for Copilot rows (migration 0036).
- `fidelityTier = 'tier-2'`, `costBasis = 'telemetry-only'` (indicative until F2).

---

## Plugin package (`copilot-plugin/`)

```
copilot-plugin/
  plugin.json           manifest
  .mcp.json             MCP server → /api/v1/mcp (same as Claude)
  hooks/hooks.json      SessionStart (start forwarder) + Stop (final flush)
  hooks/forwarder-lifecycle.mjs   hook driver → ../scripts/copilot-forwarder.mjs (co-located)
  scripts/copilot-forwarder.mjs   the shipped per-project forwarder (+ otlp-logs.mjs, copilot-redeem.mjs)
  skills/tokenscope-setup/SKILL.md
  skills/project/SKILL.md
  skills/usage/SKILL.md
```

The skills reuse the same MCP tools (`provision_emit`, `my_usage`,
`list_my_projects`, `resolve_repo_project`, `tag_session`) as the Claude Code
prompts. The `tokenscope-setup` skill passes `tool: 'copilot-cli'` to
`provision_emit` and describes the Copilot-specific redeem flow.

---

## Distribution

**Enterprise-managed (Business/Enterprise):** add `.github-private/.github/copilot/settings.json`
(see `.github-private/.github/copilot/settings.json` in this repo for the example)
with `extraKnownMarketplaces` pointing at this repo and `enabledPlugins` referencing
`copilot-plugin/` as the path. The plugin installs automatically on auth.

**Individual/Pro (manual):** run, in a terminal (one at a time):
```bash
copilot plugin marketplace add Insight-Services-APAC/tokenscope-public
copilot plugin install tokenscope-copilot@tokenscope
```
Then run the `tokenscope-setup` skill inside a `copilot` session (type `/` to list
TokenScope's skills).

> There is no `--path` flag. Install a subdirectory plugin either via the
> marketplace form above (preferred) or directly with the `owner/repo:path` form:
> `copilot plugin install Insight-Services-APAC/tokenscope-public:copilot-plugin`
> (direct installs are flagged deprecated in a future Copilot CLI release).

---

## Deferred items (not built in v1)

- **GitHub-billing-API reconciliation** — lifts Copilot spend to tier-1.
- **VS Code Copilot Chat** — same file-forwarder approach, pending client-level
  `COPILOT_OTEL_FILE_EXPORTER_PATH` availability in the VS Code extension.
- **§4a mode-2 per-span project resolution** — multi-repo sessions; v1 ships
  single-repo `.tokenscope` tag only.

> **Not on the roadmap:** a **server-side OTLP-receive route** was once floated as a
> deferred fallback; it is **REJECTED** (2026-06-22). Copilot stays a local-only client
> file-forwarder shim until GitHub ships a native attribution feature — no server-side
> OTLP receiver will be built. See `docs/build/copilot-followups.md` §F1 and ADR-0009.

See `docs/build/copilot-followups.md` for the full list.
