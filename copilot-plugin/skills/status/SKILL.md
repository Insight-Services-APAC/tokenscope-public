---
description: Check whether your Copilot CLI sessions are emitting to TokenScope, whether a record landed, and whether that spend actually ATTRIBUTED to a project
---

# tokenscope-status — Is My Copilot CLI Emitting AND Attributing?

Check the health of TokenScope emission for this device across three things, not two:
is the emit credential valid (sessions are **emitting**), did a record actually
**land** on the server, and did that landed spend actually **attribute** to a project
(or is it landing UNBOUND/untagged)? This is the Copilot analogue of Claude's
`/tokenscope:status`. Copilot CLI has no always-on status line, so run this probe on
demand when you want to confirm the loop is working — or when sessions seem to have
stopped attributing.

> **Landing is NOT attribution.** A span can land and still reconcile to **no
> project** (and, multi-org, to **no tenant**). That untagged/unbound state is the
> highest-likelihood _silent_ failure — it would look "green" if you only checked
> `landed`. This skill surfaces it as a distinct **WARN**, never as healthy.

## When to Use

- Confirming a fresh `tokenscope-setup` actually took (emitting + landing).
- Spend stopped showing up in `my_usage` and you want to know why.
- After re-installing the plugin or moving to a new host.

## Workflow

### Step 1: Run the status probe

