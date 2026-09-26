#!/usr/bin/env node

/*
 * tokenscope-status (Copilot CLI) — "is my Copilot CLI emitting to TokenScope, and
 * did a record actually LAND?" The Copilot analogue of the Claude /tokenscope:status
 * probe (plugin/scripts/status.mjs). Copilot can't render a Claude-style statusline,
 * but it CAN run this probe from a skill and surface a clear health verdict.
 *
 * THREE signals, all local-first:
 *
 *  1. EMISSION PROBE. Invoke the SAME otel-headers-helper.sh the forwarder calls to
 *     mint the Azure ingest bearer, and branch on its exit code. Exit 0 with an
 *     Authorization header → the credential is VALID (emitting). Non-zero → the
 *     helper wrote a failure sentinel (precise HTTP status + reason) which we surface.
 *     The bearer the helper prints is NEVER surfaced — we only read whether one was
 *     minted. Creds come from ~/.tokenscope/config.copilot-cli.json (this lane's
 *     store; the pre-split config.json is read only until a redeem writes it);
 *     we build the TOKENSCOPE_* env the helper needs exactly as copilot-forwarder.mjs
 *     does, because Copilot does NOT export these to the shell.
 *
 *  2. LANDED CHECK. Ask GET /api/v1/instances/{id}/health (via landed-check.mjs) with
 *     the cached emit access token: did a real attribution_record land for this
 *     instance? Fail-open — any failure → "unconfirmed", never a false red.
 *
 *  3. MCP-AUTH — OMITTED for Copilot. Claude reads ~/.claude/.credentials.json
 *     (.mcpOAuth) to tell whether the query-side MCP connection is authed. Copilot
 *     CLI's MCP OAuth state has NO documented, reliably-readable on-disk equivalent
 *     (it is auth-gated and refreshes at CLI-auth time — research-17). Rather than
 *     guess, we OMIT this sub-check and say so; the canonical readiness signal for the
 *     query side is whether the `my_usage` MCP tool returns data (see the status skill).
 *
 *  4. MANAGED TELEMETRY (Workstream D §10.1). An enterprise-managed `telemetry`
 *     block (server-managed / native-MDM / file-based) can force Copilot's exporter
 *     away from the file lane, or turn telemetry off outright — SILENTLY, while the
 *     credential probe above still mints a healthy bearer. `emitting` above therefore
 *     answers "is the CREDENTIAL valid", not "will Copilot ever write a span at all" —
 *     those are different questions, and conflating them is exactly the false-healthy
 *     trap this check exists to close. `emission_healthy` is the composite: TRUE only
 *     when the credential is valid AND no hostile managed setting was found.
 *
 * ATTRIBUTION (landed != bound). A span LANDING is NOT the same as the spend being
 * ATTRIBUTED to a project/teammate. The highest-likelihood SILENT multi-org failure
 * is spend landing UNBOUND (untagged) — it counts as "landed" but reconciles to
 * nobody, so a landed-only verdict would call a broken loop "healthy". The unbound
 * signal lives on the QUERY side: `my_usage`'s `unallocated.needs_tagging_count`.
 * This local script CANNOT call MCP (no MCP client here — the skill orchestrator owns
 * that), so the count reaches the verdict ONE of two ways:
 *   (a) the skill calls `my_usage` and passes the count in via
 *       TOKENSCOPE_NEEDS_TAGGING_COUNT (preferred — a real, fresh signal); or
 *   (b) it is absent → attribution is reported UNKNOWN here and the skill is directed
 *       to read `needs_tagging_count` from `my_usage` itself.
 * Either way the verdict NEVER calls "a span landed" alone "healthy".
 *
 * Env in:
 *   TOKENSCOPE_STATE_DIR  state dir pin (default ~/.tokenscope under the PASSWD home,
 *                         not $HOME — see landed-check.mjs's stateDir()) — holds
 *                         config.copilot-cli.json, oauth-access.copilot-cli.json, the emit-failure sentinel.
 *   TOKENSCOPE_NEEDS_TAGGING_COUNT  optional — the untagged/unbound session count the
 *                         skill read from `my_usage`'s unallocated.needs_tagging_count.
 *                         Absent / non-numeric → attribution reported UNKNOWN (the skill
 *                         must check my_usage). 0 → landed-AND-attributed (healthy).
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { resolveStorePath } from './device-store.mjs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
// landed-check.mjs already owns the state-dir resolver this probe needs, and this
// module already imports from it — so import it rather than keep a second copy that
// could drift onto a different home anchor from the one refreshLanded() reads.
import { refreshLanded, stateDir } from './landed-check.mjs'
import { detectManagedTelemetry } from './managed-telemetry.mjs'
import { legacyForwarderActive, effectiveCopilotSettings, extensionsOn } from './copilot-emit.mjs'
import { copilotSettingsPath } from './copilot-redeem.mjs'
import { readUsageDrift, SPOOL_DIRNAME } from './copilot-usage.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Read one lane's emit-failure sentinel (or null). Per tool, like the store
 * (otel-headers-helper.sh SENTINEL): this lane's verdict reads only its own.
 */
