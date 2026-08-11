---
description: Check whether your Claude sessions are emitting to TokenScope
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs":*)
---

Tell the developer whether their Claude telemetry is reaching TokenScope
(emission health) and whether the TokenScope MCP connection is authed (so the
query tools/prompts can run).

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs"
```

Returns:

```json
{
  "emitting": true,
  "probe": { "status": 200, "message": "Emission auth OK — ..." },
  "last_failure": { "ts": "...", "http_status": 401, "message": "..." },
  "mcp_authed": true
}
```

Summarise as a 3-state health, leading with the live verdict:

- **GREEN — ✓ emitting + connected** (`emitting` true AND `mcp_authed` true):
  usage is reaching Azure Monitor AND the MCP connection is authed. Quote
  `probe.message`.
- **YELLOW — ⚠ emit-only** (`emitting` true, `mcp_authed` false): usage IS
  recorded, but the MCP server isn't connected, so the query tools/prompts
  (`my_usage`, `tag_session`, the setup/tag/project/usage prompts) can't run.
  Tell them to connect it — run a TokenScope MCP tool/prompt and complete the
  browser OAuth consent — then re-run this.
- **RED — ✗ not emitting** (`emitting` false): telemetry dropped. Drive off
  `probe.status`:
  - 401/403/404 → say **NOT EMITTING ✗**, quote `probe.message`, steer them to
    re-provision emit via the **tokenscope-setup** MCP prompt (provision_emit).
  - null/0 → emission could NOT be verified (often a transient network blip;
    suggest re-running) — do NOT cry "dropped".

Also:

- **Last recorded failure**: if `last_failure` is non-null, surface it (HTTP
  `last_failure.http_status`: `last_failure.message` at `last_failure.ts`). Even
  if the live probe now succeeds, a recent sentinel means emission flapped.
- For the attribution view (recent sessions / what's attributed) use the
  **`my_usage`** MCP tool or the TokenScope **web dashboard**.
- If `emitting` is false but they just set up: Azure Monitor OTLP ingest lags
  ~4-5 min, and Claude reads telemetry config at **startup** — after
  provisioning emit they must restart `claude`.
