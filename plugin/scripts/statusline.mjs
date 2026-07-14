#!/usr/bin/env node
/*
 * statusline.mjs — the TokenScope Claude Code status-line segment.
 *
 * Renders one always-visible line answering the questions a developer has
 * mid-session:
 *   1. "Is my usage actually LANDING?" → the DELIVERY-CONFIRMATION signal, read
 *      from the last-landed cache that landed-check.mjs writes from the server's
 *      per-instance /health endpoint (`last_emission` = MAX ts of a record the
 *      server CONFIRMED landed + attributed; `last_bearer_at` = the client's last
 *      bearer mint, a proxy for recent emit ACTIVITY). This is the primary health
 *      driver: auth minting a bearer is NOT proof anything landed. When the client
 *      is actively emitting (recent bearer) but the landed watermark isn't keeping
 *      up = a DEAD EXPORT (accepted by the collector, never attributed) → reads
 *      clearly not-working, never a benign colour. Crucially we compare landing to
 *      the client's OWN emit activity, not wall-clock: an IDLE client's stale
 *      `last_emission` is expected and must NOT false-alarm red.
 *      (This is the bug this file exists to fix: a week of "auth fine, nothing
 *      landing" hid behind a cyan `◎ emit-auth` that read as healthy.)
 *   2. "Is my emit AUTH healthy?" → emission auth, read from the helper's
 *      emit-failure sentinel (the SAME signal /tokenscope:status uses). Cheap
 *      local file read.
 *   3. "Can I QUERY TokenScope (my_usage / tag_session)?" → MCP-auth state, read
 *      from Claude Code's own credential store (~/.claude/.credentials.json →
 *      `.mcpOAuth` has a key for the TokenScope MCP server). Cheap local read.
 *   4. "Which dashboard row is THIS session?" → the session id Claude passes on
 *      stdin (TokenScope's "Conversation" id). Match the prefix.
 *
 * Health states (highest-priority first):
 *   TokenScope · not configured        — no device emit config (run tokenscope-setup, dim)
 *   TokenScope ✗ emit-auth failing     — the emit credential can't mint a bearer (red)
 *   TokenScope ✗ enrolment revoked     — /health says this enrolment was revoked (red)
 *   TokenScope ✗ not landing           — DEAD EXPORT: the client is actively emitting
 *                                        (recent bearer) but the landed watermark isn't
 *                                        keeping up → nothing is being attributed (red)
 *   TokenScope ⚠ landed · emit-only    — delivery CONFIRMED, but MCP not connected (yellow)
 *   TokenScope ✓ landed                — delivery CONFIRMED + MCP authed (green)
 *   TokenScope ⚠ emit-only             — landing UNCONFIRMED + MCP not connected (yellow)
 *   TokenScope ◎ emit-auth             — auth fine, MCP authed, delivery UNCONFIRMED
 *                                        (/health unreachable, or idle+never-landed —
 *                                        a neutral fallback, cyan)
 *
 * The `◎ emit-auth` cyan is now STRICTLY the "we couldn't confirm landing" fallback
 * (health unreachable / idle client that has never landed) — it no longer covers
 * "landing looks dead". When the client is actively emitting, the landing state is
 * the primary colour driver; an IDLE client never trips the red dead-export state.
 *
 * The trailing (Env) tag is DERIVED from the configured emit endpoint, never
 * hardcoded — see emitEnvLabel().
 *
 * FAIL-SILENT + FAST: a status-line command must never hang or crash the UI, so
 * every read is guarded and any error prints nothing. The render itself makes NO
 * network call — it reads the /health answer from the last-landed cache. It DOES
 * fire a throttled, DETACHED (unref'd) background refresh of that cache at most
 * once every POLL_INTERVAL_MS, so a long session's landing state stays current
 * without the render ever blocking on the network (see maybeSpawnLandedRefresh).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { readEmitSentinel, globalSettingsEnv, stateDir } from './plugin-runtime.mjs'

const C = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', dim: '\x1b[2m', reset: '\x1b[0m' }

/**
 * How recently the client must have minted a /bearer to count as LIVE ENOUGH to
 * judge landing at all (the `now - last_bearer_at` active window). Claude Code
 * re-runs otel-headers-helper (a bearer mint) at startup and every ~29 min WHILE
 * a session is open, so a bearer within ~90 min means "a session was active
 * recently". Beyond it the client is IDLE — a stale `last_emission` is expected
 * and must never read red. 90 min = the ~29-min refresh cadence plus slack.
 */
