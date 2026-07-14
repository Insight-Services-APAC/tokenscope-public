/*
 * tag-repo — shared helpers for the PER-REPO tagging path ("B′" model),
 * used by both the project MCP prompt (explicit) and the SessionStart hook
 * (zero-touch). All purely LOCAL: no server call, no cookie.
 *
 * Resolving the project CODE comes from the repo's committed `.tokenscope`
 * (or an explicit arg). The CODE -> code_hash mapping is computed client-side
 * with sha256 (plain hex) to match the server's project.code_hash exactly
 * (server: createHash('sha256').update(code).digest('hex')).
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseTokenscope } from './tokenscope-reader.mjs'
import { buildRepoResourceAttrs, mergeClaudeSettings, readDeviceEnrolment } from './env-builder.mjs'

// The client-neutral resolver/hasher (computeCodeHash, resolveRepoProjectCode)
// was extracted into the syncable tokenscope-project.mjs (P0-2) so the Copilot
// forwarder can reuse the SAME derivation — Claude + Copilot MUST hash an
// identical `.tokenscope` to the same project.code_hash (drift = split
// attribution). Re-exported here so the long-standing Claude-side import surface
// (project-check.mjs, the SessionStart hook, the unit tests) is unchanged. The
// Claude-coupled helpers below (writeTokenscopeFile/writeRepoTag) stay here.
export { computeCodeHash, resolveRepoProjectCode } from './tokenscope-project.mjs'

/**
 * Write (create or update) ./.tokenscope so the project tag is committable and
 * travels with the repo. Sets project.code = `code`, preserving any existing
 * project.id/name + optional.* fields. Returns the path. This is what lets
 * the project MCP prompt be a single step (write the file + tag) instead
 * of asking the user to hand-author the YAML first.
 */
