/*
 * env-builder — pure builders for the per-repo OTel tag config + the TokenScope
 * status-line settings helpers.
 *
 * The GLOBAL device env block (otelHeadersHelper path + the OAuth emit credential
 * + the OTLP plumbing) is now written by the MCP provision_emit → /setup/redeem
 * flow, NOT by this module. What remains here is what the LOCAL plugin scripts
 * still need:
 *
 *   - REPO  ./.claude/settings.local.json — per-repo tag (written by the
 *     SessionStart hook via tag-repo.mjs): overrides OTEL_RESOURCE_ATTRIBUTES
 *     with the device instance id PLUS the repo's project.code_hash.
 *   - the status-line install/remove helpers (statusline-toggle.mjs).
 *   - readDeviceEnrolment — reads the instance id + helper path back out of the
 *     global config so the repo tag can self-heal against it (ADR-0006).
 *   - applyOtlpProxyRepoint — re-points OTEL_EXPORTER_OTLP_LOGS_ENDPOINT at the
 *     local Content-Length forwarder (CC #72671 workaround), stashing the real
 *     DCE URL for the forwarder to read.
 */
import { writeFileSync, renameSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './plugin-runtime.mjs'

/**
 * Resource-attr string for a REPO tag (repo-local config): the device session id
 * PLUS the project's code_hash. Matches the server's attested-token attrs ordering
 * (sid, project.code_hash, tool) so the join key is identical either side.
 */
export function buildRepoResourceAttrs(sessionId, projectCodeHash) {
  return `tokenscope.instance_id=${sessionId},project.code_hash=${projectCodeHash},tool=claude-code`
}

/**
 * Merge our helper + env block into any pre-existing settings JSON.
 *
 * Top-level non-`env` keys (e.g. `permissions`) are always preserved. The `env`
 * block is handled per `replaceEnv`:
 *   - false (default): ADDITIVE key-merge onto the existing env.
 *   - true: REPLACE the env block wholesale with `envBlock` — used by the repo
 *     pin (writeRepoTag), which must re-derive env from the CURRENT global
 *     enrolment each launch (ADR-0006 self-heal). A key the current global no
 *     longer emits (e.g. a legacy session token after migrating to OAuth) must
 *     NOT survive in the repo file — an additive merge would leave it at rest.
 */
export function mergeClaudeSettings(existing, helperPath, envBlock, { replaceEnv = false } = {}) {
  const settings = existing && typeof existing === 'object' ? { ...existing } : {}
  if (helperPath) settings.otelHeadersHelper = helperPath
  settings.env = replaceEnv ? { ...envBlock } : { ...(settings.env ?? {}), ...envBlock }
  return settings
}

/** The TokenScope status-line config (emission health + session id). */
export function tokenscopeStatusLine(statuslinePath) {
  return { type: 'command', command: `node ${JSON.stringify(statuslinePath)}`, padding: 0 }
}

/** True if `settings.statusLine` is TokenScope's (so we can refresh/remove only OUR own). */
function isOurStatusLine(statusLine) {
  return Boolean(
    statusLine &&
      typeof statusLine === 'object' &&
      typeof statusLine.command === 'string' &&
      statusLine.command.includes('statusline.mjs'),
  )
}

/** True if `p` is one of OUR plugin's script paths (under a tokenscope plugin dir),
 * so the self-heal only ever repoints paths we own — never a user's custom one. */
function isOurPluginPath(p) {
  return typeof p === 'string' && /[\\/]plugins[\\/](cache|marketplaces)[\\/]tokenscope[\\/]/.test(p)
}

/** The cache version [maj,min,patch] embedded in a tokenscope plugin path, or null
 * (e.g. the marketplace clone, which is unversioned). */
function pluginPathVersion(p) {
  const m = typeof p === 'string' && p.match(/[\\/]tokenscope[\\/]tokenscope[\\/](\d+)\.(\d+)\.(\d+)[\\/]/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True if it's safe to repoint `currentPath` → `activePath`. Only move FORWARD so
 * two instances on different plugin versions sharing one home can't ping-pong (an
 * older instance never downgrades a newer pin). An UNVERSIONED active (the
 * marketplace-clone layout) never overwrites anything — otherwise it would flip a
 * versioned pin back and forth with a cache-run peer. A versioned active may still
 * heal an unversioned/weird current. */
function isForwardMove(currentPath, activePath) {
  const act = pluginPathVersion(activePath)
  if (!act) return false // unknown active version — never overwrite a pin with it
  const cur = pluginPathVersion(currentPath)
  if (!cur) return true // current is unversioned/weird — heal it to the known active
  for (let i = 0; i < 3; i++) if (act[i] !== cur[i]) return act[i] > cur[i]
  return false // identical version — nothing to move
}

/**
 * Install TokenScope's status line into a settings object. NON-CLOBBER by
 * default: only set it when there is no status line, or the existing one is
 * already ours (refresh its path). A user's OWN custom status line is preserved
 * unless `force` (the explicit `/tokenscope:statusline on`). Returns the new
 * settings + whether it installed.
 */
export function installStatusLine(existing, statuslinePath, { force = false } = {}) {
  const settings = existing && typeof existing === 'object' ? { ...existing } : {}
  const current = settings.statusLine
  if (!current || isOurStatusLine(current) || force) {
    settings.statusLine = tokenscopeStatusLine(statuslinePath)
    return { settings, installed: true }
  }
  return { settings, installed: false } // a non-TokenScope status line — leave it be
}

/** Remove TokenScope's status line (only if it's ours). Returns settings + whether removed. */
export function removeStatusLine(existing) {
  const settings = existing && typeof existing === 'object' ? { ...existing } : {}
  if (isOurStatusLine(settings.statusLine)) {
    delete settings.statusLine
    return { settings, removed: true }
  }
  return { settings, removed: false }
}

/**
 * Repoint OUR version-pinned settings paths to the ACTIVE plugin version.
 *
 * Claude bakes absolute, version-pinned cache paths into the GLOBAL settings.json
 * — `statusLine.command` (at install) and `otelHeadersHelper` (at redeem) — and
 * `/plugin update` NEVER rewrites them. So after an update they keep pointing at a
 * stale cache version: cosmetic for the status line (an old renderer), but
 * emission-CRITICAL for otelHeadersHelper (the bearer-minting script) — if that
 * old cache version is ever garbage-collected, telemetry silently stops. The
 * SessionStart hook runs at the active version and calls this to reconcile both to
 * the active `statuslinePath` / `helperPath`. Only paths that are clearly OURS are
 * touched (never a user's custom status line). Change-detecting → a no-op once
 * reconciled, so it never churns settings.json. Returns the (copied) settings +
 * whether anything changed.
 */
export function reconcilePluginPaths(existing, { statuslinePath, helperPath }) {
  const settings = existing && typeof existing === 'object' ? { ...existing } : {}
  let changed = false

  const sl = settings.statusLine
  if (statuslinePath && isOurStatusLine(sl) && isOurPluginPath(sl.command)) {
    const wantCommand = tokenscopeStatusLine(statuslinePath).command
    if (sl.command !== wantCommand && isForwardMove(sl.command, statuslinePath)) {
      settings.statusLine = { ...sl, command: wantCommand }
      changed = true
    }
  }

  if (helperPath && isOurPluginPath(settings.otelHeadersHelper)) {
    if (settings.otelHeadersHelper !== helperPath && isForwardMove(settings.otelHeadersHelper, helperPath)) {
      settings.otelHeadersHelper = helperPath
      changed = true
    }
  }

  return { settings, changed }
}

/**
 * Read the device session id + helper path back out of an enrolled GLOBAL config.
 * Returns { sessionId, helperPath } or null if the config isn't enrolled (no
 * tokenscope.instance_id in OTEL_RESOURCE_ATTRIBUTES).
 */
export function readDeviceEnrolment(globalSettings) {
  const attrs = globalSettings?.env?.OTEL_RESOURCE_ATTRIBUTES
  if (typeof attrs !== 'string') return null
  const m = /(?:^|,)\s*tokenscope\.instance_id=([^,]+)/.exec(attrs)
  if (!m) return null
  return {
    sessionId: m[1].trim(),
    helperPath: typeof globalSettings.otelHeadersHelper === 'string' ? globalSettings.otelHeadersHelper : null,
    // The full device env block (endpoint, exporter, bearer endpoint + OAuth emit
    // credential, resource attrs). The repo-local tag copies ALL of it (overriding
    // only OTEL_RESOURCE_ATTRIBUTES) so it's self-contained — Claude applies the
    // highest-precedence `env` by REPLACEMENT, not key-merge, so a repo-local
    // env block carrying only the resource attrs would drop the endpoint/bearer.
    env: globalSettings.env && typeof globalSettings.env === 'object' ? globalSettings.env : null,
  }
}

// ── OTLP Content-Length forwarder re-point (CC #72671 workaround) ──────────────
const OTLP_PROXY_PORT = Number(process.env.TOKENSCOPE_OTLP_PROXY_PORT) || 14318
const OTLP_PROXY_ENDPOINT = `http://127.0.0.1:${OTLP_PROXY_PORT}/v1/logs`

/** True if a URL's host is the local loopback (already the proxy — don't re-stash). */
function isLoopbackHost(urlStr) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase()
    return h === '127.0.0.1' || h === 'localhost' || h === '::1'
  } catch {
    return false
  }
}

