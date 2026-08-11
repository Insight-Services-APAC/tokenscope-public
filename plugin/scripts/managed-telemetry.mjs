/*
 * managed-telemetry.mjs — client-side detector for GitHub Copilot CLI's
 * enterprise-managed `telemetry` settings (docs/design/usage-completeness-and-
 * provider-governance.md §10.1). Dependency-free (Node builtins only; NO imports
 * from plugin/scripts/*) so it survives being copied verbatim into the standalone
 * copilot-plugin distribution (scripts/sync-copilot-plugin.mjs) — a second,
 * hand-maintained detector for the Copilot lane is exactly what this project's
 * "one correct implementation, reached, never duplicated" convention forbids.
 *
 * WHY THIS EXISTS. A managed `telemetry` block can silently kill Copilot's file
 * exporter while the emit credential still mints a bearer `200` — the exact
 * false-healthy trap a valid-but-undelivered credential already is. `status` and
 * `setup` must be able to say "your credential is fine AND enterprise policy is
 * blocking export" rather than read a healthy credential probe as emission-healthy.
 *
 * AUTHORITATIVE SOURCE. Verified directly against the installed CLI's own merge
 * logic (`app.js`, the `Rgr`/`q3t`-shaped functions in CLI 1.0.73/1.0.75) AND
 * GitHub's own published reference + 2026-07-08 changelog:
 *   - `Rgr(t)`: a managed `telemetry` block is "live" iff it sets ANY of `enabled`,
 *     `endpoint`, `protocol`, `headers`, `resourceAttributes`, `captureContent`,
 *     `lockCaptureContent`, `serviceName`.
 *   - `q3t(t, e)`: `enabled === false` (explicit) forces telemetry OFF, unoverridable.
 *     `endpoint !== undefined || headers !== undefined` forces `exporterType` to
 *     `"otlp-http"` and DISCARDS `filePath` outright — the file exporter dies even
 *     though `COPILOT_OTEL_FILE_EXPORTER_PATH` is still set. Every other key
 *     (`resourceAttributes`, `serviceName`, `captureContent`, `lockCaptureContent`,
 *     `protocol`, `enabled: true`) is compatible with the file exporter.
 *   - Delivery channels + precedence (github.blog/changelog/2026-07-08-...): Native
 *     MDM > Server-managed > File-based. File-based reads a `managed-settings.json`
 *     from a well-known path per OS; native MDM is Windows registry
 *     (`HKEY_LOCAL_MACHINE\SOFTWARE\Policies\GitHubCopilot`) or macOS managed
 *     preferences (`com.github.copilot`) — NOT implemented on Linux at all (GitHub
 *     ships no native-MDM channel there).
 *
 * WHAT THIS CANNOT SEE. Server-managed settings resolve via the developer's
 * SIGNED-IN account against an enterprise `.github-private` repo — the CLI fetches
 * this itself, authenticated, over the network. A local script has no equivalent
 * access and must not guess; every result names this limitation explicitly
 * (`serverManagedNote`) rather than silently treating "file+MDM only" as the whole
 * picture. This mirrors this project's own coverage-denominator honesty: absence of
 * a signal is reported as unknown, never as a confirmed "none".
 *
 * NEVER PRINT HEADER CONTENTS (or any other config value). Every result/message
 * this module produces is a boolean/enum/path — never `telemetry.headers`,
 * `telemetry.endpoint`, or any other field's actual value.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/** Keys whose presence makes a managed `telemetry` block "live" (Rgr). */
const TELEMETRY_KEYS = [
  'enabled',
  'endpoint',
  'protocol',
  'headers',
  'resourceAttributes',
  'captureContent',
  'lockCaptureContent',
  'serviceName',
]

/** Keys that force the exporter away from the file lane regardless of `enabled` (q3t). */
const HOSTILE_ENDPOINT_KEYS = ['endpoint', 'headers']

/**
 * Classify ONE resolved `telemetry` object (the HIGHEST-precedence managed block
 * found) into the four-state vocabulary. Pure — no I/O, no platform dependence.
 *
 *   - 'none'    — not a plain object, or none of TELEMETRY_KEYS are set (Rgr false).
 *   - 'hostile' — enabled===false, or endpoint/headers set (q3t's file-exporter kill).
 *   - 'benign'  — live (Rgr true) but neither hostile condition holds.
 *
 * @param {unknown} telemetry
 * @returns {'hostile'|'benign'|'none'}
 */
export function classifyTelemetryBlock(telemetry) {
  if (!telemetry || typeof telemetry !== 'object' || Array.isArray(telemetry)) return 'none'
  const t = /** @type {Record<string, unknown>} */ (telemetry)
  const live = TELEMETRY_KEYS.some((k) => t[k] !== undefined)
  if (!live) return 'none'
  if (t.enabled === false) return 'hostile'
  if (HOSTILE_ENDPOINT_KEYS.some((k) => t[k] !== undefined)) return 'hostile'
  return 'benign'
}