export function writeTokenscopeFile(cwd, code) {
  // The code must round-trip through tokenscope-reader: `#` is stripped as a
  // comment, `"` collides with the value quoting, and newlines split lines —
  // any of these would make a later (no-arg) read derive a DIFFERENT
  // project.code_hash than the one we tag with now, silently splitting the
  // repo's spend server-side. Reject them at write time with a clear error.
  if (!code || !String(code).trim()) {
    throw new Error('Project code is empty — pass the canonical project code (e.g. TokenScope-MVP) via the project MCP prompt or a committed .tokenscope.')
  }
  if (/[#"\r\n]/.test(code)) {
    throw new Error(
      `Project code ${JSON.stringify(code)} contains a character that does not round-trip in .tokenscope (#, ", or newline). Use the canonical project code.`,
    )
  }
  // Leading/trailing whitespace is stripped by the reader, so it would also
  // make a later read derive a different hash. The slash command trims its arg
  // already; this guards the exported function for any other caller.
  if (code !== String(code).trim()) {
    throw new Error(`Project code ${JSON.stringify(code)} has leading/trailing whitespace — trim it to the canonical code.`)
  }
  const path = join(cwd, '.tokenscope')
  let project = { code }
  let optional = {}
  if (existsSync(path)) {
    try {
      const parsed = parseTokenscope(path)
      project = { ...(parsed?.project ?? {}), code } // keep id/name, override code
      optional = parsed?.optional ?? {}
    } catch {
      /* unparseable — fall back to a minimal file */
    }
  }
  const lines = ['# TokenScope — commit this so the project tag travels with the repo.', 'project:']
  for (const [k, v] of Object.entries(project)) {
    if (v != null && v !== '') lines.push(`  ${k}: ${v}`)
  }
  // parseTokenscope reads optional fields (client/practice/...) at TOP LEVEL,
  // not nested under an `optional:` key — emit them that way so the file
  // round-trips through the reader.
  for (const [k, v] of Object.entries(optional)) {
    if (v != null && v !== '') lines.push(`${k}: ${v}`)
  }
  writeFileSync(path, lines.join('\n') + '\n', { encoding: 'utf8' })
  return path
}

/** Abs path to the GLOBAL ~/.claude/settings.json. */
export function globalSettingsPath() {
  return join(homedir(), '.claude', 'settings.json')
}

/**
 * Read the device enrolment (session id + helper path) from the GLOBAL config.
 * Returns { sessionId, helperPath } or null if not enrolled / unreadable.
 */
export function readGlobalEnrolment() {
  const path = globalSettingsPath()
  if (!existsSync(path)) return null
  let settings
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  return readDeviceEnrolment(settings)
}

// resolveRepoProjectCode moved to tokenscope-project.mjs (P0-2) and re-exported
// at the top of this file — see the export statement near the imports.

/**
 * Abs path to the otel-headers-helper.sh the repo pin should use.
 *
 * Prefer the CURRENTLY-ACTIVE plugin version: Claude sets CLAUDE_PLUGIN_ROOT to
 * the live plugin dir when the hook/command runs, so
 * $CLAUDE_PLUGIN_ROOT/scripts/otel-headers-helper.sh is the active version's
 * helper. Writing THAT into the repo pin is what lets a plain `/plugin update`
 * auto-apply to every tagged repo on its NEXT launch WITHOUT a re-enrol (closes
 * ADR-0006's version-pinned-helper future-work): the self-heal re-points the repo
 * at the new active version each launch. Old cache versions persist (verified
 * across 0.1.0-0.1.3 on 2026-06-06; NOT a guaranteed Claude-internal behavior), so
 * the one-launch lag inherent to the startup-frozen OTel env does not break emit in
 * practice. If a future Claude release prunes old versions on update, that lag
 * could break a running session until relaunch — ADR-0006's stable `current`
 * symlink would remove the dependency entirely. Re-enrol then drops to genuinely
 * rare events (revocation, the read-credential migration) rather than every upgrade.
 *
 * Fall back to the version-pinned path from the global enrolment (when
 * CLAUDE_PLUGIN_ROOT is unset OR its helper is missing — e.g. a partial install),
 * then to this module's own dir, so every context still resolves to a real helper.
 */
function resolveHelperPath(enrolment) {
  const active = process.env.CLAUDE_PLUGIN_ROOT
    ? join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts', 'otel-headers-helper.sh')
    : null
  if (active && existsSync(active)) return active
  if (enrolment?.helperPath) return enrolment.helperPath
  return join(dirname(fileURLToPath(import.meta.url)), 'otel-headers-helper.sh')
}

/**
 * Write the repo-local ./.claude/settings.local.json, overriding
 * OTEL_RESOURCE_ATTRIBUTES with the device session id + the repo's code_hash.
 *
 * SELF-HEALING (ADR-0006): the target is re-derived from the CURRENT global
 * enrolment on every call — the helper path, the full device env (endpoint,
 * exporter, bearer endpoint, OAuth/session credentials) and the instance id are
 * all copied from global *as they are now*, NOT a snapshot frozen at pin time.
 * That is what lets a plugin upgrade + re-enrol (which only touch global config)
 * reach a pinned repo on its next launch instead of leaving it on a stale,
 * silently-expiring credential.
 *
 * Claude applies the highest-precedence `env` by REPLACEMENT (not key-merge), so
 * the repo-local block must stay SELF-CONTAINED (full env copy, helper restated):
 * a repo-local env block carrying only the resource attrs would drop the
 * endpoint/bearer. The self-heal is achieved by copying the *current* global env
 * each launch, not by trimming the block.
 *
 * Idempotent + change-detecting: computes the target settings, compares against
 * the existing file's content, and writes ONLY when they differ (so a true
 * no-op leaves the file — and its mtime — untouched). Merges any unrelated local
 * settings keys and preserves the 0o600 mode.
 *
 * Returns { settingsPath, changed, healed }:
 *   - changed: whether the file was (re)written this call.
 *   - healed:  whether a stale pin was reconciled — i.e. the PREVIOUS repo env's
 *              helper path or instance differed from the current global one (a
 *              drift this rewrite just corrected). false when there was no
 *              previous repo env to compare or nothing drifted.
 */
export function writeRepoTag({ cwd, enrolment, codeHash }) {
  const helperPath = resolveHelperPath(enrolment)
  const claudeDir = join(cwd, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  const settingsPath = join(claudeDir, 'settings.local.json')

  let existing = {}
  let existingRaw = null
  if (existsSync(settingsPath)) {
    try {
      existingRaw = readFileSync(settingsPath, 'utf8')
      existing = JSON.parse(existingRaw)
    } catch {
      existing = {}
      existingRaw = null
    }
  }

  // Detect drift BEFORE we overwrite: did the previous repo env pin a different
  // helper path or a different instance than the current global one? If so this
  // rewrite IS the reconcile (ADR-0006 decision 3).
  let healed = false
  const prevEnv = existing && typeof existing.env === 'object' ? existing.env : null
  if (prevEnv) {
    const prevHelper = typeof existing.otelHeadersHelper === 'string' ? existing.otelHeadersHelper : null
    const prevInstance = parseInstanceId(prevEnv.OTEL_RESOURCE_ATTRIBUTES)
    healed = (prevHelper != null && prevHelper !== helperPath) || (prevInstance != null && prevInstance !== enrolment.sessionId)
  }

  // Target env: the WHOLE current device env, with OTEL_RESOURCE_ATTRIBUTES
  // overridden to carry the device sid + this repo's project.code_hash. We still
  // defensively strip any legacy tokenscope.read credential keys, so a global
  // config left over from a pre-cutover enrolment never copies that retired,
  // higher-privilege identity token at rest into every repo (the read credential
  // is gone — read now rides the MCP-client OAuth bearer, not settings env).
  const deviceEnv = { ...(enrolment.env ?? {}) }
  delete deviceEnv.TOKENSCOPE_READ_REFRESH_TOKEN
  delete deviceEnv.TOKENSCOPE_READ_CLIENT_ID
  const fullEnv = {
    ...deviceEnv,
    OTEL_RESOURCE_ATTRIBUTES: buildRepoResourceAttrs(enrolment.sessionId, codeHash),
  }
  // REPLACE the repo env wholesale (not additive) so a key the current global
  // stopped emitting — e.g. the now-removed legacy TOKENSCOPE_SESSION_TOKEN left
  // behind by a pre-OAuth enrolment — cannot survive as a dead credential at rest.
  // Top-level non-env keys (permissions, etc.) are still preserved by
  // mergeClaudeSettings. (MEDIUM-1)
  const target = mergeClaudeSettings(existing, helperPath, fullEnv, { replaceEnv: true })
  const targetRaw = JSON.stringify(target, null, 2) + '\n'

  // Change-detect: only write when the serialised content actually differs, so a
  // true no-op keeps the file/mtime stable.
  if (targetRaw === existingRaw) {
    return { settingsPath, changed: false, healed: false }
  }
  // Write-temp-then-rename so a concurrent SessionStart hook (the per-HOST shared
  // ~/.claude means multiple `claude` launches can race the same repo file) never
  // reads a half-written file — rename is atomic on the same filesystem. The temp
  // is created 0o600 (it carries the bearer/OAuth credentials); we also chmod the
  // landed file because writeFileSync's `mode` only applies on CREATE and a
  // pre-existing target could have looser perms. (LOW-B, mirrors
  // otel-headers-helper.sh's cache-write pattern.)
  const tmpPath = `${settingsPath}.tmp.${process.pid}`
  try {
    writeFileSync(tmpPath, targetRaw, { encoding: 'utf8', mode: 0o600 })
    chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, settingsPath)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      /* temp may not exist — best effort */
    }
    throw err
  }
  try {
    chmodSync(settingsPath, 0o600)
  } catch {
    /* best-effort hardening — never fail the tag over a chmod */
  }
  return { settingsPath, changed: true, healed: Boolean(healed) }
}

/** Extract tokenscope.instance_id from an OTEL_RESOURCE_ATTRIBUTES string, or null. */
function parseInstanceId(attrs) {
  if (typeof attrs !== 'string') return null
  const m = /(?:^|,)\s*tokenscope\.instance_id=([^,]+)/.exec(attrs)
  return m ? m[1].trim() : null
}

/**
 * Read the project.code_hash currently set in a repo-local settings.local.json,
 * or null. Informational only — it is NOT the hook's skip gate (the hook now
 * always calls writeRepoTag, which self-skips true no-ops). Per ADR-0006, a
 * hash match alone must never gate the rewrite, or a plugin upgrade / re-enrol
 * (which leaves the hash unchanged) would never reach a pinned repo.
 */
export function readRepoTaggedHash(cwd) {
  const settingsPath = join(cwd, '.claude', 'settings.local.json')
  if (!existsSync(settingsPath)) return null
  let settings
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    return null
  }
  const attrs = settings?.env?.OTEL_RESOURCE_ATTRIBUTES
  if (typeof attrs !== 'string') return null
  const m = /(?:^|,)\s*project\.code_hash=([^,]+)/.exec(attrs)
  return m ? m[1].trim() : null
}
