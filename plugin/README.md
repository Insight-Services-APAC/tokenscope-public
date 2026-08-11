# TokenScope Claude Code plugin

Attribute Claude Code session tokens to TokenScope projects. The model is
**connect once (OAuth), then tag each repo**:

- **`tokenscope-setup`** (MCP prompt) — **run once per device.** Authenticates you
  (one browser OAuth consent) AND provisions emitting: it writes the OTel plumbing
  + your device's durable emit credential into the **global** `~/.claude/settings.json`.
  The durable emit secret is redeemed by a local helper, never through the chat.
  After this, every Claude CLI on the device emits to TokenScope (untagged until a
  repo is tagged).
- **`project`** (MCP prompt) — **run per repo.** Lists the projects you can bill,
  you pick one; it writes the repo's committed `.tokenscope` (computing
  `project.code_hash` locally) and tags this checkout. No need to know the exact slug.
- **`tag`** (MCP prompt) — tag a specific session to a budget and/or activity
  (lists your budgets + activity suggestions, then records it).
- **`usage`** (MCP prompt) / **`my_usage`** (MCP tool) — your month-to-date spend
  split per budget, plus unallocated + tagged spend.
- `/tokenscope:setup` — **run this first** on a new device/session: connect +
  provision emitting (one OAuth consent; the durable credential is redeemed
  locally). A first-class command mirroring the `tokenscope-setup` MCP prompt.
- `/tokenscope:status` — "is my Claude emitting to TokenScope, and is the MCP
  connected?".
- `/tokenscope:statusline [on|off]` — toggle the status line (see below).
- `/tokenscope:backfill` — re-emit recent local usage that may have been dropped.

The MCP prompts (`tokenscope-setup`, `project`, `tag`, `usage`) surface in Claude
Code's slash menu tagged **(MCP)** — e.g. `/plugin:tokenscope:tokenscope:tokenscope-setup`.
They are the reusable spine (every MCP client supports tools/prompts); the local
`/tokenscope:*` commands above are the Claude-specific surface (status line, emit
probe, backfill).

Tagging is also **zero-touch**: a `SessionStart` hook ensures the repo-local
`project.code_hash` is set whenever you start `claude` in a repo that has a
committed `.tokenscope` and the device is connected (see *Zero-touch tagging*).

## Install (dogfood)

The marketplace manifest lives at the **repo root** (`.claude-plugin/marketplace.json`),
so the GitHub shorthand resolves it. The simplest path — **works inside any Claude
Code session, no `claude` CLI on PATH required** — is the slash form. Run the
two commands **individually** (paste one, run it, then the next — Claude Code
treats a multi-line paste as a single command):

```
/plugin marketplace add Insight-Services-APAC/tokenscope-public
/plugin install tokenscope@tokenscope
```

When prompted for an install scope, choose **"Install for you (user scope)"** —
the plugin is a personal tool that emits across all your repos. Don't use
*project* scope (commits plugin config into the repo + force-installs it on
collaborators) or *local* scope (this repo only). The committed `.tokenscope`
file is what travels per-repo, not the plugin.

The add is an authenticated git clone, so it works for this **private** repo (a
raw `marketplace.json` URL would not auth).

**Lighter alternative (needs the standalone `claude` CLI on PATH).** The terminal
form supports `--sparse`, a git sparse-checkout of just `.claude-plugin` + `plugin`
so the whole monorepo isn't checked out:

```
claude plugin marketplace add Insight-Services-APAC/tokenscope-public --sparse .claude-plugin plugin
claude plugin install tokenscope@tokenscope
```

From a local checkout you can instead `claude plugin marketplace add .`.

**[VERIFY at install]** the exact verbs/flags against the live docs
(`code.claude.com/docs/en/plugin-marketplaces`).

## Configure

| Var | Default | Purpose |
|---|---|---|
| `TOKENSCOPE_API_BASE` | baked default in `scripts/api-base.mjs` (the GBS Dev host `https://tokenscope.example.com`) | **Override only.** The API base is part of the plugin — the marketplace ships it per-deployment. Set this for local dev (`http://localhost:3450`) or to point at another instance (e.g. the sandbox host). `plugin/.mcp.json` reads the same base for the MCP server. The OTLP ingestion endpoint + emit credential are not baked here — the chosen deployment's server returns them at provision time. |

