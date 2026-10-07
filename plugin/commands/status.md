---
description: Check whether your Claude sessions are emitting to TokenScope
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs":*), Bash(C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/status.ps1":*), PowerShell(C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/status.ps1")
---

Tell the developer whether their Claude telemetry is reaching TokenScope
(emission health) and whether the TokenScope MCP connection is authed (so the
query tools/prompts can run).

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs"
```

**Windows without Node** (`node` is not found): run the PowerShell probe
instead. It prints the same JSON (with `project` null: the repo project check
needs Node):

```
C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/status.ps1"
```

If that path does not exist, Windows is on another drive (`$env:SystemRoot`
names it): run the same command with that drive letter in place of `C:`. Never
shorten it to a bare `powershell.exe`, which is looked up on a PATH the
repository can change.

On such a device emitting works and so do the MCP tools, but the status line,
`/tokenscope:backfill` and the repo project pin need Node. Say so once if
`runtime` is `"powershell"`, and that installing Node and re-running
`/tokenscope:setup` turns them on.

Returns:

```json
{
  "emitting": true,
  "probe": { "status": 200, "message": "OK: this computer can send usage to TokenScope. ..." },
  "last_failure": { "ts": "...", "http_status": 401, "message": "..." },
  "mcp_authed": true
}
```

Summarise as a 3-state health: the verdict first, then one next step, in plain
words (no "emit", "bearer" or "OAuth" in what you say):

- **GREEN — ✓ emitting + connected** (`emitting` true AND `mcp_authed` true):
  this device's emit credential works AND the MCP connection is authed. Quote
  `probe.message` (it says the check covers the credential, not delivery).
- **YELLOW — ⚠ emit-only** (`emitting` true, `mcp_authed` false): usage IS
  recorded, but the MCP server isn't connected, so the query tools/prompts
  (`my_usage`, `tag_session`, the setup/tag/project/usage prompts) can't run.
  Tell them: "Tracking works, but you're not signed in, so the TokenScope tools
  in this chat can't run. Run `/mcp`, choose tokenscope and approve in your
  browser, then run `/tokenscope:status` again."
- **RED — ✗ not emitting** (`emitting` false): telemetry dropped. Drive off
  `probe.status`:
  - 401/403/404 → say **NOT EMITTING ✗**, quote `probe.message`, and tell them
    to run `/tokenscope:setup` again (it re-provisions via `provision_emit`).
  - null/0 → emission could NOT be verified (often a transient network blip;
    suggest re-running) — do NOT cry "dropped".

Also:

- **Last recorded failure**: if `last_failure` is non-null, surface it (HTTP
  `last_failure.http_status`: `last_failure.message` at `last_failure.ts`). Even
  if the live probe now succeeds, a recent sentinel means emission flapped.
- For the attribution view (recent sessions / what's attributed) use the
  **`my_usage`** MCP tool or the TokenScope **web dashboard**.
- If `emitting` is false but they just set up: tell them to restart Claude Code.
  Claude reads telemetry config only at **startup**. (Ingest lag does not affect
  this probe: it checks the credential, not delivery. Delivery shows in
  `my_usage` about 4-5 min after real usage.)