/** Read the stashed real DCE URL from ~/.tokenscope/otlp-forward.json, or null. */
function readStashedDce() {
  try {
    const { dceLogsEndpoint } = JSON.parse(readFileSync(join(stateDir(), 'otlp-forward.json'), 'utf8'))
    return typeof dceLogsEndpoint === 'string' && dceLogsEndpoint.trim() ? dceLogsEndpoint : null
  } catch {
    return null
  }
}

/**
 * Reconcile OTEL_EXPORTER_OTLP_LOGS_ENDPOINT with the local Content-Length
 * forwarder (CC #72671) — FULLY REVERSIBLE so the kill-switch reverts cleanly on
 * the next session with no re-redeem. MUTATES + returns `env`. Four cases:
 *
 *   ON (default), endpoint IS a real DCE → stash the DCE URL (atomic, 0600) +
 *     set the endpoint to the local proxy (the forward direction).
 *   ON, endpoint already the proxy → no-op (do NOT overwrite the stash with the
 *     proxy's own address, which would create a self-referential loop).
 *   OFF (TOKENSCOPE_OTLP_PROXY=0), endpoint IS the proxy + a stashed DCE exists →
 *     RESTORE the endpoint to the stashed DCE (reverts global + repo-local to
 *     direct once Claude Code is fixed). The stash file is kept so re-enabling
 *     doesn't need a re-redeem.
 *   OFF, endpoint is a real DCE (or no stash) → no-op.
 *
 * No logs endpoint at all (fresh/partial enrolment) → no-op in every case.
 */