function readEmitSentinel(stateD, tool = 'copilot-cli') {
  return readJson(join(stateD, `emit-failure.${tool}.json`))
}

/**
 * Decide the emission verdict from the helper's exit result + any sentinel it wrote.
 * Pure + exported for tests. `status` is the helper's exit code, `stdoutHasAuth`
 * whether a bearer was minted, `sentinel` the parsed emit-failure.json (or null).
 *
 * Mirrors the Claude interpretEmissionProbe contract (status.mjs) — kept as a
 * separate copy so the Copilot status surface has no dependency on plugin/scripts/.
 * Wording is Copilot-flavoured (skill name, not slash command), but the verdict
 * tree (200 / unexpected-0 / 401-403-404 / network / no-detail / other) is identical.
 */
export function interpretEmissionProbe({ status, stdoutHasAuth, sentinel }) {
  if (status === 0 && stdoutHasAuth) {
    return {
      emitting: true,
      probe_status: 200,
      message:
        'Emission auth OK — the real emit path (headers helper → /bearer) minted an Azure Monitor bearer. This proves the credential is VALID; it does NOT by itself confirm a record landed (see the landed check below).',
    }
  }
  if (status === 0 && !stdoutHasAuth) {
    return {
      emitting: false,
      probe_status: null,
      message:
        'Headers helper exited 0 but returned no Authorization header — unexpected. Re-run the tokenscope-status skill; if it persists, re-provision emit via the tokenscope-setup skill.',
    }
  }
  // Non-zero exit: the helper wrote a sentinel with the precise HTTP status + reason.
  const http = sentinel && Number.isFinite(sentinel.http_status) ? sentinel.http_status : null
  const reason = (sentinel && sentinel.message) || 'emission auth failed'
  let message
  if (http === 401 || http === 403 || http === 404) {
    message = `Emission auth FAILED — ${reason} (HTTP ${http}). Telemetry is being DROPPED. The durable credential may have lapsed or the instance was revoked/unknown — re-provision emit via the tokenscope-setup skill.`
  } else if (http === 0) {
    message = `Emission auth could not be verified — ${reason}. Often a transient network blip; re-run the tokenscope-status skill. If it persists, telemetry may be DROPPED.`
  } else if (http == null) {
    message = `Emission auth FAILED (no detail recorded — the headers helper exited non-zero). Telemetry may be DROPPED. Re-run the tokenscope-status skill; if it persists, re-provision emit via the tokenscope-setup skill.`
  } else {
    message = `Emission auth FAILED — ${reason} (HTTP ${http}). Telemetry may be DROPPED. Re-run the tokenscope-status skill or re-provision emit.`
  }
  return { emitting: false, probe_status: http, message }
}