Run the local probe script (no MCP/chat — it talks to the local emit path and the
device's own `/health` beacon):

```bash
node "$(ls -d "$HOME"/.copilot/installed-plugins/*/tokenscope-copilot/scripts/status.mjs | sort -V | tail -n1)"
```

It prints a JSON object:

```json
{
  "tool": "copilot-cli",
  "emitting": true,
  "probe": { "status": 200, "message": "Emission auth OK — ..." },
  "emission_healthy": true,
  "managed_telemetry": {
    "state": "none",
    "source": "none",
    "message": "No enterprise-managed Copilot telemetry setting found on this device ..."
  },
  "landed": true,
  "landed_check": {
    "state": "landed",
    "last_emission": "2026-06-22T08:14:03Z",
    "message": "A record landed — ..."
  },
  "attributed": null,
  "attribution": {
    "state": "unknown",
    "needs_tagging_count": null,
    "message": "A span landed, but whether it ATTRIBUTED is UNKNOWN from this local probe — call my_usage and read unallocated.needs_tagging_count ..."
  },
  "last_failure": null,
  "mcp_authed": null,
  "mcp_authed_note": "MCP-auth state is not script-readable for Copilot CLI — ..."
}
```

The probe runs the **real emit path** (`otel-headers-helper.sh` against the creds in
`~/.tokenscope/config.json`) — success means the credential minted an Azure Monitor
bearer. It then calls `GET /api/v1/instances/{id}/health` with the cached emit token
to see whether a real record has landed. It never prints the bearer.

**`emitting: true` is the CREDENTIAL signal, not the whole story.** An enterprise can
deploy a managed Copilot `telemetry` setting (server-managed / MDM / a distributed
file) that silently disables telemetry or reroutes it away from the file exporter
this loop depends on — **while the credential above still mints a healthy bearer.**
`emission_healthy` is the composite that actually matters: `true` only when the
credential is valid **AND** no hostile managed setting was found. Read
`emission_healthy`, not `emitting` alone, for the headline verdict — see Step 2's
managed-telemetry check below.

**`attributed` starts `null` (state `unknown`) on a plain run.** The unbound/untagged
signal lives on the **query side** (`my_usage`), which this local script can't call —
so by default the probe honestly reports attribution as UNKNOWN and points you at
`my_usage`. Step 2.5 below resolves it to a real verdict.

### Step 2: Interpret and report

Read the two headline signals and give the user a one-line verdict, then detail:

**1. Emission auth** (`emitting` + `probe.message`):

- `emitting: true` → **Emitting.** The credential is valid; sessions will attribute —
  UNLESS a hostile managed telemetry setting is blocking export (see below). This
  proves the credential works, not that a record has landed (that's the next check).
- `emitting: false` → **NOT emitting — telemetry is being DROPPED.** Surface
  `probe.message` verbatim; it carries the precise reason (HTTP 401/403/404 →
  re-provision via `tokenscope-setup`; HTTP 0 / network → likely transient, re-run;
  "not configured" → run `tokenscope-setup` first). Show `last_failure` if present.

**1.5. Managed telemetry** (`managed_telemetry` + `emission_healthy`) — **a
credential-valid probe is NEVER proof of delivery on its own:**

- `managed_telemetry.state: "hostile"` → **An enterprise policy is blocking Copilot's
  own telemetry export** (`enabled: false`, or an `endpoint`/`headers` override that
  discards the file exporter) — regardless of `emitting`. `emission_healthy` reads
  `false` even if `emitting` is `true`. This is a **policy problem, not a credential
  problem** — re-provisioning via `tokenscope-setup` will NOT fix it. Tell the user to
  raise it with their GitHub enterprise/IT admin (mention the `source`:
  native-mdm/file-based). Never print the managed setting's raw endpoint/header
  values — only what the script itself reports.
- `managed_telemetry.state: "benign"` → a managed telemetry block exists but only sets
  fields compatible with the file exporter (e.g. `resourceAttributes`/`serviceName`) —
  no action needed.
- `managed_telemetry.state: "none"` → no managed setting found on this device
  (file-based + native-MDM checked) — no action needed.
- `managed_telemetry.state: "unknown"` → the check could not confirm either way
  (unreadable file, unsupported platform check, or — always — server-managed settings
  cannot be read from this local script at all). `emission_healthy` still reflects the
  credential in this case (unknown is never treated as hostile), but say so plainly:
  this is NOT the same as a confirmed-clean result.

**2. Landed** (`landed` + `landed_check`) — _landing is necessary, not sufficient:_

- `state: "landed"` → **A record landed** at `last_emission` (server-confirmed). This
  is necessary but NOT a clean bill of health — go to Step 2.5 to confirm it
  _attributed_.
- `state: "silent"` → emitting OK but no recent record. Records appear ~5 min after a
  session completes (OTLP ingest lag), and the repo needs a `.tokenscope` for project
  attribution. Suggest running a Copilot session then re-checking.
- `state: "revoked"` → the instance was ended/revoked server-side — re-provision via
  `tokenscope-setup`.
- `state: "unconfirmed"` → could not reach the health endpoint (offline/transient).
  This is **not** a failure verdict — emission auth above is the primary signal.

### Step 2.5: Attribution — did the landed spend bind to a project? (the silent-failure check)

**Only when `landed: true`.** A landed span that tagged nothing reconciles to no
project (and, multi-org, no tenant) — the silent failure a landed-only verdict would
hide. The local probe can't see this (it's query-side state), so resolve it via
`my_usage`:

1. Call the **`my_usage`** MCP tool and read `unallocated.needs_tagging_count`.
2. Map it to a verdict:
   - `needs_tagging_count === 0` → **landed-AND-attributed (healthy).** Spend bound to
     a project; nothing untagged.
   - `needs_tagging_count > 0` → **WARN — landed but UNBOUND.** That many sessions are
     landing untagged: the spend reconciles to no project. Tell the user to **bind**
     it — run the `tokenscope-project` skill to commit a `.tokenscope` for the repo, or
     `tag_session` for a specific session — then re-check. **Do not call this state
     healthy.**
   - `my_usage` returns an auth error → the query side isn't connected; run
     `tokenscope-setup` (see Step 3). Attribution is unconfirmed, not healthy.

To fold the verdict into the script's JSON instead of reading `my_usage` by hand,
re-run the probe with the count passed in — the script's `attribution` block then
resolves to `attributed`/`unbound`:

```bash
TOKENSCOPE_NEEDS_TAGGING_COUNT=<unallocated.needs_tagging_count from my_usage> \
  node "$(ls -d "$HOME"/.copilot/installed-plugins/*/tokenscope-copilot/scripts/status.mjs | sort -V | tail -n1)"
```

`attribution.state` will read `attributed` (count 0), `unbound` (count > 0), `unknown`
(no count passed and nothing landed yet → `n/a`).

### The one-line "healthy" bar

A genuinely healthy device reads **emission_healthy: true + landed: true +
attribution.state: "attributed"** (i.e. `my_usage` `needs_tagging_count === 0`).
**`emitting: true` alone is NOT enough** — a hostile managed telemetry setting can
make it true while nothing is ever actually exported; read `emission_healthy`, which
folds in the managed-telemetry check. **`landed: true` ALONE is also NOT healthy** —
it can hide spend landing unbound. `emitting: true` with `landed: false /
unconfirmed` is normal right after setup or a fresh session — give it a few minutes
of ingest lag.

### Step 3: MCP-auth (the query side) — confirm separately

`mcp_authed` is **`null` on purpose**: unlike Claude Code, Copilot CLI has no
documented, reliably-readable on-disk MCP-auth state, so the script omits that
sub-check rather than guess (see `mcp_authed_note`). To confirm the **query** side
(the `my_usage` / `tag_session` tools and the setup/usage/project skills) is authed,
call the **`my_usage`** MCP tool: data back = authed; "Not authenticated" = run the
`tokenscope-setup` skill to complete the OAuth consent.

## Troubleshooting

| Problem                                                                       | Solution                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status.mjs` says "Not configured"                                            | Run the `tokenscope-setup` skill — there's no `~/.tokenscope/config.json` yet.                                                                                                                          |
| `emitting: false` with HTTP 401/403/404                                       | The durable credential lapsed or the instance was revoked — re-provision via `tokenscope-setup`.                                                                                                        |
| `emitting: true` but `emission_healthy: false`, `managed_telemetry.state: "hostile"` | An enterprise-managed telemetry policy is blocking Copilot's own export — **not a credential problem**, re-provisioning will not help. Raise it with your GitHub enterprise/IT admin (mention the `source`). |
| `managed_telemetry.state: "unknown"`                                          | The check could not confirm either way (often: server-managed settings, which no local script can read). Treat as "cannot confirm clean", not as healthy.                                              |
| `emitting: true` but `landed: unconfirmed`                                    | Often offline/transient. Emission auth is the primary signal; re-run later.                                                                                                                             |
| `emitting: true` but `landed: silent` for a while                             | Records lag ~5 min; ensure you've actually run a Copilot session since setup.                                                                                                                           |
| `landed: true` but `attribution.state: "unbound"` (`needs_tagging_count > 0`) | Spend is landing UNTAGGED — it binds to no project. Run the `tokenscope-project` skill to commit a `.tokenscope` for the repo, or `tag_session` for a specific session, then re-check. **Not healthy.** |
| `attribution.state: "unknown"`                                                | The probe wasn't given the `my_usage` count. Call `my_usage` and read `unallocated.needs_tagging_count` (or re-run with `TOKENSCOPE_NEEDS_TAGGING_COUNT=`).                                             |
| Want to confirm the query side too                                            | Call `my_usage` — it's the canonical MCP-auth signal for Copilot.                                                                                                                                       |