export const DEAD_EXPORT_MS = 90 * 60 * 1000

/**
 * How far the landed watermark (`last_emission`) may trail an ACTIVELY-refreshing
 * client's emit activity before we call the export DEAD. This is deliberately much
 * larger than one ingestion window, because `last_bearer_at` is a CREDENTIAL-
 * refresh heartbeat (29-min timer), NOT an emission timestamp — so within a single
 * long session the bearer keeps ticking while `last_emission` legitimately lags by
 * hours during any read/think stretch with no token usage. A gap of *hours* is
 * normal within-session idle; only a gap of ~a DAY (watermark frozen while the
 * credential keeps refreshing) proves a dead export. We reuse the server's own
 * "went silent" horizon (SILENT_AFTER_HOURS = 24h) so the client verdict can't
 * contradict the server's. Sanity: a multi-day read-path outage → gap ≫ 24h →
 * dead; a 3h within-session idle (last emission this morning) → gap < 24h → landed.
 */
export const LANDED_LAG_MS = 24 * 60 * 60 * 1000

/**
 * Pure: classify the DELIVERY-CONFIRMATION (landing) state from a /health cache.
 * Tested directly, independent of the network. Inputs:
 *   - cache:  the parsed last-landed.json object, or null (no cache yet). Shape:
 *             { ok, instanceId, lastEmission, lastBearer, silent, revoked, checkedAt }.
 *             `ok:true` = /health was actually REACHED on the last refresh.
 *   - instanceId: the currently-configured instance id (to reject a stale cache
 *             left by a different enrolment sharing the home dir).
 *   - now:    Date.now() (injectable for tests).
 *
 * The verdict keys off the CLIENT's recent activity (`lastBearer` = its last
 * bearer mint, a session-liveness heartbeat), NOT the wall-clock age of
 * `lastEmission` — because `lastEmission` goes naturally stale on an IDLE client
 * (nobody's emitting). We only call an export DEAD when a session is live yet the
 * landed watermark has fallen far behind (see DEAD_EXPORT_MS / LANDED_LAG_MS for
 * why the two thresholds differ — bearer freshness ≠ emission freshness).
 *
 * Returns one of:
 *   'revoked' — the enrolment was revoked server-side (clear error).
 *   'dead'    — CLIENT ACTIVE (bearer within DEAD_EXPORT_MS) AND a PRIOR landing
 *               has since gone stale (bearer − emission > LANDED_LAG_MS) → landing
 *               was working and STOPPED, emissions accepted but no longer landing.
 *               Requires a prior landing; a never-landed client is NOT dead.
 *   'landed'  — delivery confirmed: an active client whose watermark is keeping
 *               up, OR an idle client whose last emission DID land at some point.
 *   'unknown' — /health NOT reached (cache missing/never-ok/other-instance); an
 *               ACTIVE client that has NEVER landed (fresh enrolment, first record
 *               still pending); or an idle client that has never landed anything.
 *               We can neither confirm nor deny → render stays NEUTRAL, never red.
 */
