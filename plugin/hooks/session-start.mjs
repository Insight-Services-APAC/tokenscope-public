#!/usr/bin/env node
/*
 * SessionStart hook — two jobs, both fail-OPEN (a hook must never break the
 * user's session):
 *
 *  1. ZERO-TOUCH REPO TAGGING ("B′" model). If (a) this device is enrolled and
 *     (b) the cwd's repo has a committed `.tokenscope` with a project.code,
 *     reconcile the repo-local ./.claude/settings.local.json from the CURRENT
 *     global enrolment (ADR-0006 self-heal) so the NEXT `claude` launch is tagged.
 *     OTel resource attrs are frozen at process startup, so this can't re-tag the
 *     RUNNING session — it prepares the next one.
 *
 *  2. PROACTIVE EMISSION-HEALTH WARNING (ADR-0006 residual). The whole point of
 *     TokenScope is "track every token" — a developer must NOT have to ASK whether
 *     they're emitting and discover silent breakage only by running
 *     /tokenscope:status. On session start we surface a visible `systemMessage` on
 *     a DEFINITE auth failure, and stay SILENT on a transient/unverifiable failure
 *     (network blip — the exporter keeps its last bearer) so it never cries wolf.
 *
 *     It runs the REAL emit path (the helper) and warns only on a LIVE,
 *     retry-surviving failure. It does NOT trust a pre-existing sentinel (a
 *     stale/transient one — e.g. a superseded-cache 401 the helper self-heals on
 *     retry, or a since-resolved failure — would cry wolf), and it does NOT
 *     throttle on a prior-success stamp (that would MASK a credential that died
 *     inside the window). Both shortcuts traded correctness for a saved network
 *     call; the probe is cheap (cached ~30-day access token → a single /bearer
 *     GET), so we always run the live, self-healing check.
 *
 * Fail-OPEN throughout: any error exits 0 with no output, and a warning is the
 * ONLY thing ever written to stdout (a SessionStart hook's top-level
 * `systemMessage` is shown to the developer; `additionalContext` goes to the
 * model). No credential/token material is ever written to stdout or stderr.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { resolveRepoProjectCode, computeCodeHash, readGlobalEnrolment, writeRepoTag } from '../scripts/tag-repo.mjs'
import { reconcilePluginPaths, applyOtlpProxyRepoint, otlpForwarderPath, mergeClaudeSettings, otlpProxyStashMissing } from '../scripts/env-builder.mjs'
import { readSettingsEnv, readEmitSentinel, runEmitHelper, stateDir } from '../scripts/plugin-runtime.mjs'
import { refreshLanded } from '../scripts/landed-check.mjs'
import { checkRepoProjectBillable } from '../scripts/project-check.mjs'
import { enrollIfNeeded } from '../scripts/enroll.mjs'

// This hook always runs at the ACTIVE plugin version (its command uses
// ${CLAUDE_PLUGIN_ROOT}), so its own dir locates the active scripts.
const HOOK_DIR = dirname(fileURLToPath(import.meta.url))

// Bound the active probe so a network blackhole can't hang session startup.
const PROBE_TIMEOUT_MS = 4000

/**
 * Job 0: repoint OUR version-pinned GLOBAL settings paths (statusLine.command,
 * otelHeadersHelper) to the ACTIVE plugin version. `/plugin update` leaves them
 * pinned at the version they were written, so an old renderer (cosmetic) or — far
 * worse — a stale bearer-minting helper (emission dies if that cache version is
 * GC'd) lingers. Change-detecting + atomic; fail-OPEN. The new paths take effect
 * on the NEXT launch (Claude reads these at startup), so this self-heals within
 * one relaunch of any update. Idempotent once reconciled.
 */
