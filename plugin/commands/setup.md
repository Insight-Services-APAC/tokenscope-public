---
description: Set up TokenScope on this device — connect + provision emitting (one OAuth consent; the durable credential is redeemed locally, never via chat)
allowed-tools: mcp__tokenscope__provision_emit, mcp__tokenscope__my_usage, Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/device-id.mjs":*), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-redeem.mjs":*)
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

### 2. Read any existing device id (idempotency — SAME ENVIRONMENT **AND SAME TOOL** ONLY)

Get this host's current `tokenscope.instance_id` if it has one, so re-running
against the **same deployment** rotates the existing credential instead of minting
a new one. Ask the device-identity helper:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/device-id.mjs" --tool claude-code
```

It prints `{"enrolled":…,"tool":…,"instance_id":…,"bearer_host":…,"reason":…}` and
nothing else. Use `instance_id` only when `enrolled` is `true`; anything else
(including `enrolled: false`) → treat this as a fresh device and omit the id.

> **Never go looking for the id yourself.** The device store that carries it also
> carries this device's **durable emit credential** as a neighbouring key, so
> opening it copies a long-lived secret into this conversation. The helper reads
> the store out-of-process and prints only the non-secret fields — use it, and
> only it.
>
> **Ask it for the tool you are provisioning.** Instances are per-**HOST** but
> bound to ONE emit tool, and the helper reads only the store belonging to
> `--tool` — so `--tool claude-code` can only ever report a `claude-code`
> instance, and never hands you the Copilot CLI's id on a host running both. When
> that store holds no instance, or holds one bound to another tool, it reports
> `enrolled: false` (`reason: "no-enrolment"` / `"tool-mismatch"`) instead of an
> id you would misuse. That matters because a cross-tool re-provision revokes the
> other CLI's credential and **breaks its emitting** — silently, since the
> affected CLI keeps running while emitting nothing. The server refuses this with
> HTTP 409 before any rotation, but pass the right id, or none.

**Re-provisioning against a DIFFERENT deployment? Do NOT reuse the old id.** When
you are moving this device from one TokenScope deployment to another (Sandbox→Dev,
later Dev→Production), **omit** the existing `instance_id` so a fresh instance is
minted under the new environment — passing the old id would try to rotate an
instance that belongs to the _other_ deployment. Tell which environment you're on
two ways:

- The **`(Env)` label** in the TokenScope status line (e.g. `… (Sandbox)` vs
  `… (Dev)`), if the status line is enabled.
- The **`bearer_host`** the device-id helper printed in step 2 (it carries
  `tokenscope-<env>`).

If that environment differs from the deployment you're now provisioning against,
this is a cross-environment transition: omit the old id. (The local redeem helper
also detects the change from the bearer host and **replaces** the env block, so the
old environment's credentials and endpoints are dropped rather than left at rest.)

### 3. Provision emitting

Call the `provision_emit` tool, passing the existing `instance_id` from step 2
**only for a same-environment re-run** (omit it for a fresh device _or_ a
cross-environment move — see step 2). It does **not** return the durable emit
secret. It returns a short-TTL (~5 minute) one-time **handoff code**, a
per-instance **redeem URL**, and a short local-redeem instruction.

### 4. Redeem locally (process → process, NOT through this chat)

Run the local redeem helper, passing **only the handoff code** `provision_emit`
returned — do not construct any other invocation. `--redeem-url` no longer
exists, and the helper checks `--api-base` against the origins the device already
knows (loopback, the packaged deployment, the MCP server registered in your own
client config), so a relayed value can select one of those but cannot name a new
host. Pass neither:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-redeem.mjs" --handoff-code <code>
```

It redeems the handoff code and writes this device's Claude Code settings itself.
**Do not** ask for, print, or store the durable credential in this conversation,
and do not read the settings back to check it — the helper's own output already
says whether it succeeded.

### 5. Confirm + restart

Call `my_usage` again to confirm the MCP connection still answers, then tell the
user:

- **Connected** — the read/tag tools are authorised for your TokenScope account.
- **Emitting provisioned** — this device's Claude Code settings now carry the
  OTel plumbing.
- **Restart `claude`** — telemetry config is read at startup, so relaunch for
  emission to begin.
- **`/tokenscope:status` checks emit-AUTH health, not delivery.** It confirms the
  emit credential can mint an ingest bearer (the emission path is _configured and
  authorised_) — it does **not** prove any record physically landed. Ingest is
  ~4–5 min downstream through Azure Monitor OTLP and is **not observable
  client-side**, so do not read a green status as "telemetry arrived".
- **Confirm actual landing out-of-band.** After a few minutes of real usage, run
  `my_usage` (or open the dashboard) and look for this session's spend. That — not
  `/tokenscope:status` — is what tells you records are actually being attributed.
- **Next:** tag each repo with `/tokenscope-project` (writes a `.tokenscope`
  file) so its sessions attribute to a budget instead of landing as untagged.

## Troubleshooting

| Problem                                           | Solution                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `my_usage` says "Not authenticated"               | Let the MCP client finish the browser OAuth consent, then retry.                        |
| `provision_emit` handoff expired before redeem    | Handoff codes are ~5 min single-use — re-run `provision_emit` for a fresh one.          |
| Redeem helper reports a network error (not a 401) | The local helper couldn't reach the server; check the plugin's API base / connectivity. |
| Sessions still not emitting after redeem          | Restart `claude` — the OTel env is read once at process start.                          |