/**
 * Interpret a landed-check result into a small verdict. Pure + exported for tests.
 * Fail-open: anything we can't confirm is "unconfirmed", never a hard red.
 *   - ok + a non-silent last_emission → LANDED
 *   - ok + silent / null last_emission → no recent record (lag, or genuinely silent)
 *   - revoked → instance ended (actionable)
 *   - not-ok → unconfirmed (network/offline/not-configured) — never red
 */
export function interpretLanded(result) {
  if (result && result.ok) {
    if (result.revoked) {
      return {
        landed: false,
        state: 'revoked',
        last_emission: result.lastEmission ?? null,
        message:
          'Instance is REVOKED/ended on the server — re-provision emit via the tokenscope-setup skill to start a fresh device.',
      }
    }
    if (result.lastEmission && !result.silent) {
      return {
        landed: true,
        state: 'landed',
        last_emission: result.lastEmission,
        message: `A record landed — last attribution at ${result.lastEmission} (server-confirmed).`,
      }
    }
    return {
      landed: false,
      state: 'silent',
      last_emission: result.lastEmission ?? null,
      message: result.lastEmission
        ? `No RECENT record — last landed ${result.lastEmission} but the device looks silent now. Records appear ~5 min after a session (OTLP ingest lag); if you've used Copilot recently and this persists, check emission above.`
        : 'No record has landed yet for this device. Records appear ~5 min after a session completes (OTLP ingest lag); run a Copilot session, then re-check.',
    }
  }
  // not-ok → fail-open to "unconfirmed". Surface the reason so it's debuggable.
  const reason = (result && result.reason) || 'unknown'
  let message
  if (reason === 'not-configured') {
    message =
      'Landed check unavailable — no ~/.tokenscope/config.copilot-cli.json (run the tokenscope-setup skill first).'
  } else if (reason === 'no-token') {
    message =
      'Landed check unavailable — no cached emit access token yet. The emission probe mints one; re-run after it succeeds.'
  } else if (reason === 'fetch-failed' || reason.startsWith('http-')) {
    message = `Landed check UNCONFIRMED — could not reach the health endpoint (${reason}). Often transient/offline; emission auth above is the primary signal.`
  } else {
    message = `Landed check UNCONFIRMED (${reason}).`
  }
  return { landed: false, state: 'unconfirmed', last_emission: null, message }
}

/**
 * Parse the untagged/unbound signal the skill passes from `my_usage`. The skill
 * reads `unallocated.needs_tagging_count` and exports it as
 * TOKENSCOPE_NEEDS_TAGGING_COUNT. Returns a non-negative integer, or null when the
 * env is absent / blank / non-numeric (→ "unknown", NOT "zero"). Pure + exported so
 * tests pin the parse (the difference between unknown and 0 is load-bearing — 0 is
 * "attributed/healthy", unknown is "go check my_usage").
 */
export function parseNeedsTaggingCount(raw) {
  const s = (raw ?? '').toString().trim()
  if (s === '') return null
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null
  return n
}

/**
 * Decide the ATTRIBUTION verdict — the landed-AND-attributed vs landed-but-unbound
 * distinction (P0-5). Pure + exported for tests.
 *
 * `landed` is the interpretLanded verdict; `needsTaggingCount` is the parsed
 * `my_usage` unbound signal (null = unknown). Verdict tree:
 *   - landed.landed !== true → attribution is moot here; defer to the landed verdict
 *     (nothing has landed yet, or it's silent/unconfirmed/revoked). state 'n/a'.
 *   - landed AND count > 0 → WARN: spend is landing UNBOUND/untagged. This is the
 *     silent failure a landed-only verdict hid. state 'unbound'.
 *   - landed AND count === 0 → landed-AND-attributed (genuinely healthy). state 'attributed'.
 *   - landed AND count unknown (skill didn't pass it) → state 'unknown' — direct the
 *     user to my_usage's needs_tagging_count. NEVER asserts "healthy" on landed alone.
 */
