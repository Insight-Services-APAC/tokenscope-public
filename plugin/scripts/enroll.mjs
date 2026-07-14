/*
 * enroll — emit-on-install enrollment for the privately-distributed Insight
 * plugin (docs/design/emit-on-install-provisional-attribution.md §Flows 1).
 *
 * On a FRESH install of the real (publish-injected) plugin, the SessionStart hook
 * calls enrollIfNeeded() so this very session starts emitting WITHOUT any login:
 * the plugin presents its bundled enrollment secret + the Claude user's email to
 * POST /api/v1/setup/enroll, and writes the returned emit-only credential + OTel
 * plumbing into ~/.claude/settings.json using the SAME writer the redeem flow uses
 * (claude-redeem's assert → buildEnv → writeClaudeSettings). Usage then attributes
 * PROVISIONALLY to the claimed email until the human signs in and confirms.
 *
 * It is a strict NO-OP unless ALL of these hold, so it never re-enrols, never
 * clobbers a real credential, and never fires for an un-injected dev checkout:
 *   - the device is NOT already enrolled (no existing OAuth emit credential), AND
 *   - a bundled enrollment secret IS configured (publish-injected, not the
 *     placeholder), AND
 *   - we can determine a real claimed email (never guessed).
 *
 * Best-effort + fail-OPEN throughout: a short timeout, and every failure path
 * returns a reason rather than throwing — the SessionStart hook must never break
 * the user's session over enrolment.
 *
 * EMAIL SOURCE (the claim): ~/.claude.json → oauthAccount.emailAddress — the email
 * Claude Code itself authenticated with. This is exactly "the email Claude Code
 * already knows" the design relies on, and it is the unit the server's
 * confirm-on-auth merge later matches against. The SessionStart hook's stdin
 * payload (session_id / cwd / source / transcript_path) carries NO email, so it is
 * not a source. Fallback: `git config user.email` (the repo's configured identity)
 * if Claude's oauth email is unavailable. If neither yields an `@` address we SKIP
 * enrolment rather than claim a bad email.
 *
 * DEVICE BINDING (a server-side dedup hint only — NOT an auth factor; the server
 * HMAC-hashes it at rest): a stable per-host id = `<hostname>:<machine-id>`, where
 * machine-id is /etc/machine-id when present, else ~/.claude.json machineID, else
 * just the hostname. Per-host matches the instance model (the enrolment lives in
 * the shared ~/.claude/settings.json, so all containers on a host share it).
 */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolveApiBase } from './api-base.mjs'
import { httpsPostJson, resolveHelperPath } from './plugin-runtime.mjs'
// Reuse the redeem flow's validation + env-builder + atomic 0600 writer VERBATIM
// (the enroll response shape mirrors /setup/redeem), so the OTel/emit env +
// otelHeadersHelper land exactly like a redeem — one writer, one contract.
import { assertClaudeRedeemResponse, buildClaudeDeviceEnv, writeClaudeSettings } from './claude-redeem.mjs'
import { resolveEnrollmentSecret } from './enrollment-secret.mjs'

// Bound the enroll POST so a network blackhole can't hang session startup (the
// SessionStart hook has a 10s budget shared with the emit probe + landed refresh).
const ENROLL_TIMEOUT_MS = 4000

/**
 * True if `env` already carries a complete emit enrolment — a durable OAuth
 * refresh token AND a bearer endpoint AND a non-empty instance id in the resource
 * attrs. When enrolled we must NEVER re-enrol (it would mint a second provisional
 * instance) or clobber the existing (possibly redeemed/confirmed) credential.
 */
export function isEnrolled(env = {}) {
  const hasRefresh = Boolean((env.TOKENSCOPE_OAUTH_REFRESH_TOKEN ?? '').trim())
  const hasBearer = Boolean((env.TOKENSCOPE_BEARER_ENDPOINT ?? '').trim())
  const attrs = env.OTEL_RESOURCE_ATTRIBUTES
  // A `tokenscope.instance_id=` with an empty value is as unenrolled as absent.
  const hasInstance = typeof attrs === 'string' && /tokenscope\.instance_id=[^,\s]/.test(attrs)
  return hasRefresh && hasBearer && hasInstance
}

/**
 * Determine the claimed email for the enrol, or null if none is trustworthy.
 * Source order documented in the module header. NEVER guesses — a missing email
 * skips enrolment rather than claiming a wrong identity.
 */