export function classifyLanding(cache, instanceId, now = Date.now()) {
  // No cache, or the last refresh never reached /health → nothing confirmed.
  if (!cache || typeof cache !== 'object' || cache.ok !== true) return 'unknown'
  // A cache left by a DIFFERENT enrolment (shared home dir) tells us nothing.
  if (instanceId && cache.instanceId && cache.instanceId !== instanceId) return 'unknown'
  if (cache.revoked === true) return 'revoked'

  const emission = parseTs(cache.lastEmission)
  const bearer = parseTs(cache.lastBearer)

  // CLIENT ACTIVE — minted a bearer within the active window, so a session is live
  // and we CAN judge landing. 'dead' requires a PRIOR landing that has since gone
  // stale (>LANDED_LAG_MS while the credential keeps refreshing = a real read-path
  // outage — the actual incident); an hours-long within-session idle stays 'landed'.
  // A client that has NEVER landed (emission null) is NOT dead — it's a fresh
  // enrolment whose first record hasn't landed yet (~10-60 min post-setup): report
  // the honest neutral 'unknown', never a false red exactly when the user is
  // verifying setup. (Systemic never-lands are the SERVER read-path-health alert's
  // job, not this per-device beacon.)
  // SKEW blind spot (documented, fails SAFE): a client clock running >DEAD_EXPORT_MS
  // AHEAD of the server-stamped last_bearer_at makes `now - bearer` exceed the
  // window → misjudged IDLE → a real dead export can read green. This never yields
  // a false RED, so we accept it as a known limitation rather than trust the clock.
  if (bearer !== null && now - bearer <= DEAD_EXPORT_MS) {
    if (emission === null) return 'unknown'
    if (bearer - emission > LANDED_LAG_MS) return 'dead'
    return 'landed'
  }

  // CLIENT IDLE — no recent bearer (or `lastBearer` absent from an old-format
  // cache: treat as idle, the safe default → never a false red). A stale
  // `lastEmission` is EXPECTED here, so never 'dead'. If their last emission ever
  // landed, that's a confirmed 'landed'; if nothing ever landed, we simply don't
  // know (idle + never-landed is indistinguishable from a fresh enrolment).
  return emission !== null ? 'landed' : 'unknown'
}

/**
 * Parse the server's `last_emission` / `last_bearer_at`. They arrive in TWO shapes
 * across the stack: ISO-8601 (`2026-06-22T08:14:03Z`) and the Postgres text cast
 * (`2026-06-30 21:38:58.933+00`, space-separated, no `T`, and a SHORT `+00`
 * offset). `Date.parse` rejects both the space form and the 2-digit `+00` offset
 * (→ NaN) across V8, so normalise: space→`T`, and a trailing `±HH` offset →
 * `±HH:00`.
 *
 * REFUSE to guess local time: a NAIVE timestamp (no `Z`, no `±HH:MM` offset) would
 * otherwise be parsed by Date.parse against the machine's LOCAL zone → a wrong
 * epoch (not null), skewing the staleness maths silently. The server always stamps
 * UTC today, so this is latent — but rather than trust that forever, an
 * offset-less string returns null (treated upstream as absent/never-landed, the
 * safe neutral). Returns epoch ms, or null when unparseable / naive / absent.
 */