export function selfHealPluginPaths({
  settingsPath = join(homedir(), '.claude', 'settings.json'),
  scriptsDir = resolve(HOOK_DIR, '..', 'scripts'),
} = {}) {
  if (!existsSync(settingsPath)) return
  let raw
  try {
    raw = readFileSync(settingsPath, 'utf8')
  } catch {
    return
  }
  let settings
  try {
    settings = JSON.parse(raw)
  } catch {
    return // unparseable — NEVER clobber (would wipe the emit credential)
  }
  // Only ever repoint to a target that actually exists — never create a phantom path.
  const statuslinePath = join(scriptsDir, 'statusline.mjs')
  const helperPath = join(scriptsDir, 'otel-headers-helper.sh')
  const { settings: next, changed } = reconcilePluginPaths(settings, {
    statuslinePath: existsSync(statuslinePath) ? statuslinePath : null,
    helperPath: existsSync(helperPath) ? helperPath : null,
  })
  if (!changed) return
  // Atomic temp+rename, mode 0600 (settings.json carries the durable emit credential).
  const tmp = `${settingsPath}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600) // defeat umask (match claude-redeem / statusline-toggle)
    // Compare-and-swap: if another writer (redeem / statusline toggle) changed the
    // file since we read it, abort rather than clobber a freshly-written credential.
    // The next launch self-heals again.
    if (readFileSync(settingsPath, 'utf8') !== raw) {
      rmSync(tmp, { force: true })
      return
    }
    renameSync(tmp, settingsPath)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore cleanup failure */
    }
  }
}

/** Job 1: reconcile the repo-local tag from the current global enrolment. */
function selfHealRepoTag() {
  const cwd = process.cwd()
  const enrolment = readGlobalEnrolment()
  if (!enrolment) return // device not enrolled — nothing to do

  let resolved
  try {
    resolved = resolveRepoProjectCode({ arg: '', cwd }) // .tokenscope only in hook context
  } catch {
    return // no .tokenscope / no project.code — leave untagged
  }
  if (resolved.source !== 'tokenscope') return

  const codeHash = computeCodeHash(resolved.code)
  // EXISTING enrolments self-heal onto the local Content-Length forwarder (CC
  // #72671) on next session without a re-redeem: re-point the enrolment's logs
  // endpoint (and stash the real DCE URL) before it's copied into the repo tag.
  // Idempotent + kill-switch-gated (TOKENSCOPE_OTLP_PROXY=0). Fail-open — the
  // enclosing try in main() swallows any error, and writeRepoTag still runs on
  // the (unchanged) env if the re-point throws.
  if (enrolment.env) applyOtlpProxyRepoint(enrolment.env)
  // SELF-HEAL (ADR-0006): always re-derive from the CURRENT global enrolment.
  // writeRepoTag is change-detecting, so a true no-op leaves the file untouched.
  writeRepoTag({ cwd, enrolment, codeHash })
}

const OTLP_PORT = Number(process.env.TOKENSCOPE_OTLP_PROXY_PORT) || 14318

/**
 * PURE self-heal decision (extracted for tests). Given the /healthz probe outcome and
 * the stateDir THIS session expects, decide what to do with whatever holds the port:
 *   - probe `'refused'`  → nothing listening → spawn.
 *   - probe `'hung'`     → bound but not answering /healthz → kill the pidfile owner + spawn.
 *   - probe `{ok,pid,dir}` → answering: if `dir` matches ours it is healthy (leave it);
 *     otherwise it is a STALE forwarder (a prior run under a leaked HOME resolving a
 *     different stateDir/config — the recurring silent-drop) → kill its pid + spawn.
 * The old port-bind-only guard could not tell "listening" from "listening but broken",
 * so a wedged forwarder kept the port forever and every export 502'd unnoticed.
 */
export function decideForwarderAction(probe, expectedDir) {
  if (probe === 'refused') return { action: 'spawn' }
  if (probe === 'hung') return { action: 'spawn', killPidfile: true }
  if (probe && probe.ok && probe.dir === expectedDir) return { action: 'healthy' }
  if (probe && typeof probe.pid === 'number') return { action: 'spawn', killPid: probe.pid }
  return { action: 'spawn' } // malformed response → best-effort respawn
}

/** GET /healthz → the forwarder's `{ok,pid,dir}`, or `'refused'` / `'hung'`. Bounded. */
function probeForwarder(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 700 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString())
          resolve(j && j.ok ? j : 'hung')
        } catch {
          resolve('hung')
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve('hung')
    })
    req.on('error', (e) => resolve(e && e.code === 'ECONNREFUSED' ? 'refused' : 'hung'))
  })
}

function killPid(pid) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* already gone — or another user's process (permission denied) */
  }
}

/**
 * Confirm a pid is ACTUALLY a forwarder before we SIGTERM it (Linux /proc). A stale
 * pidfile could otherwise point at a recycled pid; without /proc we can't verify, so
 * we fail SAFE (return false → do not kill). The dir-mismatch path never needs this —
 * there the pid came straight from the forwarder's own /healthz response.
 */
function isLikelyForwarder(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('otlp-forwarder')
  } catch {
    return false
  }
}

/** Kill the forwarder whose pidfile sits in `dir` (the hung-instance path — no /healthz). */
function killForwarderPidfile(dir) {
  try {
    const pid = Number(readFileSync(join(dir, 'otlp-forwarder.pid'), 'utf8').trim())
    if (pid > 0 && isLikelyForwarder(pid)) killPid(pid)
  } catch {
    /* no pidfile → nothing we can safely target; the spawn below EADDRINUSE-exits */
  }
}

/**
 * (b) Ensure a HEALTHY local OTLP Content-Length forwarder (CC #72671) is running.
 * Detached + unref'd so it outlives the hook. SELF-HEALING: probes /healthz and, unless
 * the forwarder answers AND resolved OUR stateDir, replaces it (killing a wedged/stale
 * owner first) — the port bind alone can't distinguish a working forwarder from a
 * bound-but-broken one, which is how telemetry silently vanished. Kill-switch:
 * TOKENSCOPE_OTLP_PROXY=0. Only runs when enrolled. Fail-open (never breaks session start).
 */
async function spawnOtlpForwarder() {
  if (process.env.TOKENSCOPE_OTLP_PROXY === '0') return
  if (!readGlobalEnrolment()) return // not enrolled — nothing to forward
  const dir = stateDir()
  // Lock the state dir owner-only EVERY enrolled session (mkdirSync(mode) is ignored on
  // an existing dir; this tightens installs that predate the mode arg).
  try {
    chmodSync(dir, 0o700)
  } catch {
    /* best-effort */
  }
  const scriptsDir = resolve(HOOK_DIR, '..', 'scripts')
  const scriptPath = otlpForwarderPath(scriptsDir)
  if (!existsSync(scriptPath)) return // partial install — never spawn a phantom path

  const decision = decideForwarderAction(await probeForwarder(OTLP_PORT), dir)
  if (decision.action === 'healthy') return
  if (typeof decision.killPid === 'number') killPid(decision.killPid)
  if (decision.killPidfile) killForwarderPidfile(dir)
  // Let a killed owner release the port before the fresh one binds.
  if (decision.killPid != null || decision.killPidfile) await new Promise((r) => setTimeout(r, 250))

  const child = spawn(process.execPath, [scriptPath], { detached: true, stdio: 'ignore' })
  child.on('error', () => {}) // fail-open: never break session start over a spawn error
  child.unref()
}

/**
 * Re-point the GLOBAL ~/.claude/settings.json logs endpoint onto the local
 * forwarder (CC #72671). The repo-tag self-heal only reaches TAGGED repos;
 * UNTAGGED repos read the global env directly, so without this they'd keep the
 * raw DCE endpoint → chunked → still broken. applyOtlpProxyRepoint is reversible,
 * so the kill-switch (TOKENSCOPE_OTLP_PROXY=0) restores the global back to the
 * direct DCE here too. IDEMPOTENT: writes ONLY when the endpoint actually changed
 * (never churns the global every session). Atomic temp+rename, 0600 (the file
 * carries the emit credential); fail-OPEN. Returns nothing.
 */
export function selfHealGlobalOtlpEndpoint({
  settingsPath = join(homedir(), '.claude', 'settings.json'),
} = {}) {
  if (!existsSync(settingsPath)) return
  let raw
  try {
    raw = readFileSync(settingsPath, 'utf8')
  } catch {
    return
  }
  let settings
  try {
    settings = JSON.parse(raw)
  } catch {
    return // unparseable — NEVER clobber (would wipe the emit credential)
  }
  const before = settings?.env?.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  if (typeof before !== 'string' || !before.trim()) return // not enrolled — nothing to re-point
  // Reconcile a COPY of the env so we can compare and skip a no-op write.
  const nextEnv = applyOtlpProxyRepoint({ ...settings.env })
  if (nextEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === before) return // no change — do not churn
  // Additive merge keeps every other env key + all top-level keys (permissions,
  // otelHeadersHelper, statusLine); only the endpoint moves.
  const next = mergeClaudeSettings(settings, null, nextEnv)
  const tmp = `${settingsPath}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600) // defeat umask (match selfHealPluginPaths / claude-redeem)
    // Compare-and-swap: abort if another writer changed the file since we read it.
    if (readFileSync(settingsPath, 'utf8') !== raw) {
      rmSync(tmp, { force: true })
      return
    }
    renameSync(tmp, settingsPath)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore cleanup failure */
    }
  }
}