export function interpretAttribution({ landed, needsTaggingCount }) {
  if (!landed || landed.landed !== true) {
    return {
      attributed: null,
      state: 'n/a',
      needs_tagging_count: needsTaggingCount ?? null,
      message:
        'Attribution not evaluated — nothing has landed to attribute yet (see the landed check).',
    }
  }
  if (typeof needsTaggingCount === 'number' && needsTaggingCount > 0) {
    return {
      attributed: false,
      state: 'unbound',
      needs_tagging_count: needsTaggingCount,
      message: `Spend LANDED but is UNBOUND — ${needsTaggingCount} session${needsTaggingCount === 1 ? '' : 's'} need${needsTaggingCount === 1 ? 's' : ''} tagging. Landing is NOT attribution: this spend reconciles to no project (and, multi-org, to no tenant). Bind it with the tokenscope-project skill (commit a .tokenscope) or tag_session, then re-check.`,
    }
  }
  if (needsTaggingCount === 0) {
    return {
      attributed: true,
      state: 'attributed',
      needs_tagging_count: 0,
      message:
        'Spend landed AND attributed — no untagged sessions (my_usage needs_tagging_count = 0).',
    }
  }
  // landed, but the skill did not pass an unbound signal → genuinely unknown here.
  return {
    attributed: null,
    state: 'unknown',
    needs_tagging_count: null,
    message:
      'A span landed, but whether it ATTRIBUTED is UNKNOWN from this local probe — landing is not attribution. Call the `my_usage` MCP tool and read `unallocated.needs_tagging_count`: 0 = attributed/healthy; > 0 = spend is landing untagged (bind via the tokenscope-project skill).',
  }
}

/**
 * Interpret a detectManagedTelemetry() result into a small verdict + message. Pure +
 * exported for tests. NEVER echoes an endpoint/header value (managed-telemetry.mjs's
 * own contract) — only the classification, source, and safe boolean details.
 */
export function interpretManagedTelemetry(managed) {
  if (managed.classification === 'hostile') {
    return {
      hostile: true,
      state: 'hostile',
      source: managed.source,
      message: `Enterprise-managed Copilot telemetry settings (source: ${managed.source}) are HOSTILE to the file exporter — Copilot itself may be told to disable telemetry, or to export to a different collector, regardless of a valid TokenScope credential. This is a POLICY block, not a credential problem; ask your GitHub enterprise admin about the managed telemetry configuration.`,
    }
  }
  if (managed.classification === 'benign') {
    return {
      hostile: false,
      state: 'benign',
      source: managed.source,
      message: `Enterprise-managed Copilot telemetry settings (source: ${managed.source}) are present but compatible with the file exporter (only resourceAttributes/serviceName/captureContent-shaped fields).`,
    }
  }
  if (managed.classification === 'none') {
    return { hostile: false, state: 'none', source: managed.source, message: 'No enterprise-managed Copilot telemetry setting found on this device (file-based and native-MDM channels checked).' }
  }
  // 'unknown' — never asserts hostile OR healthy; says so and why.
  return {
    hostile: null,
    state: 'unknown',
    source: managed.source,
    message: `Could not confirm whether an enterprise-managed Copilot telemetry setting is active (checked: ${managed.checkedPaths.join(', ') || 'none'}). ${managed.serverManagedNote}`,
  }
}

/**
 * Active emission-auth probe for Copilot. Builds the TOKENSCOPE_* env from
 * config.copilot-cli.json (Copilot does NOT export these to the shell — same approach as
 * copilot-forwarder.mjs's mintBearer), runs otel-headers-helper.sh, and interprets
 * the result. NEVER surfaces the bearer.
 */
