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
 *   - readDeviceEnrolment — reads the instance id + helper command back out of
 *     the global config so the repo tag can self-heal against it (ADR-0006).
 *   - buildHelperCommand — the ONE producer of the `otelHeadersHelper` string.
 */
import { existsSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { assertHelperRecord } from './device-store.mjs'
import { helperScriptName, windowsPowerShellPath, DEFAULT_WINDOWS_POWERSHELL } from './emit-helper-spawn.mjs'

// One definition shared with the Node spawners; re-exported for existing importers.
export { helperScriptName }

const pathFor = (platform) => (platform === 'win32' ? win32 : posix)

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/*
 * Quoting for the shell that runs the command. Claude Code hands the string to
 * `sh` on POSIX and to `cmd.exe` on Windows, so a path with a space has to be
 * quoted for THAT shell, and anything the shell would still expand inside the
 * quotes has to be neutralised or refused. A bare token is used when nothing in
 * it needs quoting, which keeps `--state-dir /abs` readable.
 */
function quoteSh(value, { always = false } = {}) {
  if (CONTROL.test(value)) throw new Error('helper command value has a control character')
  if (!always && /^[A-Za-z0-9_./:@%+,=-]+$/.test(value)) return value
  // Inside double quotes `sh` still expands $, ` and \, and " ends the string.
  return `"${value.replace(/["\\$`]/g, '\\$&')}"`
}

