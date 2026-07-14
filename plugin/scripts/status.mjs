#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * /tokenscope:status implementation — "is my Claude emitting to TokenScope, and
 * is the MCP connection (the query side) authed?"
 *
 * Two purely-LOCAL signals — NO settings.json read credential, NO server call:
 *
 *  1. EMISSION PROBE (unchanged). Invoke the SAME `otel-headers-helper.sh` that
 *     Claude Code calls every ~29 min to mint the Azure ingest bearer, and branch
 *     on its exit code (via plugin-runtime::runEmitHelper). Exit 0 (a bearer was
 *     minted) → emitting; non-zero → the helper already wrote a failure sentinel
 *     with the precise HTTP status + reason, which we surface.
 *
 *     WHY invoke the helper rather than GET /bearer ourselves: the helper is the
 *     REAL emit path — it presents the auto-refreshing OAuth emit credential. The
 *     bearer JSON the helper prints is NEVER surfaced (runEmitHelper returns only
 *     whether a bearer was minted, never the token).
 *
 *  2. MCP-AUTH PROBE (new). Read Claude Code's own credential store
 *     (~/.claude/.credentials.json). If its `.mcpOAuth` object holds an entry for
 *     the TokenScope MCP server (a key like `plugin:tokenscope:tokenscope|...`),
 *     the MCP connection is authed — so the my_usage / tag_session tools and the
 *     setup/tag/project/usage prompts can run. Presence = authed (the documented
 *     script-readable signal). Fail-defensive: no file → false; malformed → false.
 *
 * The server-side attribution view (recent sessions / what landed) is GONE from
 * this script — query it via the `my_usage` MCP tool or the web dashboard.
 *
 * Env in:
 *   TOKENSCOPE_BEARER_ENDPOINT   the per-instance /bearer URL (consumed by the helper)
 *   TOKENSCOPE_OAUTH_*           the OAuth emit credential (consumed by the helper)
 *   TOKENSCOPE_STATE_DIR         sentinel dir override (default $HOME/.tokenscope)
 *   CLAUDE_PLUGIN_ROOT           where otel-headers-helper.sh lives (set by Claude)
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEmitSentinel, runEmitHelper } from './plugin-runtime.mjs'
import { checkRepoProjectBillable } from './project-check.mjs'

/**
 * Decide the emission verdict from the helper's exit result + any sentinel it
 * wrote. Pure + exported for tests. `status` is the helper's exit code,
 * `stdoutHasAuth` whether a bearer was minted, `sentinel` the parsed
 * emit-failure.json (or null).
 */
export function interpretEmissionProbe({ status, stdoutHasAuth, sentinel }) {
  if (status === 0 && stdoutHasAuth) {
    return {
      emitting: true,
      probe_status: 200,
      message: 'Emission auth OK — the real emit path (headers helper → /bearer) minted an Azure Monitor bearer. This proves the credential is VALID; it does NOT confirm telemetry actually landed in Azure Monitor (the DCR/ingest/read path is downstream and not observable from here).',
    }
  }
  if (status === 0 && !stdoutHasAuth) {
    return {
      emitting: false,
      probe_status: null,
      message: 'Headers helper exited 0 but returned no Authorization header — unexpected. Re-run /tokenscope:status; if it persists, re-provision emit via the tokenscope-setup MCP prompt.',
    }
  }
  // Non-zero exit: the helper printed a loud, sanitised reason to stderr and
  // wrote a sentinel with the precise HTTP status + reason. Surface that.
  const http = sentinel && Number.isFinite(sentinel.http_status) ? sentinel.http_status : null
  const reason = (sentinel && sentinel.message) || 'emission auth failed'
  let message
  if (http === 401 || http === 403 || http === 404) {
    message = `Emission auth FAILED — ${reason} (HTTP ${http}). Telemetry is being DROPPED. The durable credential may have lapsed or the instance was revoked/unknown — re-provision emit via the tokenscope-setup MCP prompt.`
  } else if (http === 0) {
    // The helper recorded a NETWORK error — likely transient (the exporter keeps
    // its last bearer). Do NOT cry "dropped" or steer to re-provision.
    message = `Emission auth could not be verified — ${reason}. Often a transient network blip; re-run /tokenscope:status. If it persists, telemetry may be DROPPED.`
  } else if (http == null) {
    // Helper exited non-zero but recorded NO sentinel (e.g. the sentinel write
    // itself failed) — a real failure with no detail. Steer to re-provision rather
    // than mislabel it transient (under-warning is as bad as crying wolf).
    message = `Emission auth FAILED (no detail recorded — the headers helper exited non-zero). Telemetry may be DROPPED. Re-run /tokenscope:status; if it persists, re-provision emit via the tokenscope-setup MCP prompt.`
  } else {
    message = `Emission auth FAILED — ${reason} (HTTP ${http}). Telemetry may be DROPPED. Re-run /tokenscope:status or re-provision emit.`
  }
  return { emitting: false, probe_status: http, message }
}

