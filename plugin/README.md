# TokenScope Claude Code plugin

Tracks your Claude Code token usage in TokenScope, so it is billed to the right
project.

## Quick start

About 5 minutes, once per computer. Do every step in Claude Code.
Windows: nothing else to install. macOS / Linux: needs Node.js.

1. **Install the plugin.** Run these one at a time:

   ```
   /plugin marketplace add <owner>/<repo>
   /plugin install tokenscope@tokenscope
   ```

   When asked, choose **Install for you**.
2. **Point the plugin at your server.** Skip this unless your TokenScope Connect
   dialog shows it. Run `/plugin`, open **tokenscope** → **Configure options**,
   and paste the server URL.
3. **Sign in.** Run `/mcp`, choose **tokenscope**, and approve in your browser.
4. **Turn on tracking.** Run `/tokenscope:setup`.
5. **Restart Claude Code.**
6. **Check it works.** Run `/tokenscope:status`. Green means you're done.

Then, in each repo you bill to a project, run the `project` prompt once and
commit the `.tokenscope` file it writes.

Use the marketplace your TokenScope Connect dialog names for `<owner>/<repo>`.
Stuck? See [Troubleshooting](#troubleshooting). How each step works:
[Install](#install), [Point the plugins at your deployment](#point-the-plugins-at-your-deployment)
and [How setup works](#how-setup-works).

## What the plugin gives you

The model is **connect once, then tag each repo**:

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

## Install

The marketplace manifest lives at the **repo root** (`.claude-plugin/marketplace.json`),
so the GitHub shorthand resolves it. Add the marketplace your TokenScope Connect
dialog names, then set your deployment's URL in the plugin (see
[Point the plugins at your deployment](#point-the-plugins-at-your-deployment)).

The simplest path — **works inside any Claude Code session, no `claude` CLI on
PATH required** — is the slash form. Run the two commands **individually** (paste
one, run it, then the next — Claude Code treats a multi-line paste as a single
command):

```
/plugin marketplace add <owner>/<repo>
/plugin install tokenscope@tokenscope
```

When prompted for an install scope, choose **"Install for you (user scope)"** —
the plugin is a personal tool that emits across all your repos. Don't use
*project* scope (commits plugin config into the repo + force-installs it on
collaborators) or *local* scope (this repo only). The committed `.tokenscope`
file is what travels per-repo, not the plugin.

**Lighter alternative (needs the standalone `claude` CLI on PATH).** The terminal
form supports `--sparse`, a git sparse-checkout of just `.claude-plugin` + `plugin`
so the whole repository isn't checked out:

```
claude plugin marketplace add <owner>/<repo> --sparse .claude-plugin plugin
claude plugin install tokenscope@tokenscope
```

From a local checkout you can instead `claude plugin marketplace add .`.

## Point the plugins at your deployment

**Claude Code: set the plugin's server URL.** No fork is needed. The plugin
declares one option, `server_url`. Copy the server URL from your TokenScope
deployment's Connect dialog, then in Claude Code run `/plugin`, choose
**tokenscope**, then **Configure**, and paste it (just the address, such as
`https://tokenscope.your-company.example`, with no path). Restart Claude Code.

Claude Code stores the value in your user settings (`~/.claude/settings.json`,
under `pluginConfigs["tokenscope@<marketplace>"].options.server_url`) and puts it
into the plugin's MCP server URL (`${user_config.server_url}/api/v1/mcp`). The
plugin's scripts (setup redeem, enrolment) read the same value from the same
file, so both halves talk to one server. An organisation can set it for every
device in managed settings instead (`pluginConfigs` is read from managed and user
settings).

A repository cannot set it. From Claude Code 2.1.207, `pluginConfigs` in a
project's `.claude/settings.json` or `settings.local.json` is ignored, and the
scripts never read the `CLAUDE_PLUGIN_OPTION_SERVER_URL` variable Claude Code
exports to hooks, because a repository's `env` can set that too. Older Claude
Code versions read `pluginConfigs` from project settings, so a cloned repository
could move their MCP server; the scripts still ignore it there.

What the default is depends on the build:

- **This repository's build** defaults `server_url` to the maintainers' Dev
  deployment, so an install that never configures it keeps working.
- **The public build** has no default. Until you set it, `claude mcp list` shows
  *"URL is unset or invalid — open /plugin manage and configure"* and the setup
  helpers stop with *"No TokenScope server is configured"*.

If you run Claude Code with a custom `CLAUDE_CONFIG_DIR`, the scripts do not see
the value (they read the account's own `~/.claude/settings.json`, because that
variable can be set by a repository). Register the server instead:
`claude mcp add --transport http --scope user tokenscope https://<your-host>/api/v1/mcp`.

**Copilot CLI: register the server.** Copilot has no plugin options. Run the
`copilot mcp add` command your Connect dialog shows:

```
copilot mcp add --transport http tokenscope https://<your-host>/api/v1/mcp
```

The Copilot plugin's scripts discover that registration and use its host.

**Changing the packaged default (maintainers).** The packaged host lives in
`plugin/.claude-plugin/plugin.json` (`userConfig.server_url.default`),
`plugin/scripts/api-base.mjs` (`DEFAULT_API_BASE`), `copilot-plugin/.mcp.json`,
`copilot-plugin/scripts/enroll.mjs` (`DEFAULT_API_BASE`) and `shared/connect.ts`
(`CLAUDE_PLUGIN_DEFAULT_ORIGIN`, `COPILOT_PLUGIN_BUNDLED_ORIGIN`).
`npm run check:copilot-plugin-sync` fails when they disagree (the three Claude
defaults may all be empty, which is the public build),
or when `plugin/.mcp.json` is anything but the `server_url` template. Bump both
plugin versions with the change: an installed plugin is replaced only when its
version increases.

## Configure

| Var | Default | Purpose |
|---|---|---|
| `TOKENSCOPE_API_BASE` | unset | **Local development only.** Honoured only for a loopback value (`http://localhost:3450`); any other value is ignored, because a repository can set this variable. It does not move the MCP server. For a local server, set the plugin's `server_url` to `http://localhost:3450` instead (see [Point the plugins at your deployment](#point-the-plugins-at-your-deployment)); that moves both the MCP server and the scripts. |

Tagging makes **no server call** at write time and needs no env var — the
`project` prompt resolves the code from your memberships and hashes it locally.

## How setup works

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
   **global** `~/.claude/settings.json` (atomic temp+rename; mode 0600 on POSIX,
   the profile's own ACL on Windows), merging in:
   - `otelHeadersHelper` — the command that runs the headers helper for the OS:
     `scripts/otel-headers-helper.sh` on POSIX, `scripts/otel-headers-helper.ps1`
     under an absolute `powershell.exe` on Windows (ADR-0015). The
     Azure Monitor Bearer can ONLY be configured as a helper via this settings key.
     Claude runs the helper at startup and every ~29 min; it mints a short-lived
     OAuth `tokenscope.emit` access token (refresh-token grant) and presents THAT to
     `TOKENSCOPE_BEARER_ENDPOINT` to mint a fresh Azure token. The bearer is never a
     static header.

     That same request also states what the device is running:
     `X-TokenScope-Plugin-Version` (read from the `plugin.json` beside the helper,
     so it is the version that actually ran) and `X-TokenScope-Client-Version`
     (the CLI version, from `CLAUDE_CODE_EXECPATH` / `AI_AGENT`), plus
     `X-TokenScope-Client-Platform` (`<os>-<arch>` from `uname`, in Node's
     vocabulary: `darwin-arm64`, `linux-x64`, `win32-x64`) and
     `X-TokenScope-Client-Surface` (`CLAUDE_CODE_ENTRYPOINT`, or `app`/`cli` from
     Copilot's `AI_AGENT`). The server records them on `instance_attestation` as
     **client-asserted diagnostic
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

## Tag a repo (per repo)

Run the **`project`** MCP prompt in the repo. It lists the projects you can bill,
you pick one, and it:

- writes a committable `./.tokenscope` (`project.code: <code>`, preserving any
  existing fields) so the tag travels with the repo, then
- writes the **repo-local** `./.claude/settings.local.json` (mode 0600 on POSIX) with the
  `otelHeadersHelper` path and ONE env key, `OTEL_RESOURCE_ATTRIBUTES`:
  `tokenscope.instance_id=<DEVICE_SID>,project.code_hash=<sha256(code)>,tool=claude-code`.
  Claude Code merges the `env` blocks **per key**, so every other key (exporter,
  endpoints, credentials, and anything else you keep there) applies from your
  user settings and is never copied into the repo. If that file is tracked by
  git, nothing is written and the session start says so.

The device session id and helper path are restated from the global config on
**every** `claude` launch in that repo, which is what lets a plugin upgrade or
re-enrol reach every tagged repo automatically.
Commit the `.tokenscope`; teammates who clone it just run the `project` prompt
with no project (or let the SessionStart hook auto-apply it). Restart `claude`
in the repo — OTel resource attrs are read at startup, so the **next** session
is tagged.

The project name/code is not emitted; the hash is a stable identifier, not a
secret.

## `.tokenscope` file

Commit this at the repo root so every developer on the project gets the same
attribution:

```yaml
project:
  code: "1000012345/450000001"
  id: "contoso-ai-insights"
  name: "Contoso - AI Insights"

# Optional context — informational, not used for tagging.
client: "Contoso"
practice: "Data & AI"
engagement_type: "Fixed Price"
pm: "Alex Example"
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

The status line is **off** until you turn it on. `/tokenscope:statusline on`
installs it in `~/.claude/settings.json`, **replacing** any custom status line you
had; `/tokenscope:statusline off` removes it (a status line that isn't TokenScope's
is left untouched). Restart `claude` for the change to take effect.

It shows emission and delivery **health**, MCP-connection state and the current
**session id** (`#` + the first 8 characters of Claude's session id), for example
`TokenScope ✓ landed #65d2c64f`. The full list of states and what each means is in
[`commands/statusline.md`](commands/statusline.md). `/tokenscope:status` reports
the same verdict in detail; for your spend breakdown use the `usage` prompt /
`my_usage` tool / web dashboard.

## MCP server (the cross-client backbone)

The plugin registers a **remote MCP server** (`plugin/.mcp.json`) — a
streamable-HTTP server at the deployed base + `/api/v1/mcp`, authenticated by
OAuth 2.1 (no token to paste; the browser consent runs on first connect). It
points at the same deployment as the rest of the plugin: its URL is
`${user_config.server_url}/api/v1/mcp`, the `server_url` option you configure
(see [Point the plugins at your deployment](#point-the-plugins-at-your-deployment)).

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
  short-lived access tokens — there is no legacy session token. It is never
  written to a per-repo `settings.local.json` (see "Tag a repo" above): a tagged
  repo's session mints its bearer from the device's own state-dir credential store.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Windows without Node.js | Tracking works. The status line, `/tokenscope:backfill` and tagging sessions from a `.tokenscope` file need Node.js. Without it, a plugin update doesn't update your tracking settings, so run `/tokenscope:setup` again after each update. To get everything, run `winget install OpenJS.NodeJS.LTS`, then `/tokenscope:setup` again. |
| macOS / Linux: setup says `node: command not found` | Install Node.js (`sudo apt-get install -y nodejs`, `brew install node`, or add it to your container image), then run `/tokenscope:setup` again. |
| The browser sign-in can't get back to Claude Code | Copy the link the sign-in page shows into Claude Code. |
| `/mcp` says "URL is unset or invalid" | Set the plugin's server URL ([Point the plugins at your deployment](#point-the-plugins-at-your-deployment)), then restart Claude Code. |
| `/tokenscope:status` isn't green | Check you restarted Claude Code. In a repo with a `.tokenscope` file, restart once more if you see a "superseded device enrolment" warning. Still not green? Run `/tokenscope:setup` again. |
| Green, but no usage in TokenScope yet | Usage shows about 5 minutes after you use Claude Code. Status checks the credential, not delivery. |