function quoteCmd(value, { always = false } = {}) {
  if (CONTROL.test(value)) throw new Error('helper command value has a control character')
  // REFUSED rather than escaped: cmd.exe expands %VAR% even inside double quotes
  // and has no escape that works there, and `"` cannot appear in a Windows path.
  if (/["%]/.test(value)) throw new Error('helper command value has a character cmd.exe would rewrite')
  if (!always && /^[A-Za-z0-9_.\\/:@+,=-]+$/.test(value)) return value
  // A trailing backslash would escape the closing quote under the Windows argv
  // rules PowerShell parses with; doubling the run keeps it literal.
  return `"${value.replace(/(\\+)$/, '$1$1')}"`
}

/**
 * The `otelHeadersHelper` command for a helper record, run from `scriptsDir`
 * (the plugin install whose script it names).
 *
 * The ONLY producer of that string. Every writer (redeem, enrol, the
 * session-start self-heal, the repo pin) goes through it, so the state dir and
 * the platform choice cannot be dropped by one of four hand-built copies again
 * (#410). The record is `{ tool, platform, stateDir? }` (assertHelperRecord):
 *   POSIX:   "<scripts>/otel-headers-helper.sh" --tool <tool> [--state-dir <abs>]
 *   Windows: "<abs>\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass
 *              -File "<scripts>\otel-headers-helper.ps1" --tool <tool> [--state-dir <abs>]
 *
 * The Windows interpreter is an ABSOLUTE path, never the bare name. Claude Code
 * runs the value through cmd.exe, which looks in the current directory (the
 * repository) before PATH, and a repository can set PATH through its settings
 * env: a bare `powershell.exe` would let a repo choose the program that is
 * handed the refresh token every ~29 minutes. `powershell` overrides it for
 * tests; by default it is windowsPowerShellPath() on Windows, and the fixed
 * C:\Windows path when a win32 value is built elsewhere (only tests do).
 * claude-redeem.ps1 resolves it the same way.
 * Throws on a record or path it cannot express safely; the self-heal callers
 * treat that as "leave the value alone".
 */
export function buildHelperCommand(record, { scriptsDir, powershell } = {}) {
  const { tool, platform, stateDir } = assertHelperRecord(record)
  const p = pathFor(platform)
  if (typeof scriptsDir !== 'string' || !p.isAbsolute(scriptsDir)) {
    throw new Error('helper scripts dir is not an absolute path')
  }
  const quote = platform === 'win32' ? quoteCmd : quoteSh
  const script = quote(p.join(scriptsDir, helperScriptName(platform)), { always: true })
  const args = ['--tool', tool]
  if (stateDir !== undefined) args.push('--state-dir', quote(stateDir))
  const head =
    platform === 'win32'
      ? [quoteCmd(persistedPowerShell(powershell), { always: true }), ...PS_ARGS, script]
      : [script]
  return [...head, ...args].join(' ')
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
const PS_ARGS_TEXT = ` ${PS_ARGS.join(' ')} `
// The value written before the interpreter became absolute. Recognised only
// so the self-heal can rebuild it; never written.
const LEGACY_PS_PREFIX = `powershell.exe${PS_ARGS_TEXT}`
const ABS_POWERSHELL = /^[A-Za-z]:\\(?:[^"\\]+\\)*WindowsPowerShell\\v1\.0\\powershell\.exe$/i

function persistedPowerShell(powershell) {
  const file = powershell ?? (process.platform === 'win32' ? windowsPowerShellPath() : DEFAULT_WINDOWS_POWERSHELL)
  if (typeof file !== 'string' || !ABS_POWERSHELL.test(file)) {
    throw new Error('Windows PowerShell was not found at an absolute path')
  }
  return file
}

/** Where the script token starts after a PowerShell prefix (either shape), or 0. */
function powerShellPrefixLength(value) {
  if (value.startsWith(LEGACY_PS_PREFIX)) return LEGACY_PS_PREFIX.length
  if (!value.startsWith('"')) return 0
  const end = value.indexOf('"', 1)
  if (end < 0 || !ABS_POWERSHELL.test(value.slice(1, end))) return 0
  return value.startsWith(PS_ARGS_TEXT, end + 1) ? end + 1 + PS_ARGS_TEXT.length : 0
}

/** One quoted-or-bare token of `s` from index `i`: [value, nextIndex], or null. */
function readToken(s, i, kind) {
  if (s[i] === '"') {
    if (kind === 'cmd') {
      const end = s.indexOf('"', i + 1)
      if (end < 0) return null
      // Undo quoteCmd's doubling of a trailing backslash run.
      return [s.slice(i + 1, end).replace(/\\+$/, (run) => run.slice(run.length / 2)), end + 1]
    }
    let out = ''
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\' && j + 1 < s.length) out += s[++j]
      else if (s[j] === '"') return [out, j + 1]
      else out += s[j]
    }
    return null
  }
  let j = i
  while (j < s.length && s[j] !== ' ') j++
  return j > i ? [s.slice(i, j), j] : null
}

/**
 * Read back a helper command THIS plugin could have written, or null.
 *
 * Only for MIGRATING a value already on disk: which install it points at, and
 * which `--state-dir` it carries so the rebuild keeps it. New values are never
 * derived from a string. Recognised: the two shapes above, the Windows shape
 * with a bare `powershell.exe` (written before it became absolute; the
 * self-heal rebuilds it), and the pre-sprint bare path (which may contain spaces) with any `--tool` / `--state-dir` a
 * person added by hand. Anything else (an unknown or repeated flag, another
 * script) is null, and the caller leaves the value exactly as it is.
 *
 * Returns { script, scriptDir, tool?, stateDir? }.
 */
export function parseHelperCommand(value) {
  if (typeof value !== 'string' || !value || CONTROL.test(value)) return null
  let script
  let i
  let kind = 'sh'
  const psPrefix = powerShellPrefixLength(value)
  if (psPrefix) {
    kind = 'cmd'
    const t = readToken(value, psPrefix, kind)
    if (!t) return null
    ;[script, i] = t
  } else if (value.startsWith('"')) {
    const t = readToken(value, 0, kind)
    if (!t) return null
    ;[script, i] = t
  } else {
    const m = /^(.*?otel-headers-helper\.(?:sh|ps1))(?= |$)/.exec(value)
    if (!m) return null
    script = m[1]
    i = m[1].length
  }
  if (!/[\\/]otel-headers-helper\.(sh|ps1)$/.test(script)) return null
  const out = {
    script,
    // A Windows path keeps its own separator rules even when this runs on POSIX.
    scriptDir: (/^[A-Za-z]:[\\/]|^\\\\/.test(script) ? win32 : posix).dirname(script),
  }
  while (i < value.length) {
    if (value[i] === ' ') {
      i++
      continue
    }
    const flag = readToken(value, i, kind)
    if (!flag || value[flag[1]] !== ' ') return null
    const arg = readToken(value, flag[1] + 1, kind)
    if (!arg) return null
    const key = { '--tool': 'tool', '--state-dir': 'stateDir' }[flag[0]]
    if (!key || key in out) return null
    out[key] = arg[0]
    i = arg[1]
  }
  return out
}
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
 * `helper` is `{ record, scriptsDir }` (buildHelperCommand's inputs), or null to
 * leave `otelHeadersHelper` as it is. A string is refused: that was the old
 * signature, and a caller still passing one would write a command nobody built
 * from a record.
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
export function mergeClaudeSettings(existing, helper, envBlock, { replaceEnv = false } = {}) {
  if (typeof helper === 'string') throw new TypeError('mergeClaudeSettings takes { record, scriptsDir }, not a path')
  const settings = existing && typeof existing === 'object' ? { ...existing } : {}
  if (helper) settings.otelHeadersHelper = buildHelperCommand(helper.record, { scriptsDir: helper.scriptsDir })
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
 * the active `statuslinePath` / `scriptsDir`. Only paths that are clearly OURS are
 * touched (never a user's custom status line). Change-detecting → a no-op once
 * reconciled, so it never churns settings.json. Returns the (copied) settings +
 * whether anything changed.
 *
 * The helper is REBUILT with buildHelperCommand, never string-replaced (that
 * replace is what dropped a hand-added `--state-dir`, #410). See
 * reconcileHelperCommand for the record and the move rules. `recordFor(stateDir)`
 * returns the stored record for that state dir or null; `exists` is injectable
 * so the rules can be tested without building installs. `defaultStateDir` is
 * the state dir a value without `--state-dir` runs with (isHelperSnapshot).
 */
export function reconcilePluginPaths(
  existing,
  {
    statuslinePath,
    scriptsDir,
    platform = process.platform,
    recordFor = () => null,
    exists = existsSync,
    defaultStateDir,
  } = {},
) {
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

  const want = reconcileHelperCommand(settings.otelHeadersHelper, {
    scriptsDir,
    platform,
    recordFor,
    exists,
    defaultStateDir,
  })
  if (want !== null && want !== settings.otelHeadersHelper) {
    settings.otelHeadersHelper = want
    changed = true
  }

  return { settings, changed }
}

/**
 * Is `parsed` the emit-only helper SNAPSHOT claude-redeem.ps1 writes,
 * `<state>\helper\scripts\otel-headers-helper.ps1`, for the state dir the
 * value itself runs with (its `--state-dir`, else `defaultStateDir`)? A device
 * set up without Node runs that copy, which no plugin update refreshes; once
 * Node is installed the self-heal treats it as ours, and since it carries no
 * version it moves to the active install like any unversioned pin.
 */
function isHelperSnapshot(parsed, defaultStateDir) {
  const stateDir = parsed.stateDir ?? defaultStateDir
  if (typeof stateDir !== 'string' || !stateDir) return false
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(parsed.script)
  const p = windows ? win32 : posix
  const want = p.join(stateDir, 'helper', 'scripts', 'otel-headers-helper.ps1')
  const got = p.normalize(parsed.script)
  return windows ? want.toLowerCase() === got.toLowerCase() : want === got
}

/**
 * The command `current` should become, or null to leave it alone.
 *
 * Only a value parseHelperCommand recognises AND whose script is under one of
 * our plugin dirs, or is the emit-only snapshot (isHelperSnapshot), is ours to
 * rebuild. The record is the store's (`recordFor`,
 * which must agree with the value's own `--state-dir`), else the value's own
 * `--tool` / `--state-dir`: a pre-sprint device has no stored record, and its
 * state dir is preserved rather than dropped. The platform is always the
 * running one; that is what makes a Windows device move off the `.sh`.
 *
 * Which install it points at:
 *   - the ACTIVE one on a forward move (isForwardMove: newer, or an unversioned
 *     current healed to a versioned active), or when the current script is gone;
 *   - the SAME one when it is the active version, so the shape and platform
 *     still migrate without a version bump;
 *   - otherwise untouched. A downgraded plugin never rewrites a newer pin; it
 *     only repairs one whose script no longer exists.
 * A target script that does not exist is never written.
 */
export function reconcileHelperCommand(
  current,
  { scriptsDir, platform = process.platform, recordFor = () => null, exists = existsSync, defaultStateDir } = {},
) {
  const parsed = parseHelperCommand(current)
  if (!parsed || !(isOurPluginPath(parsed.script) || isHelperSnapshot(parsed, defaultStateDir))) return null
  const file = helperScriptName(platform)
  // NATIVE join for anything that touches the disk: the filesystem is the one
  // this runs on, whichever platform the command is being built for.
  const has = (dir) => {
    try {
      return Boolean(dir) && exists(join(dir, file))
    } catch {
      return false
    }
  }
  const curVer = pluginPathVersion(parsed.script)
  const actVer = scriptsDir ? pluginPathVersion(join(scriptsDir, file)) : null
  const broken = !exists(parsed.script)
  let dir = null
  if (has(scriptsDir) && (broken || isForwardMove(parsed.script, join(scriptsDir, file)))) dir = scriptsDir
  else if (!broken && curVer && actVer && curVer.join('.') === actVer.join('.') && has(parsed.scriptDir)) dir = parsed.scriptDir
  if (!dir) return null
  const stored = recordFor(parsed.stateDir)
  const tool = stored?.tool ?? parsed.tool ?? 'claude-code'
  const stateDir = stored ? stored.stateDir : parsed.stateDir
  try {
    return buildHelperCommand(
      { tool, platform, ...(stateDir !== undefined ? { stateDir } : {}) },
      { scriptsDir: dir },
    )
  } catch {
    return null // inexpressible on this platform: leave it rather than break it
  }
}

/**
 * Read the device session id + helper command back out of an enrolled GLOBAL
 * config. Returns { sessionId, helperCommand, env } or null if the config isn't
 * enrolled (no tokenscope.instance_id in OTEL_RESOURCE_ATTRIBUTES).
 * `helperCommand` is the raw `otelHeadersHelper` string: a COMMAND, not a path,
 * so read it with parseHelperCommand, never existsSync.
 */
export function readDeviceEnrolment(globalSettings) {
  const attrs = globalSettings?.env?.OTEL_RESOURCE_ATTRIBUTES
  if (typeof attrs !== 'string') return null
  const m = /(?:^|,)\s*tokenscope\.instance_id=([^,]+)/.exec(attrs)
  if (!m) return null
  return {
    sessionId: m[1].trim(),
    helperCommand:
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