/** HTTP status from a sentinel, or null. */
function sentinelHttp(sentinel) {
  return sentinel && Number.isFinite(sentinel.http_status) ? sentinel.http_status : null
}

function warnFor(http) {
  // Classify like status.mjs's interpretEmissionProbe: an auth failure (401/403/
  // 404) means the emit credential lapsed or the instance is unknown — re-provision
  // it; a 5xx/other is likely a transient server-side issue, so do NOT steer the
  // developer to churn their instance id over a blip.
  if (http === 401 || http === 403 || http === 404) {
    return `⚠ TokenScope: your Claude telemetry is NOT emitting — emission auth failed (HTTP ${http}). Spend is going untracked this session. Run /tokenscope:status; the credential likely lapsed or the instance is unknown — re-provision emit via the tokenscope-setup MCP prompt.`
  }
  return `⚠ TokenScope: your Claude telemetry may not be emitting (HTTP ${http}) — likely a transient server-side issue. Run /tokenscope:status to confirm; spend may be going untracked this session.`
}

/**
 * Job 2: decide whether to warn. Returns a warning string, or null (healthy,
 * not-enrolled, throttled-healthy, or only transiently unverifiable).
 */
function emissionHealthWarning() {
  const cwd = process.cwd()
  // The env the NEXT launch will use: global device env overlaid with the
  // repo-local env the self-heal just reconciled (Claude merges the same way).
  const env = {
    ...readSettingsEnv(join(homedir(), '.claude', 'settings.json')),
    ...readSettingsEnv(join(cwd, '.claude', 'settings.local.json')),
  }
  const endpoint = (env.TOKENSCOPE_BEARER_ENDPOINT ?? '').trim()
  const hasOAuth = Boolean(
    (env.TOKENSCOPE_OAUTH_REFRESH_TOKEN ?? '').trim() &&
      (env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT ?? '').trim() &&
      (env.TOKENSCOPE_OAUTH_CLIENT_ID ?? '').trim(),
  )
  if (!endpoint || !hasOAuth) return null // not enrolled — don't nag

  // Run the REAL emit path once (bounded). We do NOT short-circuit on a
  // pre-existing sentinel: it can be STALE — a superseded-cache 401 the helper now
  // self-heals on retry (0.1.6), or a since-resolved failure — so trusting it
  // would cry wolf. The helper IS the live, self-healing source of truth; run it.
  const { ran, status } = runEmitHelper({ env: { ...process.env, ...env }, timeoutMs: PROBE_TIMEOUT_MS })
  if (!ran) return null
  // Exit 0 = healthy (the helper only exits 0 via the /bearer-200 path, which mints
  // a bearer + clears the sentinel). A null exit = killed (timeout) before
  // completing → couldn't verify. BOTH stay silent, and crucially we do NOT read
  // the sentinel in either case — so a STALE sentinel (a prior or since-resolved
  // failure) can never cry wolf. Only a genuine NON-ZERO exit code means the helper
  // ran and failed THIS run, writing a fresh sentinel (adversarial R: MEDIUM-1).
  if (status === 0 || status === null) return null
  // Live failure (even after the helper's in-run retry). Warn only on a DEFINITE
  // auth failure (http > 0); a network error (fresh sentinel http 0) stays SILENT.
  const http = sentinelHttp(readEmitSentinel(env))
  if (http && http !== 0) return warnFor(http)
  return null
}