/**
 * Active emission-auth probe. Invokes the real emit path (runEmitHelper) and
 * interprets its exit code + sentinel. NEVER surfaces the bearer.
 */
function probeEmissionAuth() {
  const endpoint = (process.env.TOKENSCOPE_BEARER_ENDPOINT ?? '').trim()
  const hasOAuth = Boolean(
    (process.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN ?? '').trim() &&
      (process.env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT ?? '').trim() &&
      (process.env.TOKENSCOPE_OAUTH_CLIENT_ID ?? '').trim(),
  )
  if (!endpoint || !hasOAuth) {
    return {
      emitting: false,
      probe_status: null,
      message:
        "Not configured — no bearer endpoint / OAuth emit credential in this session's env. Run the tokenscope-setup MCP prompt (provision_emit), then restart `claude` (OTel env is read at startup).",
    }
  }
  const { ran, status, hasAuth } = runEmitHelper()
  if (!ran) {
    return {
      emitting: false,
      probe_status: null,
      message: 'Headers helper not found — is the plugin installed / CLAUDE_PLUGIN_ROOT set?',
    }
  }
  return interpretEmissionProbe({ status, stdoutHasAuth: hasAuth, sentinel: readEmitSentinel() })
}

/** Abs path to Claude Code's own credential store. */
function credentialsPath() {
  return join(homedir(), '.claude', '.credentials.json')
}

/**
 * Report whether the TokenScope MCP server has an OAuth entry in Claude Code's
 * credential store (i.e. the MCP connection is authed). The store keys MCP OAuth
 * state under `.mcpOAuth` by server id; the TokenScope plugin MCP server's key is
 * prefixed `plugin:tokenscope:tokenscope|`. Presence of ANY matching key = authed
 * — this is the documented script-readable signal.
 *
 * Pure over the parsed JSON so tests can drive it directly. Fail-defensive:
 * non-object / missing `.mcpOAuth` → false.
 */
export function isMcpAuthed(creds) {
  const mcp = creds && typeof creds === 'object' ? creds.mcpOAuth : null
  if (!mcp || typeof mcp !== 'object') return false
  return Object.keys(mcp).some(
    (k) => k === 'plugin:tokenscope:tokenscope' || k.startsWith('plugin:tokenscope:tokenscope|'),
  )
}

/** Probe MCP-auth from Claude's credential store. Fail-defensive → false. */
function probeMcpAuth() {
  let creds
  try {
    creds = JSON.parse(readFileSync(credentialsPath(), 'utf8'))
  } catch {
    return false // no file / unreadable / malformed → not authed
  }
  try {
    return isMcpAuthed(creds)
  } catch {
    return false
  }
}

/**
 * The project-tag billability block: is THIS repo's project tag billable on the
 * env the device emits to? Deterministic over the running session's frozen env (no
 * MCP needed). Fail-defensive: any non-billable verdict is the actionable wrong-env
 * warning; everything else (offline/unauth/no-tag) is reported neutrally, never red.
 */
async function projectBlock() {
  let r
  try {
    r = await checkRepoProjectBillable({ env: process.env, cwd: process.cwd() })
  } catch {
    return { code: null, billable: null, message: 'Project-tag check unavailable.' }
  }
  if (r.status === 'ok') {
    return { code: r.code ?? null, billable: true, message: `Project tag${r.code ? ` “${r.code}”` : ''} is billable on this environment.` }
  }
  if (r.status === 'not-billable') {
    const projects = (r.yourProjects || []).map((p) => p && p.code).filter(Boolean)
    const hint = projects.length ? ` Your budgets: ${projects.join(', ')}.` : ''
    return {
      code: r.code ?? null,
      billable: false,
      message: `Wrong-env tag:${r.code ? ` “${r.code}”` : ''} is NOT billable here — spend is landing UNTAGGED. Re-tag via /tokenscope:project.${hint}`,
    }
  }
  if (r.status === 'no-tag') {
    return { code: null, billable: null, message: 'No project tag (.tokenscope) in this repo — spend is untagged by default.' }
  }
  return { code: null, billable: null, message: 'Project-tag billability unverified (offline, or emit not yet authed).' }
}

async function main() {
  const probe = probeEmissionAuth()
  const sentinel = readEmitSentinel()
  const mcpAuthed = probeMcpAuth()
  const project = await projectBlock()

  console.log(
    JSON.stringify(
      {
        emitting: probe.emitting,
        probe: {
          status: probe.probe_status,
          message: probe.message,
        },
        project,
        last_failure: sentinel,
        mcp_authed: mcpAuthed,
      },
      null,
      2,
    ),
  )
}

// CLI entry guard so tests can import the pure helpers without running the probe
// (mirrors backfill.mjs).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    process.exit(1)
  })
}