function probeEmissionAuth(stateD) {
  const cfg = readJson(resolveStorePath('copilot-cli', stateD))
  if (!cfg) {
    return {
      emitting: false,
      probe_status: null,
      message:
        'Not configured — no ~/.tokenscope/config.copilot-cli.json. Run the tokenscope-setup skill (provision_emit + local redeem), then re-check.',
    }
  }
  const hasCreds = Boolean(
    cfg.bearer_endpoint &&
    cfg.oauth_token_endpoint &&
    cfg.oauth_client_id &&
    cfg.oauth_refresh_token,
  )
  if (!hasCreds) {
    return {
      emitting: false,
      probe_status: null,
      message:
        'Not fully provisioned — config.copilot-cli.json is missing emit credentials (bearer_endpoint / oauth_*). Re-run the tokenscope-setup skill.',
    }
  }

  const helperPath = join(__dirname, 'otel-headers-helper.sh')
  if (!existsSync(helperPath)) {
    return {
      emitting: false,
      probe_status: null,
      message: 'Headers helper not found — is the plugin installed correctly?',
    }
  }

  // Build the env the helper reads — same mapping as copilot-forwarder.mjs::mintBearer.
  const env = {
    ...process.env,
    TOKENSCOPE_BEARER_ENDPOINT: cfg.bearer_endpoint,
    TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: cfg.oauth_token_endpoint,
    TOKENSCOPE_OAUTH_CLIENT_ID: cfg.oauth_client_id,
    TOKENSCOPE_OAUTH_REFRESH_TOKEN: cfg.oauth_refresh_token,
  }
  // State dir as an ARGUMENT, `/bin/sh` absolute: the helper no longer reads
  // TOKENSCOPE_STATE_DIR (Claude Code invokes it directly with a repo-merged
  // environment — see otel-headers-helper.sh's header), and a bare `sh` resolves
  // through a PATH that same merge can set.
  const res = spawnSync('/bin/sh', [helperPath, '--state-dir', stateD, '--tool', 'copilot-cli'], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let hasAuth = false
  try {
    hasAuth = Boolean(JSON.parse(res.stdout || '{}').Authorization)
  } catch {
    // Unparseable helper output → treat as no auth; `hasAuth` stays false.
  }
  return interpretEmissionProbe({
    status: res.status,
    stdoutHasAuth: hasAuth,
    sentinel: readEmitSentinel(stateD),
  })
}

/**
 * Compose the full status object from the emission probe, landed verdict, the
 * attribution verdict, and the last-failure sentinel. Pure + exported for tests (so
 * the JSON shape can be pinned without spawning the helper or touching the network).
 *
 * `attribution` is the interpretAttribution verdict (landed-AND-attributed vs
 * landed-but-unbound). When omitted (older callers/tests), it defaults to the
 * "unknown" verdict so the shape always carries the landed!=attributed distinction.
 *
 * `managedTelemetry` is the interpretManagedTelemetry verdict. When omitted, defaults
 * to 'unknown' (never silently assumes 'none') so `emission_healthy` never reads
 * healthy on absent information.
 */
/** Spool files older than this were not delivered by any later session: stuck. */
export const BACKLOG_STUCK_MS = 24 * 3600 * 1000

/**
 * Unsent spool files and the oldest one's age; null when there is no spool. A spool
 * that exists but cannot be listed is `{ error }`: its records can be neither seen
 * nor sent, so it is not "no backlog".
 */
export function readSpoolBacklog(stateD, now = Date.now()) {
  const dir = join(stateD, SPOOL_DIRNAME)
  let names
  try {
    names = readdirSync(dir)
  } catch (err) {
    return err?.code === 'ENOENT' ? null : { files: null, oldest_age_ms: null, error: String(err?.code ?? 'unreadable') }
  }
  let files = 0
  let oldest = null
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue
    try {
      const m = statSync(join(dir, n)).mtimeMs
      files += 1
      oldest = oldest == null ? m : Math.min(oldest, m)
    } catch {
      /* raced with a send */
    }
  }
  return { files, oldest_age_ms: oldest == null ? null : Math.max(0, now - oldest) }
}