export function readClaimedEmail({ cwd = process.cwd(), home = homedir() } = {}) {
  // 1. The email Claude Code authenticated with — authoritative.
  try {
    const j = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    const e = j?.oauthAccount?.emailAddress
    if (typeof e === 'string' && e.includes('@')) return e.trim()
  } catch {
    /* no ~/.claude.json / not parseable — fall through */
  }
  // 2. Fallback: the repo's configured git identity.
  try {
    const e = execFileSync('git', ['config', 'user.email'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (e.includes('@')) return e
  } catch {
    /* no git / no configured identity */
  }
  return null
}

/**
 * A stable per-host device-binding hint. The server treats this as an opaque
 * dedup key (HMAC-hashed at rest), never an auth factor, so a best-effort stable
 * value is sufficient.
 */
export function computeDeviceBinding({ home = homedir() } = {}) {
  let machineId = ''
  try {
    machineId = readFileSync('/etc/machine-id', 'utf8').trim()
  } catch {
    /* not a systemd host — try Claude's own machine id */
  }
  if (!machineId) {
    try {
      const j = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
      if (typeof j?.machineID === 'string') machineId = j.machineID.trim()
    } catch {
      /* ignore */
    }
  }
  return machineId ? `${hostname()}:${machineId}` : hostname()
}

/**
 * Enrol this device for emit-on-install IFF it is a fresh install of the real
 * (publish-injected) plugin. Returns { enrolled, reason?, instanceId? }; never
 * throws (fail-open). Dependencies are injectable for unit testing.
 *
 * @param {{
 *   env?: Record<string,string>,
 *   settingsPath?: string,
 *   apiBase?: string|null,
 *   enrollmentSecret?: string,
 *   claimedEmail?: string|null,
 *   deviceBinding?: string,
 *   timeoutMs?: number,
 *   post?: typeof httpsPostJson,
 *   writeSettings?: typeof writeClaudeSettings,
 *   helperPath?: string,
 * }} [opts]
 */
export async function enrollIfNeeded({
  env = {},
  settingsPath = join(homedir(), '.claude', 'settings.json'),
  apiBase = null,
  enrollmentSecret = resolveEnrollmentSecret(),
  claimedEmail = undefined,
  deviceBinding = undefined,
  timeoutMs = ENROLL_TIMEOUT_MS,
  post = httpsPostJson,
  writeSettings = writeClaudeSettings,
  helperPath = undefined,
} = {}) {
  // 1. Already enrolled — never re-enrol / never clobber an existing credential.
  if (isEnrolled(env)) return { enrolled: false, reason: 'already-enrolled' }

  // 2. No bundled secret (un-injected dev build) — only the real distributed
  //    plugin enrols. Trim-guarded inside resolveEnrollmentSecret.
  if (!enrollmentSecret) return { enrolled: false, reason: 'no-secret' }

  // 3. Need a trustworthy claimed email — never guess.
  const email = claimedEmail === undefined ? readClaimedEmail() : claimedEmail
  if (!email) return { enrolled: false, reason: 'no-email' }

  // 4. Resolve the enroll URL from the configured api base.
  const base = resolveApiBase(apiBase)
  const url = `${base}/api/v1/setup/enroll`
  if (!url.startsWith('http')) return { enrolled: false, reason: 'no-base' }

  // 5. POST best-effort (bounded). A failure here must stay silent.
  const binding = deviceBinding === undefined ? computeDeviceBinding() : deviceBinding
  let resp
  try {
    resp = await post(url, { enrollment_secret: enrollmentSecret, claimed_email: email, device_binding: binding }, { timeoutMs })
  } catch {
    return { enrolled: false, reason: 'post-failed' }
  }

  // 6. Validate + write via the SAME path redeem uses — assert guarantees a
  //    usable bundle with a non-empty instance id + a complete OAuth credential
  //    before we touch settings.json (so we never write a half-config).
  try {
    const { claude, oauth } = assertClaudeRedeemResponse(resp)
    const envBlock = buildClaudeDeviceEnv(claude, oauth)
    writeSettings(settingsPath, helperPath ?? resolveHelperPath(), envBlock)
  } catch {
    return { enrolled: false, reason: 'write-failed' }
  }

  return { enrolled: true, instanceId: resp.instance_id }
}