export function applyOtlpProxyRepoint(env) {
  if (!env || typeof env !== 'object') return env
  const current = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  if (typeof current !== 'string' || !current.trim()) return env
  const killed = process.env.TOKENSCOPE_OTLP_PROXY === '0'
  const atProxy = isLoopbackHost(current)

  if (killed) {
    // Reverse: only when currently pointed AT the proxy and we have the DCE stashed.
    if (atProxy) {
      const dce = readStashedDce()
      if (dce) env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = dce
    }
    return env
  }

  if (atProxy) return env // already the proxy — leave the stash intact

  const dir = stateDir()
  const stashPath = join(dir, 'otlp-forward.json')
  mkdirSync(dir, { recursive: true, mode: 0o700 }) // lock the state dir (owner-only)
  const tmp = `${stashPath}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify({ dceLogsEndpoint: current }) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, stashPath) // atomic on the same filesystem
  env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = OTLP_PROXY_ENDPOINT
  return env
}

/** Absolute path to the bundled forwarder script, resolved from a scripts dir. */
export function otlpForwarderPath(scriptsDir) {
  return join(scriptsDir, 'otlp-forwarder.mjs')
}

/**
 * CC #72671 durability guard. True ONLY when the logs endpoint is pinned to the
 * local forwarder but the DCE stash it relays to is missing/unreadable — the one
 * state that wedges emission SILENTLY: the forwarder 502s on every export, and the
 * kill-switch cannot revert (the real DCE lives only in the stash). Once pinned,
 * applyOtlpProxyRepoint short-circuits at the `atProxy` no-op and never rewrites
 * the stash, so a later stash loss (wiped/ephemeral ~/.tokenscope, HOME divergence,
 * a settings.json copied without its state dir) has no self-heal. Lets session-start
 * fail LOUD instead of dropping telemetry into a black hole. `env` is a merged
 * settings env block; returns false for every healthy / not-pinned state.
 */
export function otlpProxyStashMissing(env) {
  const ep = env && typeof env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === 'string' ? env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT : ''
  if (!isLoopbackHost(ep)) return false // not routed through the forwarder — nothing to guard
  return !readStashedDce()
}