/**
 * Safe, VALUE-FREE booleans describing a telemetry block — for building messages
 * that never echo an endpoint URL or header contents, only presence.
 *
 * @param {unknown} telemetry
 * @returns {Record<string, boolean>}
 */
export function describeTelemetryBlock(telemetry) {
  const t = telemetry && typeof telemetry === 'object' && !Array.isArray(telemetry) ? /** @type {Record<string, unknown>} */ (telemetry) : {}
  /** @type {Record<string, boolean>} */
  const out = {}
  for (const k of TELEMETRY_KEYS) out[`${k}Set`] = t[k] !== undefined
  out.enabledExplicitlyFalse = t.enabled === false
  return out
}

/** The well-known FILE-BASED managed-settings.json path for one platform (GitHub's
 *  own 2026-07-08 changelog). Pure — platform is passed in for testability.
 *  @param {NodeJS.Platform} platformName
 *  @returns {string} */
export function wellKnownFileBasedPath(platformName) {
  if (platformName === 'darwin') return '/Library/Application Support/GitHubCopilot/managed-settings.json'
  if (platformName === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    return `${programFiles}\\GitHubCopilot\\managed-settings.json`
  }
  return '/etc/github-copilot/managed-settings.json' // Linux + other POSIX
}

/**
 * @typedef {{ present: boolean, telemetry?: unknown, error?: 'unreadable'|'invalid-json' }} FileReadResult
 */

/**
 * Read + parse ONE managed-settings.json-shaped file. Never throws.
 *   - absent (ENOENT)              → { present: false }                (a clean "not configured")
 *   - present, unreadable (perms)  → { present: true, error: 'unreadable' }
 *   - present, not valid JSON      → { present: true, error: 'invalid-json' }
 *   - present, parses              → { present: true, telemetry: parsed.telemetry }
 *
 * @param {string} path
 * @param {{ exists?: (p: string) => boolean, readFile?: (p: string) => string }} [deps]
 * @returns {FileReadResult}
 */
export function readManagedSettingsFile(path, deps = {}) {
  const exists = deps.exists ?? existsSync
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'))
  if (!exists(path)) return { present: false }
  let raw
  try {
    raw = readFile(path)
  } catch {
    return { present: true, error: 'unreadable' }
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { present: true, error: 'invalid-json' }
    return { present: true, telemetry: /** @type {Record<string, unknown>} */ (parsed).telemetry }
  } catch {
    return { present: true, error: 'invalid-json' }
  }
}

/**
 * Parse `reg query "HKLM\...\GitHubCopilot"` output into a flat map of value names
 * to their string values. Windows native-MDM scalar settings use their
 * dot-separated key directly (github.blog/changelog/2026-07-08), e.g.
 * `telemetry.enabled`, `telemetry.endpoint` — so this is already the shape we need,
 * no nested-object reconstruction required. Pure — operates on captured text.
 *
 * @param {string} regOutput
 * @returns {Record<string, string>}
 */
export function parseWindowsRegistryOutput(regOutput) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of regOutput.split(/\r?\n/)) {
    // "    telemetry.enabled    REG_SZ    false"
    const m = /^\s*(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line)
    if (m) out[m[1]] = m[3].trim()
  }
  return out
}

/** Build a nested `telemetry` object from the flat `telemetry.*` registry values.
 *  Boolean-shaped string values ("true"/"false") are coerced; everything else stays
 *  a string (structured values like `enabledPlugins` are JSON-string-encoded per the
 *  changelog, but `telemetry` carries no structured sub-key, so this stays simple).
 *  @param {Record<string, string>} flat
 *  @returns {Record<string, unknown>|undefined} */
export function telemetryFromFlatKeys(flat) {
  const prefix = 'telemetry.'
  const keys = Object.keys(flat).filter((k) => k.startsWith(prefix))
  if (keys.length === 0) return undefined
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const k of keys) {
    const shortKey = k.slice(prefix.length)
    const v = flat[k]
    out[shortKey] = v === 'true' ? true : v === 'false' ? false : v
  }
  return out
}

/**
 * Best-effort Windows native-MDM read (registry). Never throws.
 * @param {{ exec?: (cmd: string, args: string[]) => string }} [deps]
 * @returns {{ status: 'present', telemetry: unknown } | { status: 'none' } | { status: 'unknown' }}
 */
function readWindowsNativeMdm(deps = {}) {
  const exec = deps.exec ?? ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true }))
  let out
  try {
    out = exec('reg', ['query', 'HKLM\\SOFTWARE\\Policies\\GitHubCopilot', '/s'])
  } catch (err) {
    // `reg query` exits non-zero when the key does not exist — a clean "no policy".
    // Any OTHER failure (reg.exe missing, permission denied) is genuinely unknown.
    const status = /** @type {{ status?: number }} */ (err)?.status
    return status === 1 ? { status: 'none' } : { status: 'unknown' }
  }
  const flat = parseWindowsRegistryOutput(out)
  const telemetry = telemetryFromFlatKeys(flat)
  return telemetry === undefined ? { status: 'none' } : { status: 'present', telemetry }
}