function parseTs(v) {
  if (!v || typeof v !== 'string') return null
  let iso = v.includes('T') ? v : v.replace(' ', 'T')
  // A bare `±HH` offset (Postgres `+00`) is not valid ISO — pad it to `±HH:00`.
  iso = iso.replace(/([+-]\d{2})$/, '$1:00')
  // Reject a naive (zoneless) timestamp rather than let Date.parse assume local.
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/**
 * Pure: render the line from resolved state. Tested directly.
 *   - configured: device has emit config (instance attrs present)
 *   - emitting:   configured AND no failure sentinel (i.e. the LAST /bearer mint
 *                 succeeded — emit AUTH is healthy). If this is false the credential
 *                 itself is broken (red `✗ emit-auth failing`) — the root problem,
 *                 so it outranks any landing signal.
 *   - landing:    the DELIVERY-CONFIRMATION state from classifyLanding():
 *                 'landed' (green ✓) | 'dead' (red ✗ not landing) |
 *                 'revoked' (red ✗ enrolment revoked) | 'unknown' (neutral fallback).
 *                 When /health is reachable (landed/dead/revoked) this is the PRIMARY
 *                 colour driver. When it's 'unknown' we fall back to the MCP-auth
 *                 split below — cyan `◎ emit-auth` for the unconfirmed-but-fine case
 *                 (NEVER green, so "unconfirmed" is visually distinct from "landed").
 *   - mcpAuthed:  the TokenScope MCP server is OAuth-authed in Claude's store.
 */
export function formatStatusLine({ configured, emitting, mcpAuthed, landing = 'unknown', sessionId, envLabel = null, color = true }) {
  const paint = (c, s) => (color ? `${c}${s}${C.reset}` : s)
  if (!configured) return paint(C.dim, 'TokenScope · not configured')
  const sid = sessionId ? ` ${paint(C.dim, `#${String(sessionId).slice(0, 8)}`)}` : ''
  const tag = envLabel ? ` ${paint(C.dim, `(${envLabel})`)}` : ''
  const line = (c, label) => `${paint(c, `TokenScope ${label}`)}${sid}${tag}`
  // 1. Auth itself broken — can't even mint a bearer. Root cause; outranks all.
  if (!emitting) return line(C.red, '✗ emit-auth failing')
  // 2-3. /health reachable: landing is the primary driver. A dead/revoked export
  //      is the WORST news and reads clearly not-working (red), regardless of MCP.
  if (landing === 'revoked') return line(C.red, '✗ enrolment revoked')
  if (landing === 'dead') return line(C.red, '✗ not landing')
  // 4. Delivery CONFIRMED. Green when you can also query it; yellow when MCP isn't
  //    connected yet (records land, but my_usage / tag_session aren't wired).
  if (landing === 'landed') return mcpAuthed ? line(C.green, '✓ landed') : line(C.yellow, '⚠ landed · emit-only')
  // 5. 'unknown' — /health unreachable: we can neither confirm nor deny landing.
  //    NEVER red (no false dead-export alarm). Cyan `◎ emit-auth` is the neutral
  //    "auth fine, delivery unconfirmed" fallback — visually distinct from green.
  if (!mcpAuthed) return line(C.yellow, '⚠ emit-only')
  return line(C.cyan, '◎ emit-auth')
}

/**
 * Environment label DERIVED from the live emit config — NEVER hardcoded. Reads
 * BOTH the OTLP logs endpoint (where OTel is sent) and the bearer endpoint (the
 * deployment origin) — they describe the SAME deployment. We classify from
 * whichever names the env, because the app/bearer host reliably carries
 * `tokenscope-<env>` (tokenscope.example.com, ep-tokenscope-sandbox-aue-…)
 * whereas the OTLP DCE host carries it for some envs (dev: dce-tokenscope-dev-…)
 * but NOT all (sandbox's DCE is dce-tokenscope-otlp-…). Unrecognised deployments
 * return their bare host, so the tag never guesses. Null when nothing configured.
 */
export function emitEnvLabel(env) {
  const hostOf = (u) => {
    try {
      return new URL((u || '').trim()).host.toLowerCase()
    } catch {
      return ''
    }
  }
  const bearer = hostOf(env?.TOKENSCOPE_BEARER_ENDPOINT)
  const otlp = hostOf(env?.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
  if (!bearer && !otlp) return null
  // Match the bounded product token `tokenscope-<env>` in EITHER host. Both \b
  // anchors matter: the right rejects tokenscope-development, the left rejects
  // mytokenscope-dev. The space join keeps a token from spanning the two hosts.
  const m = `${bearer} ${otlp}`.match(/\btokenscope-(dev|sandbox|staging|production|prod)\b/)
  if (m) {
    const name = m[1] === 'production' ? 'prod' : m[1]
    return name.charAt(0).toUpperCase() + name.slice(1)
  }
  const isLocal = (h) => /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(h)
  if (isLocal(bearer) || isLocal(otlp)) return 'Local'
  // Unrecognised deployment — prefer the app/bearer host (cleaner than the DCE).
  return bearer || otlp
}

function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return {}
  }
}

/** Configured = the global device env carries our instance resource attr. */
function isConfigured(env) {
  const attrs = env?.OTEL_RESOURCE_ATTRIBUTES
  return typeof attrs === 'string' && attrs.includes('tokenscope.instance_id')
}

/**
 * MCP authed = Claude's credential store has an `.mcpOAuth` entry for the
 * TokenScope plugin MCP server (key `plugin:tokenscope:tokenscope` or
 * `plugin:tokenscope:tokenscope|<url>`). Cheap local read; fail-defensive → false.
 */
function isMcpAuthed() {
  let creds
  try {
    creds = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'))
  } catch {
    return false
  }
  const mcp = creds && typeof creds === 'object' ? creds.mcpOAuth : null
  if (!mcp || typeof mcp !== 'object') return false
  return Object.keys(mcp).some(
    (k) => k === 'plugin:tokenscope:tokenscope' || k.startsWith('plugin:tokenscope:tokenscope|'),
  )
}

/** The currently-configured instance id, from the emit resource attrs (or null). */
function instanceIdOf(env) {
  return (env?.OTEL_RESOURCE_ATTRIBUTES || '').match(/tokenscope\.instance_id=([^,]+)/)?.[1] || null
}