/**
 * Build the wrong-env project-tag warning from a checkRepoProjectBillable result,
 * or null. Warns ONLY on an explicit 'not-billable' (the firewall already made
 * every other status silent). Hedges on point-in-time membership (names the env,
 * doesn't assert a permanent misconfig) so it never cries wolf during membership
 * propagation, and points at the re-tag action.
 */
function projectBillabilityWarning(result) {
  if (!result || result.status !== 'not-billable') return null
  const code = result.code ? `“${result.code}”` : "this repo’s .tokenscope project"
  const projects = (result.yourProjects || []).map((p) => p && p.code).filter(Boolean)
  const hint = projects.length ? ` Budgets you can bill: ${projects.join(', ')}.` : ''
  return `⚠ TokenScope: ${code} is not a budget you can currently bill on this environment — spend this session is landing UNTAGGED. Re-tag with the project MCP prompt (/tokenscope:project).${hint}`
}

/**
 * CC #72671 durability warning: when the logs endpoint is pinned to the local
 * forwarder but its DCE stash is missing/unreadable (a wiped/ephemeral
 * ~/.tokenscope, a HOME/TOKENSCOPE_STATE_DIR divergence, or a settings.json copied
 * without its state dir), the forwarder 502s on every export AND the kill-switch
 * cannot self-revert (the real DCE lives only in the stash). That silent wedge is
 * the one state this fail-open design must fail LOUD on. Returns a warning string,
 * or null when healthy / not pinned. Reads the SAME merged env Claude will use.
 */