/**
 * Which lane captures usage, and whether it can. The file forwarder owns a session
 * started with the legacy exporter env; otherwise the usage extension does, which the
 * Copilot App loads by default and the CLI only with the EXTENSIONS feature on.
 * Copilot hides that variable from the tools it runs, so inside Copilot this always
 * reads as the extension lane; `lane: 'forwarder'` appears only when the script is
 * run directly from a terminal that exports it. `enabled` says the extension WILL load, not that it did. `drift` is the
 * extension's shortfall/excess/contract sentinel; `backlog` its unsent spool. Either
 * one means usage is missing from TokenScope, so `healthy` is false.
 */
export function interpretUsageCapture({ env = {}, settings = null, drift = null, backlog = null } = {}) {
  // Drift and backlog belong to the device's extension sessions (the App, new
  // terminals), so they are reported on either lane.
  const stuck = (backlog?.oldest_age_ms ?? 0) > BACKLOG_STUCK_MS || Boolean(backlog?.error)
  if (legacyForwarderActive(env)) {
    return {
      lane: 'forwarder',
      enabled: true,
      healthy: !drift && !stuck,
      drift,
      backlog,
      message:
        'Legacy file forwarder (this session was started with COPILOT_OTEL_FILE_EXPORTER_PATH). Re-run setup to move to the usage extension.' +
        (drift ? ` Usage extension sessions on this device reported drift (${drift.kind}).` : '') +
        (backlog?.error
          ? ` The usage spool cannot be read (${backlog.error}).`
          : stuck
            ? ` ${backlog.files} usage spool file(s) have been waiting over 24h to send.`
            : ''),
    }
  }
  const app = env.AI_AGENT === 'github_copilot_app_agent'
  const flagOn = settings?.enabledFeatureFlags?.EXTENSIONS === true
  // The App loads extensions without the feature flag; the mode and the per-extension
  // switch apply to both.
  const enabled = extensionsOn(app ? { ...settings, enabledFeatureFlags: { ...(settings?.enabledFeatureFlags ?? {}), EXTENSIONS: true } } : settings)
  return {
    lane: 'extension',
    enabled,
    healthy: enabled && !drift && !stuck,
    extensions_feature: app ? 'app-default' : flagOn ? 'on' : 'off',
    extension_mode: settings?.extensions?.mode ?? 'default',
    drift,
    backlog,
    message: !enabled
      ? 'The TokenScope usage extension does not load (Copilot extensions are off, extension mode is disabled, or it is switched off in /extensions): sessions are captured only from a terminal that still exports the old COPILOT_OTEL_FILE_EXPORTER_PATH (the legacy forwarder), and nothing else is. Re-run TokenScope setup (it says what to change by hand when it cannot), then restart copilot.'
      : drift
        ? `Usage extension reported drift (${drift.kind}) at ${drift.ts}: Copilot's own usage totals and the recorded calls disagree, so some usage may be missing or counted twice.`
        : backlog?.error
          ? `The usage spool cannot be read (${backlog.error}): its records can be neither checked nor sent.`
          : stuck
            ? `${backlog.files} usage spool file(s) have been waiting over 24h to send: check network access to the TokenScope ingest endpoint.`
          : 'Usage extension enabled; nothing reported missing.',
  }
}

