---
description: Turn the TokenScope status line (emission health + session id) on or off
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline-toggle.mjs":*)
---

TokenScope installs a status line ON by default showing, every refresh, a
**landing-driven** health plus the session id. The primary signal is whether your
usage is actually LANDING server-side (confirmed attributed), not merely whether
emit auth works — so a "dead export" (auth fine, but nothing landing) reads as a
clear not-working state, never a benign colour:

- **health** (highest-priority first):
  - `TokenScope ✓ landed` (green) — delivery CONFIRMED (a recent record landed +
    was attributed) AND the MCP connection is authed (can query/tag);
  - `TokenScope ⚠ landed · emit-only` (yellow) — delivery confirmed, but the MCP
    server isn't connected, so query tools/prompts can't run (connect it to query);
  - `TokenScope ✗ not landing` (red) — DEAD EXPORT: the client is actively emitting
    (a recent bearer mint) but nothing is being attributed — investigate. Two shapes
    reach it: the landed watermark has stopped keeping up (it was landing, then
    stopped), OR the enrolment is more than a couple of hours old and has NEVER
    landed anything at all. An IDLE client with an old last emission is NOT flagged
    (a stale watermark is expected when nobody's emitting);
  - `TokenScope ✗ enrolment revoked` (red) — this device's enrolment was revoked
    server-side (re-provision emit via the `tokenscope-setup` MCP prompt);
  - `TokenScope ✗ emit-auth failing` (red) — the emit credential can't mint a
    bearer (the root problem — outranks the landing signal);
  - `TokenScope ⚠ emit-only` (yellow) — auth fine but landing UNCONFIRMED (health
    endpoint unreachable) AND MCP not connected;
  - `TokenScope ◎ emit-auth` (cyan) — auth fine, MCP connected, but landing
    UNCONFIRMED — the health endpoint is unreachable, or this enrolment is new
    enough that a first record could still legitimately be in flight. A neutral
    fallback, distinct from the green "landed". It is deliberately time-limited:
    an enrolment that goes on never landing stops reading neutral and becomes
    `✗ not landing`;
- the current **session id** (`#65d2c64f`) — same "Conversation" id as the
  TokenScope web dashboard, so you can tell which row you're in.

The landing state comes from the per-instance server `/health` endpoint, polled at
most once every ~5 minutes and cached; the always-on status line renders from the
cache and refreshes it in the background, so it never blocks a prompt on the network.

The developer may pass `on` or `off` (or nothing to check state). Run, passing
their argument through verbatim (default empty):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline-toggle.mjs" "$ARGUMENTS"
```

Returns JSON `{ action, changed, message, ... }`. Relay `message`. Notes:

- `on` force-installs TokenScope's status line. If they had their OWN custom one,
  it is **replaced** (`replacedCustom: true`) — mention this, and tell them
  `/tokenscope:statusline off` reverts.
- `off` removes ONLY TokenScope's status line; a custom one is left untouched.
- Change takes effect on the **next** session (Claude reads `statusLine` from
  settings at startup) — tell them to restart `claude`.