/**
 * Best-effort macOS native-MDM read (managed preferences, `com.github.copilot`).
 * `defaults read` emits an OLD-STYLE plist text dump, not JSON — reliably parsing
 * arbitrary nesting without a real plist parser is out of scope, so this ONLY
 * confirms presence/absence of the domain (a clean, unambiguous signal) and
 * classifies the CONTENT as unknown rather than risk a wrong hostile/benign call
 * from a hand-rolled parse. Never throws.
 * @param {{ exec?: (cmd: string, args: string[]) => string }} [deps]
 * @returns {{ status: 'present-unparsed' } | { status: 'none' } | { status: 'unknown' }}
 */
function readMacosNativeMdm(deps = {}) {
  const exec = deps.exec ?? ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }))
  try {
    exec('defaults', ['read', 'com.github.copilot'])
    return { status: 'present-unparsed' }
  } catch (err) {
    const message = String(/** @type {{ message?: string }} */ (err)?.message ?? '')
    // `defaults read` on a domain with no preferences prints "...does not exist" and
    // exits 1 — the clean, unambiguous "no managed prefs" signal.
    if (/does not exist/i.test(message)) return { status: 'none' }
    return { status: 'unknown' }
  }
}

/**
 * @typedef {{
 *   classification: 'hostile'|'benign'|'none'|'unknown',
 *   source: 'native-mdm'|'file-based'|'none'|'unknown',
 *   checkedPaths: string[],
 *   serverManagedNote: string,
 *   details: Record<string, boolean>,
 * }} ManagedTelemetryResult
 */

/**
 * Detect + classify the enterprise-managed `telemetry` setting from every LOCALLY
 * checkable channel, applying GitHub's own documented precedence (native MDM >
 * server-managed [undetectable here] > file-based). Never throws; every failure
 * mode degrades to a classified, safe result. NEVER returns/logs a raw config value
 * — only booleans, an enum, and file paths (never file CONTENTS beyond what
 * `describeTelemetryBlock` reduces to presence booleans).
 *
 * @param {{
 *   platform?: NodeJS.Platform,
 *   exists?: (p: string) => boolean,
 *   readFile?: (p: string) => string,
 *   exec?: (cmd: string, args: string[]) => string,
 * }} [opts]
 * @returns {Promise<ManagedTelemetryResult>}
 */
export async function detectManagedTelemetry(opts = {}) {
  const platformName = opts.platform ?? process.platform
  const serverManagedNote =
    'Server-managed settings (a signed-in account against an enterprise .github-private repo) cannot be read from this local script — only native-MDM and file-based channels are checked. If your enterprise uses server-managed telemetry settings, this result may under-report.'

  // 1. Native MDM (highest precedence) — platform-specific, best-effort.
  /** @type {{ status: string, telemetry?: unknown }} */
  let mdm = { status: 'none' }
  if (platformName === 'win32') {
    mdm = readWindowsNativeMdm(opts)
  } else if (platformName === 'darwin') {
    mdm = readMacosNativeMdm(opts)
  }
  // Linux has no native-MDM channel at all per GitHub's docs — 'none' by construction.

  if (mdm.status === 'present') {
    const classification = classifyTelemetryBlock(mdm.telemetry)
    return {
      classification,
      source: 'native-mdm',
      checkedPaths: ['native-mdm:registry-or-preferences'],
      serverManagedNote,
      details: describeTelemetryBlock(mdm.telemetry),
    }
  }
  if (mdm.status === 'present-unparsed') {
    // A managed prefs domain exists but we cannot safely parse its content — unknown,
    // never guessed as hostile or benign.
    return {
      classification: 'unknown',
      source: 'unknown',
      checkedPaths: ['native-mdm:com.github.copilot'],
      serverManagedNote,
      details: describeTelemetryBlock(undefined),
    }
  }
  if (mdm.status === 'unknown') {
    return {
      classification: 'unknown',
      source: 'unknown',
      checkedPaths: ['native-mdm'],
      serverManagedNote,
      details: describeTelemetryBlock(undefined),
    }
  }

  // 2. File-based (well-known path, all platforms).
  const filePath = wellKnownFileBasedPath(platformName)
  const file = readManagedSettingsFile(filePath, opts)
  if (file.error) {
    return {
      classification: 'unknown',
      source: 'unknown',
      checkedPaths: [filePath],
      serverManagedNote,
      details: describeTelemetryBlock(undefined),
    }
  }
  if (file.present) {
    const classification = classifyTelemetryBlock(file.telemetry)
    return {
      classification,
      source: 'file-based',
      checkedPaths: [filePath],
      serverManagedNote,
      details: describeTelemetryBlock(file.telemetry),
    }
  }

  // 3. Every locally-checkable channel cleanly absent — 'none', authoritatively.
  return {
    classification: 'none',
    source: 'none',
    checkedPaths: [filePath],
    serverManagedNote,
    details: describeTelemetryBlock(undefined),
  }
}