export function composeStatus({ probe, landed, attribution, sentinel, managedTelemetry, usageCapture }) {
  const attr = attribution || interpretAttribution({ landed, needsTaggingCount: null })
  const managed = managedTelemetry || { hostile: null, state: 'unknown', source: 'unknown', message: 'Managed-telemetry check was not run.' }
  return {
    tool: 'copilot-cli',
    emitting: probe.emitting,
    probe: { status: probe.probe_status, message: probe.message },
    // Workstream D §10.1 — a credential-valid probe (emitting=true) is NEVER, by
    // itself, proof that Copilot will ever write a span: a HOSTILE managed telemetry
    // setting kills the file exporter regardless. emission_healthy is the composite
    // an operator should actually read: true only when the credential is valid AND no
    // hostile managed setting was found. False when either half fails; the two
    // sub-fields (`emitting`, `managed_telemetry`) say WHICH.
    // The managed-telemetry block only reaches the file forwarder's span exporter; the
    // usage extension instead needs to be enabled with nothing reported missing
    // (usage_capture.healthy).
    emission_healthy:
      probe.emitting === true &&
      (usageCapture?.lane === 'extension'
        ? usageCapture.healthy === true
        : managed.hostile !== true && usageCapture?.healthy !== false),
    usage_capture: usageCapture ?? null,
    managed_telemetry: {
      state: managed.state,
      source: managed.source,
      message: managed.message,
    },
    landed: landed.landed,
    landed_check: {
      state: landed.state,
      last_emission: landed.last_emission,
      message: landed.message,
    },
    // Landing != attribution. `attributed` distinguishes landed-AND-attributed
    // (true) from landed-but-unbound/untagged (false), with null = unknown here
    // (skill must read my_usage's needs_tagging_count) or not-yet-landed.
    attributed: attr.attributed,
    attribution: {
      state: attr.state,
      needs_tagging_count: attr.needs_tagging_count,
      message: attr.message,
    },
    last_failure: sentinel,
    // Copilot has no reliably-readable on-disk MCP-auth state (unlike Claude's
    // ~/.claude/.credentials.json .mcpOAuth) — omit rather than guess.
    mcp_authed: null,
    mcp_authed_note:
      'MCP-auth state is not script-readable for Copilot CLI — omitted. Confirm the query side by calling the `my_usage` MCP tool (data back = authed; "Not authenticated" = run the tokenscope-setup skill).',
  }
}

async function main() {
  const stateD = stateDir()
  const probe = probeEmissionAuth(stateD)

  // Refresh + interpret the landed check (fail-open). Reuses landed-check.mjs which
  // GETs /health with the cached emit access token the probe just (re)minted.
  let landedResult
  try {
    landedResult = await refreshLanded({ dir: stateD })
  } catch {
    landedResult = { ok: false, reason: 'fetch-failed' }
  }
  const landed = interpretLanded(landedResult)
  const sentinel = readEmitSentinel(stateD)
  const otherLaneFailure = readEmitSentinel(stateD, 'claude-code')
  const usageCapture = interpretUsageCapture({
    env: process.env,
    settings: effectiveCopilotSettings(copilotSettingsPath(process.env)),
    drift: readUsageDrift(stateD),
    backlog: readSpoolBacklog(stateD),
  })

  // The unbound/untagged signal comes from `my_usage` (MCP) which this local script
  // cannot call — the skill orchestrator passes it via TOKENSCOPE_NEEDS_TAGGING_COUNT.
  // Absent → "unknown" (the skill is directed to read it from my_usage directly).
  const needsTaggingCount = parseNeedsTaggingCount(process.env.TOKENSCOPE_NEEDS_TAGGING_COUNT)
  const attribution = interpretAttribution({ landed, needsTaggingCount })

  // Workstream D §10.1 — never let a detector bug crash status itself; a failure here
  // degrades to 'unknown' (never asserted 'none'/'benign'), which composeStatus's
  // emission_healthy already treats as NOT healthy-by-default.
  let managedTelemetry
  try {
    managedTelemetry = interpretManagedTelemetry(await detectManagedTelemetry())
  } catch (err) {
    managedTelemetry = { hostile: null, state: 'unknown', source: 'unknown', message: `managed-telemetry check failed: ${String(err)}` }
  }

  const status = composeStatus({ probe, landed, attribution, sentinel, managedTelemetry, usageCapture })
  // The Claude lane's own failure on this host, reported, never merged into this
  // lane's verdict: its fix is a Claude setup, not a Copilot one.
  if (otherLaneFailure) {
    status.claude_lane_failure = { ...otherLaneFailure, fix: 'Run /tokenscope:setup in a Claude Code session.' }
  }
  console.log(JSON.stringify(status, null, 2))
}

// CLI entry guard so tests can import the pure helpers without running the probe.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((err) => {
    console.error(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
    process.exit(1)
  })
}