function otlpForwarderStashWarning() {
  const cwd = process.cwd()
  const env = {
    ...readSettingsEnv(join(homedir(), '.claude', 'settings.json')),
    ...readSettingsEnv(join(cwd, '.claude', 'settings.local.json')),
  }
  if (!otlpProxyStashMissing(env)) return null
  return `⚠ TokenScope: telemetry is routed through the local OTLP forwarder but its DCE stash (~/.tokenscope/otlp-forward.json) is missing — emission is failing this session and cannot self-revert. Re-provision emit via the tokenscope-setup MCP prompt to restore it.`
}

async function main() {
  try {
    selfHealPluginPaths()
  } catch {
    /* fail-open */
  }

  try {
    selfHealRepoTag()
  } catch {
    /* fail-open */
  }

  try {
    selfHealGlobalOtlpEndpoint() // CC #72671: cover UNTAGGED repos (global env)
  } catch {
    /* fail-open */
  }

  try {
    await spawnOtlpForwarder() // CC #72671 Content-Length workaround (self-healing)
  } catch {
    /* fail-open */
  }

  // EMIT-ON-INSTALL (slice 6): on a FRESH install of the real (publish-injected)
  // plugin, enrol now — BEFORE the emit probe + landed refresh below — so this very
  // session starts emitting with no login. A no-op when already enrolled or when no
  // bundled secret is configured (dev). Writes the credential into settings.json,
  // which the probe + landed refresh then re-read from disk and exercise. Fail-open.
  try {
    const cwd = process.cwd()
    const env = {
      ...readSettingsEnv(join(homedir(), '.claude', 'settings.json')),
      ...readSettingsEnv(join(cwd, '.claude', 'settings.local.json')),
    }
    await enrollIfNeeded({ env })
  } catch {
    /* fail-open: never break session start over enrolment */
  }

  // Collect session-start warnings into ONE systemMessage: (1) emission health and
  // (2) a wrong-env project tag (the repo's .tokenscope isn't billable where the
  // device emits → spend spills untagged). Both fail-open — our own errors never warn.
  const lines = []
  try {
    const w = emissionHealthWarning() // also runs the emit helper → refreshes the token
    if (w) lines.push(w)
  } catch {
    /* fail-open: never warn on our own error */
  }

  try {
    const w = otlpForwarderStashWarning() // CC #72671: pinned-but-stash-missing wedge
    if (w) lines.push(w)
  } catch {
    /* fail-open */
  }

  // With the emit token now fresh, refresh the landed cache (for the statusline's
  // real green `✓ landed`) AND check project billability CONCURRENTLY — both bounded,
  // best-effort, under the same merged env. project-check warns ONLY on an explicit
  // not-billable; every other path (offline, unauth, no-tag, errors) is silent.
  try {
    const cwd = process.cwd()
    const env = {
      ...readSettingsEnv(join(homedir(), '.claude', 'settings.json')),
      ...readSettingsEnv(join(cwd, '.claude', 'settings.local.json')),
    }
    const hasBearer = Boolean((env.TOKENSCOPE_BEARER_ENDPOINT ?? '').trim())
    const [, projectResult] = await Promise.all([
      hasBearer ? refreshLanded({ env }).catch(() => null) : Promise.resolve(null),
      hasBearer ? checkRepoProjectBillable({ env, cwd }).catch(() => null) : Promise.resolve(null),
    ])
    const projectWarning = projectBillabilityWarning(projectResult)
    if (projectWarning) lines.push(projectWarning)
  } catch {
    /* fail-open — the statusline simply stays ◎ emit-auth */
  }

  if (lines.length) {
    const systemMessage = lines.join('\n\n')
    process.stdout.write(
      JSON.stringify({
        systemMessage,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `TokenScope session-start checks: ${systemMessage}`,
        },
      }),
    )
  }
}

// Exported for unit tests (the pure-ish warning helpers).
export { emissionHealthWarning, warnFor, sentinelHttp, projectBillabilityWarning }

// CLI entry guard: run the hook ONLY when invoked as the entry script (Claude's
// SessionStart). Importing the module (unit tests) must NOT run main / exit.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  // AWAIT the full async chain before exiting: emit-on-install enrol POST + the
  // landed refresh are async, and a fresh install must finish enrolling (and then
  // probe/refresh against the new credential) within this one session. The hook's
  // own 10s timeout bounds it. Fail-open — any rejection still exits 0.
  main()
    .catch(() => {
      /* Fail-open: never break the session. */
    })
    .finally(() => process.exit(0))
}