/**
 * Read the last-landed cache (`<state>/last-landed.json`) — the parsed object, or
 * null on any failure. landed-check.mjs writes it from the server /health response;
 * the always-on statusline only READS it here (never a synchronous network call).
 * classifyLanding() turns it into the render state.
 */
function readLandedCache() {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'last-landed.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Throttle: refresh the /health cache at most once per POLL_INTERVAL_MS. The
 * status line renders on EVERY prompt, so we must NOT poll each render — we gate
 * on the cache's `checkedAt` PLUS a `landed-poll.stamp` file bumped on every
 * spawn attempt (so a slow/in-flight refresh, which hasn't rewritten checkedAt
 * yet, doesn't make us re-spawn on the next few renders). 5 min matches the OTLP
 * export batch cadence — polling faster can't surface a landing sooner.
 */
export const POLL_INTERVAL_MS = 5 * 60 * 1000

/** The last spawn-attempt timestamp from the poll stamp file (or null). */
function readPollStamp() {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'landed-poll.stamp'), 'utf8'))?.at ?? null
  } catch {
    return null
  }
}

/**
 * Pure (given `stampAt`): a refresh is due only when the cache is older than the
 * interval AND no recent spawn attempt is still in flight. Tested directly.
 */
export function landedRefreshDue(cache, now = Date.now(), stampAt = readPollStamp()) {
  const freshEnough = (ts) => {
    const t = ts ? Date.parse(ts) : NaN
    return Number.isFinite(t) && now - t < POLL_INTERVAL_MS
  }
  if (cache && freshEnough(cache.checkedAt)) return false // cache still fresh
  return !freshEnough(stampAt) // else: due, unless a recent attempt is in flight
}

/**
 * Fire a THROTTLED, DETACHED background refresh of the /health cache. Never blocks
 * the render: we spawn landed-check.mjs unref'd (its own ~4s network timeout lives
 * in that process) and return immediately, so the NEXT render reads a fresh answer.
 * The stamp is written BEFORE the spawn so rapid renders during the network window
 * don't each spawn a duplicate. All best-effort — any failure is swallowed.
 */
function maybeSpawnLandedRefresh(env, cache) {
  try {
    if (!landedRefreshDue(cache)) return
    const dir = stateDir()
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'landed-poll.stamp'), `${JSON.stringify({ at: new Date().toISOString() })}\n`, {
        mode: 0o600,
      })
    } catch {
      /* stamp is best-effort; a failed write just means the throttle can't engage */
    }
    const script = join(dirname(fileURLToPath(import.meta.url)), 'landed-check.mjs')
    // landed-check reads OTEL_RESOURCE_ATTRIBUTES + TOKENSCOPE_BEARER_ENDPOINT from
    // its env, so pass the settings env merged over ours. It reads the emit access
    // token from the shared oauth-access.json cache — no secret is passed on argv.
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* never let a refresh attempt break the render */
  }
}

function main() {
  let out = ''
  try {
    const input = readStdinJson()
    const env = globalSettingsEnv()
    const configured = isConfigured(env)
    let landing = 'unknown'
    if (configured) {
      const cache = readLandedCache()
      landing = classifyLanding(cache, instanceIdOf(env))
      // Keep the /health cache fresh for the NEXT render — throttled + detached, so
      // this render never blocks on the network. Only when we have a live endpoint.
      if ((env.TOKENSCOPE_BEARER_ENDPOINT ?? '').trim()) maybeSpawnLandedRefresh(env, cache)
    }
    out = formatStatusLine({
      configured,
      // Emitting = configured AND no live failure sentinel (no sentinel = healthy).
      emitting: configured && !readEmitSentinel(),
      mcpAuthed: isMcpAuthed(),
      // Landing = the delivery-confirmation state derived from the cached /health.
      landing,
      sessionId: input.session_id ?? null,
      // Where this client emits OTel — derived from the configured endpoint.
      envLabel: configured ? emitEnvLabel(env) : null,
    })
  } catch {
    out = '' // never break the UI
  }
  process.stdout.write(out)
}

// Only run when invoked directly (not when imported by the unit test).
// fileURLToPath comparison (the pattern every other script here uses): the raw
// `file://${argv[1]}` template silently mismatches when the path percent-encodes
// (space or non-ASCII in $HOME) → main() never runs, status line blank, zero diagnostics.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
