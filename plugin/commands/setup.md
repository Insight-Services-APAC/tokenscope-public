---
description: Set up TokenScope on this device — connect + provision emitting (one OAuth consent; the durable credential is redeemed locally, never via chat)
allowed-tools: mcp__tokenscope__provision_emit, mcp__tokenscope__my_usage, Bash(node:*)
---

Connect Claude Code to TokenScope and turn on token attribution for this device.
One OAuth consent both **authenticates** you (so the read/tag tools work) and
**provisions emitting** (so your sessions attribute spend). The durable emit
credential never passes through this conversation — a local helper redeems it
process-to-process.

## When to use

- First time using Claude Code with TokenScope on this device.
- Your sessions stopped emitting and you want to re-provision.
- After reinstalling the plugin or moving to a new host.

## Workflow

### 1. Ensure the MCP connection is authenticated

Call the `my_usage` tool. If it returns data (or an empty-but-valid usage
summary), auth is good. If it reports "Not authenticated", let the client
complete the browser OAuth consent and retry.

### 2. Read any existing device id (idempotency — SAME ENVIRONMENT ONLY)

Read the current `tokenscope.instance_id` if one exists, so re-running against the
**same deployment** rotates the existing credential instead of minting a new one.
It lives in the `OTEL_RESOURCE_ATTRIBUTES` entry inside `~/.claude/settings.json`
(look for `tokenscope.instance_id=...`). No settings file or no instance id → treat
as a fresh device.

**Re-provisioning against a DIFFERENT deployment? Do NOT reuse the old id.** When
you are moving this device from one TokenScope deployment to another (Sandbox→Dev,
later Dev→Production), **omit** the existing `instance_id` so a fresh instance is
minted under the new environment — passing the old id would try to rotate an
instance that belongs to the *other* deployment. Tell which environment you're on
two ways:

- The **`(Env)` label** in the TokenScope status line (e.g. `… (Sandbox)` vs
  `… (Dev)`), if the status line is enabled.
- The configured **bearer host** in `~/.claude/settings.json` →
  `env.TOKENSCOPE_BEARER_ENDPOINT` (its hostname carries `tokenscope-<env>`).

If that environment differs from the deployment you're now provisioning against,
this is a cross-environment transition: omit the old id. (The local redeem helper
also detects the change from the bearer host and **replaces** the env block, so the
old environment's credentials and endpoints are dropped rather than left at rest.)

### 3. Provision emitting

Call the `provision_emit` tool, passing the existing `instance_id` from step 2
**only for a same-environment re-run** (omit it for a fresh device *or* a
cross-environment move — see step 2). It does **not** return the durable emit
secret. It returns a short-TTL (~5 minute) one-time **handoff code**, a
per-instance **redeem URL**, and a short local-redeem instruction.

### 4. Redeem locally (process → process, NOT through this chat)

Run the local redeem helper exactly as `provision_emit` instructs — the tool
response is the authoritative command. It redeems the handoff code and writes
`~/.claude/settings.json` itself. **Do not** ask for, print, or store the durable
credential in this conversation.

### 5. Confirm + restart

Call `my_usage` again to confirm the MCP connection still answers, then tell the
user:

- **Connected** — the read/tag tools are authorised for your TokenScope account.
- **Emitting provisioned** — `~/.claude/settings.json` now carries the OTel
  plumbing for this device.
- **Restart `claude`** — telemetry config is read at startup, so relaunch for
  emission to begin.
- **`/tokenscope:status` checks emit-AUTH health, not delivery.** It confirms the
  emit credential can mint an ingest bearer (the emission path is *configured and
  authorised*) — it does **not** prove any record physically landed. Ingest is
  ~4–5 min downstream through Azure Monitor OTLP and is **not observable
  client-side**, so do not read a green status as "telemetry arrived".
- **Confirm actual landing out-of-band.** After a few minutes of real usage, run
  `my_usage` (or open the dashboard) and look for this session's spend. That — not
  `/tokenscope:status` — is what tells you records are actually being attributed.
- **Next:** tag each repo with `/tokenscope-project` (writes a `.tokenscope`
  file) so its sessions attribute to a budget instead of landing as untagged.

## Troubleshooting

| Problem | Solution |
| --- | --- |
| `my_usage` says "Not authenticated" | Let the MCP client finish the browser OAuth consent, then retry. |
| `provision_emit` handoff expired before redeem | Handoff codes are ~5 min single-use — re-run `provision_emit` for a fresh one. |
| Redeem helper reports a network error (not a 401) | The local helper couldn't reach the server; check the plugin's API base / connectivity. |
| Sessions still not emitting after redeem | Restart `claude` — the OTel env is read once at process start. |