Tagging makes **no server call** at write time and needs no env var — the
`project` prompt resolves the code from your memberships and hashes it locally.

## 1. Connect + provision emitting (once)

After install, the plugin registers the TokenScope **MCP server**. Authenticate it,
then run the setup prompt:

1. **`/mcp`** → select `tokenscope` → it opens a browser **OAuth consent**. Approve
   the read + tag scopes. (Copy the callback URL back into Claude Code if the
   loopback redirect can't reach you — the consent page shows a Copy button.)
2. Run the **`tokenscope-setup`** MCP prompt. It provisions emitting: `provision_emit`
   returns a short-TTL handoff code + a ready-to-run `redeem_command` that invokes
   the bundled **`claude-redeem.mjs`** helper (Copilot's analogue is `copilot-redeem.mjs`).
   The agent runs that command, which redeems the handoff **locally** (process→server,
   never through the chat) for the durable emit credential and writes it into the
   **global** `~/.claude/settings.json` (mode 0600, atomic temp+rename), merging in:
   - `otelHeadersHelper` — absolute path to `scripts/otel-headers-helper.sh`. The
     Azure Monitor Bearer can ONLY be configured as a helper via this settings key.
     Claude runs the helper at startup and every ~29 min; it mints a short-lived
     OAuth `tokenscope.emit` access token (refresh-token grant) and presents THAT to
     `TOKENSCOPE_BEARER_ENDPOINT` to mint a fresh Azure token. The bearer is never a
     static header.

     Since **0.1.27** that same request also states what the device is running:
     `X-TokenScope-Plugin-Version` (read from the `plugin.json` beside the helper,
     so it is the version that actually ran) and `X-TokenScope-Client-Version`
     (the CLI version, from `CLAUDE_CODE_EXECPATH` / `AI_AGENT`). The server
     records both on `instance_attestation` as **client-asserted diagnostic
     hints** — never an authorisation or costing input — so an operator can answer
     "does this device need to update?" from data instead of asking the human. A
     value that cannot be determined is **omitted**, not guessed: the resulting
     NULL means "running a build older than the one that reports", which is the
     signal you want during a rollout. Reporting is never load-bearing — if it
     fails for any reason the mint still succeeds.
   - `env` — `CLAUDE_CODE_ENABLE_TELEMETRY=1`, logs-only OTLP config
     (`OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=none`,
     `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/protobuf`),
     `TOKENSCOPE_BEARER_ENDPOINT` + the durable OAuth emit credential
     (`TOKENSCOPE_OAUTH_REFRESH_TOKEN` / `…_TOKEN_ENDPOINT` / `…_CLIENT_ID`), and
     `OTEL_RESOURCE_ATTRIBUTES = tokenscope.instance_id=<DEVICE_SID>,tool=claude-code`
     (note: **no** `project.code_hash` — that's per-repo).

Restart `claude` to begin emitting. Until a repo is tagged, its sessions emit
**untagged** and surface in the untagged-spend worklist.

## 2. Tag a repo (per repo)

Run the **`project`** MCP prompt in the repo. It lists the projects you can bill,
you pick one, and it:

- writes a committable `./.tokenscope` (`project.code: <code>`, preserving any
  existing fields) so the tag travels with the repo, then
- writes the **repo-local** `./.claude/settings.local.json` (mode 0600): a FULL
  copy of the device's current global `env`, with `OTEL_RESOURCE_ATTRIBUTES`
  overridden to
  `tokenscope.instance_id=<DEVICE_SID>,project.code_hash=<sha256(code)>,tool=claude-code`.
  This is mandatory, not a leak (ADR-0006 §2): Claude Code applies the
  highest-precedence `env` block by **replacement, not key-merge**, so a
  repo-local block carrying only the resource attrs would drop the
  endpoint/bearer. The durable OAuth **refresh token** specifically is excluded
  from the copy — the one credential a hostile repo could otherwise exfiltrate
  merely by being cloned and opened — and `otel-headers-helper.sh` falls back to
  the device's own state-dir credential store for it.

The device session id + helper + OTLP config are reused from the global config,
copied wholesale into the repo file on **every** `claude` launch in that repo —
not merged by Claude, restated by us each time (ADR-0006's self-heal), which is
what lets a plugin upgrade or re-enrol reach every tagged repo automatically.
Commit the `.tokenscope`; teammates who clone it just run the `project` prompt
with no project (or let the SessionStart hook auto-apply it). Restart `claude`
in the repo — OTel resource attrs are read at startup, so the **next** session
is tagged.

The project name/code is not emitted; the hash is a stable identifier, not a
secret. (The full repo-local copy above — minus the refresh token — still sits
at rest in the tagged repo's `settings.local.json`; that residual is accepted
and documented in ADR-0006 §Risk accepted.)

## `.tokenscope` file

Commit this at the repo root so every developer on the project gets the same
attribution:

```yaml
project:
  code: "6010011856/450127097"
  id: "perpetual-services-pty-ltd-pwm-wp1-azure-landing-zone"
  name: "Perpetual Services PTY Ltd-PWM WP1 - Azure Landing Zone"

# Optional context — informational, not used for tagging.
client: "Perpetual"
practice: "Modern Platforms & Operations"
engagement_type: "Fixed Price"
pm: "Prabho Nallanathan"
```

The `project` prompt + the SessionStart hook use `project.code` (the canonical
code) to compute the hash. `id` / `name` are informational.

## Zero-touch tagging (SessionStart hook)

The plugin registers a `SessionStart` hook (`hooks/session-start.mjs`, wired via
`hooks/hooks.json`). On every session start it checks: is the device connected,
and does the cwd's repo have a committed `.tokenscope` with a `project.code`? If
so, it ensures `./.claude/settings.local.json` carries the matching
`project.code_hash`.

**Semantics:** OTel resource attributes are frozen at process startup, so the
hook cannot re-tag the *running* session — it writes the repo-local settings so
the **next** launch is tagged. The first-ever launch in a fresh repo therefore
emits untagged once (surfaces in the untagged-spend worklist); every subsequent
launch is tagged. Run the `project` prompt + relaunch to tag immediately. The
hook fails **open** — any error (not connected, no `.tokenscope`, parse failure)
exits silently and never breaks your session.

## Status line

`/tokenscope:statusline on` installs a status line (non-clobber — a custom status
line is preserved); `off` removes it. It shows emission **health** + MCP-connection
state + the current **session id** every refresh:

- `TokenScope ✓ #65d2c64f` — emitting **and** the MCP is authenticated.
- `TokenScope ⚠ emit-only #65d2c64f` — emitting, but the MCP is **not** connected
  (telemetry flows, but you can't query — reconnect via `/mcp`).
- `TokenScope ✗ not emitting` — the emit credential is failing (re-provision via
  `tokenscope-setup`).

The `#id` matches the dashboard's "Conversation" column, so you can tell which row
is the session you're in. `/tokenscope:status` reports the same verdict in detail;
for your spend breakdown use the `usage` prompt / `my_usage` tool / web dashboard.

## MCP server (the cross-client backbone)

The plugin registers a **remote MCP server** (`plugin/.mcp.json`) — a
streamable-HTTP server at the deployed base + `/api/v1/mcp`, authenticated by
OAuth 2.1 (no token to paste; the browser consent runs on first connect). It
points at the same deployment as the rest of the plugin (`scripts/api-base.mjs`),
overridable for local dev via `TOKENSCOPE_API_BASE`.

Over MCP the server exposes read tools (`list_my_projects`, `list_activity_types`,
`my_usage`, `resolve_repo_project`) + a tag tool (`tag_session`), and **prompts**
(`tokenscope-setup`, `tag`, `project`, `usage`) that orchestrate them. This is the
reusable spine — every MCP client supports tools/prompts; the device-local
`/tokenscope:*` scripts (status line, emit probe, backfill) remain the
Claude-specific surface.

## What this plugin does NOT do

- Block Claude — TokenScope never enforces. Over-budget yields an off-channel
  notification (Teams / email), not a hard stop.
- Send your project name to any AI coach — the project name/code is not
  emitted; the hash is a stable identifier, not a secret.
- The durable OAuth emit **refresh token** lives in `~/.claude/settings.json` on
  your machine (never commit it); the server stores only its HMAC. It auto-refreshes
  short-lived access tokens — there is no legacy session token. It is deliberately
  **excluded** from every per-repo `settings.local.json` copy (see "Tag a repo"
  above) — a tagged repo's session mints its bearer from the device's own
  state-dir credential store instead, so a hostile cloned repo cannot walk off
  with it merely by existing on disk.
