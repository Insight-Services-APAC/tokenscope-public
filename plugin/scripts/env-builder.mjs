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
 */
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
  return (
    typeof p === 'string' && /[\\/]plugins[\\/](cache|marketplaces)[\\/]tokenscope[\\/]/.test(p)
  )
}

/** The cache version [maj,min,patch] embedded in a tokenscope plugin path, or null
 * (e.g. the marketplace clone, which is unversioned). */
function pluginPathVersion(p) {
  const m =
    typeof p === 'string' && p.match(/[\\/]tokenscope[\\/]tokenscope[\\/](\d+)\.(\d+)\.(\d+)[\\/]/)
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
    if (
      settings.otelHeadersHelper !== helperPath &&
      isForwardMove(settings.otelHeadersHelper, helperPath)
    ) {
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
    helperPath:
      typeof globalSettings.otelHeadersHelper === 'string'
        ? globalSettings.otelHeadersHelper
        : null,
    // The full device env block (endpoint, exporter, bearer endpoint + OAuth emit
    // credential, resource attrs). The repo-local tag copies ALL of it (overriding
    // only OTEL_RESOURCE_ATTRIBUTES) so it's self-contained — Claude applies the
    // highest-precedence `env` by REPLACEMENT, not key-merge, so a repo-local
    // env block carrying only the resource attrs would drop the endpoint/bearer.
    env: globalSettings.env && typeof globalSettings.env === 'object' ? globalSettings.env : null,
  }
}
