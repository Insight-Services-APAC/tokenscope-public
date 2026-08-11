/*
 * enroll (Copilot CLI) — emit-on-install enrollment for the privately-distributed
 * Insight Copilot plugin (docs/design/emit-on-install-provisional-attribution.md
 * §Flows 1). The Copilot analogue of plugin/scripts/enroll.mjs (the Claude half).
 *
 * On a FRESH install of the real (publish-injected) plugin, the SessionStart hook
 * (forwarder-lifecycle.mjs `start`) calls enrollIfNeeded() so this very session can
 * start emitting WITHOUT any login: the plugin presents its bundled enrollment
 * secret + a claimed email to POST /api/v1/setup/enroll, and writes the returned
 * emit-only credential + the forwarder's config into ~/.tokenscope/config.json
 * (mode 0600, atomic temp+rename) using the SAME on-disk shape the redeem flow
 * writes (copilot-redeem's writeTokenscopeConfig). Usage then attributes
 * PROVISIONALLY to the claimed email until the human signs in and confirms.
 *
 * It is a strict NO-OP unless ALL of these hold, so it never re-enrols, never
 * clobbers a real credential, and never fires for an un-injected dev checkout:
 *   - the device is NOT already enrolled (no complete emit credential in
 *     ~/.tokenscope/config.json), AND
 *   - a bundled enrollment secret IS configured (publish-injected, not the
 *     placeholder), AND
 *   - we can determine a real claimed email (never guessed).
 *
 * Best-effort + fail-OPEN throughout: a short timeout, and every failure path
 * returns a reason rather than throwing — the SessionStart hook must never break
 * the user's session over enrolment, and must not delay the forwarder spawn.
 *
 * EMAIL SOURCE (the claim) — DELIBERATELY DIFFERENT from the Claude half. Claude
 * reads ~/.claude.json → oauthAccount.emailAddress (the email Claude Code itself
 * authenticated with). Copilot CLI has NO such app-managed OAuth email file the
 * plugin can read, so the source order here is:
 *   1. `git config user.email` (the repo / global git identity) — the email the
 *      developer commits as; the closest stable "email this device already knows".
 *   2. ~/.copilot/config.json (or apps.json) — IF Copilot ever persists an email
 *      there, use it (best-effort, schema-tolerant scan for an `@` string value).
 * The hook's invocation carries NO email, so it is not a source. If neither yields
 * an `@` address we SKIP enrolment rather than claim a bad identity. The claimed
 * email is just a PROVISIONAL attribution hint the server reconciles on first
 * human sign-in (slice 5) — it is never an auth factor — so git identity is a
 * sound, low-risk source for it.
 *
 * DEVICE BINDING (a server-side dedup hint only — NOT an auth factor; the server
 * HMAC-hashes it at rest): a stable per-host id = `<hostname>:<machine-id>`, where
 * machine-id is /etc/machine-id when present, else just the hostname. Per-host
 * matches the instance model (all containers on a host share the home → one
 * instance).
 *
 * STANDALONE: this file imports nothing from plugin/scripts/* — the copilot-plugin
 * ships independently (like copilot-redeem.mjs, it inlines its own HTTP + api-base
 * + config IO). It reads ~/.tokenscope/config.json inline; it does NOT introduce a
 * shared config-reader module.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import https from 'node:https'
import http from 'node:http'
import { resolveEnrollmentSecret } from './enrollment-secret.mjs'
// Span emission is armed via the SAME relative-path mechanism as the manual redeem —
// reuse it so emit-on-install and `copilot-redeem` agree on the on-disk contract.
// assertSafeRedeemBundle (S2) is REACHED here too, not re-implemented: enroll.mjs
// already imports from this vendored sibling, so validating the server-supplied
// endpoint bundle before it is persisted uses the SAME check copilot-redeem.mjs's
// own redeem path uses (both write onto the identical ~/.tokenscope/config.json
// contract, so they must agree on what "safe" means).
import {
  armOtelExporterRc,
  detectShellRcTargets,
  PROJECT_LOCAL_DIR,
  assertSafeRedeemBundle,
} from './copilot-redeem.mjs'
// endpoint-guard.mjs (S1/S2) — the ONE endpoint validator, vendored verbatim (see
// scripts/sync-copilot-plugin.mjs). Never write a second one; import it here too,
// same as landed-check.mjs and status.mjs.
import { assertSafeEndpoint } from './endpoint-guard.mjs'
// mcp-origin.mjs — the ONE resolver for "where is the MCP server actually
// registered", vendored verbatim like endpoint-guard.mjs. Used here so the enrol
// door resolves its destination from user-scope config rather than from the
// environment; see resolveApiBase below.
import { discoverMcpOrigin } from './mcp-origin.mjs'
// managed-telemetry.mjs (Workstream D §10.1) — best-effort post-enrol check: a
// hostile enterprise-managed telemetry setting can silently kill the file exporter
// this very enrolment just armed. Vendored verbatim like the two above.
import { detectManagedTelemetry } from './managed-telemetry.mjs'

// Bound the enroll POST so a network blackhole can't hang session startup (the
// SessionStart hook has a 15s budget shared with the forwarder spawn).
const ENROLL_TIMEOUT_MS = 4000

// The baked API base — mirrors plugin/scripts/api-base.mjs's DEFAULT_API_BASE.
// The plugin ships from a specific deployment's marketplace, so it implies its
// server; TOKENSCOPE_API_BASE overrides for local dev / another instance. A public
// hostname, not a secret.
const DEFAULT_API_BASE = 'https://tokenscope.example.com'

/**
 * Resolve the API base (explicit arg > discovered registration > baked default),
 * trailing slash stripped.
 *
 * TOKENSCOPE_API_BASE IS DELIBERATELY NOT A SOURCE HERE, and it used to be the
 * FIRST one — above even the explicit argument. This is the call that POSTs the
 * bundled ENROLLMENT SECRET and then persists whatever bearer / OTLP / oauth
 * endpoints come back into ~/.tokenscope/config.json, so whoever names the host
 * gets the org-wide secret on the way out and the destination of every future
 * token and span on the way back. `plugin/scripts/api-base.mjs` documents why
 * that env var is not a trustworthy source (a repository can supply it, and
 * repo-supplied env is indistinguishable from shell-exported env), and
 * `claude-redeem.mjs` / `plugin/scripts/enroll.mjs` resolve with `trustEnv:false`
 * for exactly this reason. This function was the remaining copy that had not
 * caught up — a SECOND, private resolver outside `scripts/sync-copilot-plugin.mjs`'s
 * FILES list, so the drift check could not see it.
 *
 * Discovery takes the env var's place rather than nothing following the argument,
 * so an operator who registered their own MCP server still enrols against their
 * own server, and a local dev whose registration IS localhost:3450 still reaches
 * it. Those origins come from user-scope config the human wrote (see
 * mcp-origin.mjs); a checked-out repository cannot author them.
 */
export function resolveApiBase(argBase, { discovered } = {}) {
  const found = discovered === undefined ? defaultDiscoverOrigin() : discovered
  const raw = (argBase ?? '').trim() || (found ?? '').trim() || DEFAULT_API_BASE
  return raw.replace(/\/+$/, '')
}

/**
 * The registered MCP origin, or null.
 *
 * `discoverMcpOrigin` never throws, but locating the plugin's own bundle to hand
 * it does: `import.meta.url` is a `file:` URL when node runs this script
 * directly (every production path) and is NOT one under a bundler's module
 * transform, where `fileURLToPath` raises `ERR_INVALID_URL_SCHEME`. Enrolment is
 * fail-OPEN and runs from a lifecycle hook, so an unresolvable bundle path must
 * degrade to "nothing registered" rather than abort it. Degrading to null falls
 * to the baked default, never to TOKENSCOPE_API_BASE, which this path does not
 * consult at all.
 */
function defaultDiscoverOrigin() {
  try {
    return discoverMcpOrigin(fileURLToPath(new URL('.', import.meta.url)), { client: 'copilot' })
  } catch {
    return null
  }
}

/**
 * POST a JSON body, resolve the parsed JSON response. Dependency-free; mirrors the
 * httpsPost in copilot-redeem.mjs. Rejects on a non-2xx status or a non-JSON body.
 * NEVER logs the body — it redeems credential material. Bounded by timeoutMs.
 *
 * The URL is validated via assertSafeEndpoint (S2 — closes the Copilot leg of
 * client-plugins:mitm:0003) BEFORE any request is built: this used to pick
 * `http` for ANY non-https URL with no complaint (the "plain-http fallback"),
 * silently downgrading a poisoned api base to plaintext instead of refusing it.
 * allowLoopback:true — a locally-running dev server (TOKENSCOPE_API_BASE=
 * http://localhost:3450) legitimately answers on 127.0.0.1/::1.
 */
export function httpsPostJson(urlStr, body, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = assertSafeEndpoint(urlStr, { allowLoopback: true })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    const bodyBuf = Buffer.from(JSON.stringify(body), 'utf8')
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.length,
          Accept: 'application/json',
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data))
            } catch {
              reject(new Error(`Non-JSON response: ${data.slice(0, 200)}`))
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`))
          }
        })
      },
    )
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`request timed out after ${timeoutMs}ms`))
      })
    }
    req.on('error', reject)
    req.write(bodyBuf)
    req.end()
  })
}

/** The TokenScope state dir (TOKENSCOPE_STATE_DIR or ~/.tokenscope). */
export function stateDir(env = process.env, home = homedir()) {
  return (env?.TOKENSCOPE_STATE_DIR ?? '').trim() || join(home, '.tokenscope')
}

/** Read ~/.tokenscope/config.json (or null on any failure — missing/unparseable). */
export function readConfig(configPath) {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * True if `config` (the parsed ~/.tokenscope/config.json) already carries a
 * COMPLETE emit enrolment — a durable OAuth refresh token AND a bearer endpoint
 * AND a non-empty instance id. When enrolled we must NEVER re-enrol (it would mint
 * a second provisional instance) or clobber the existing (possibly
 * redeemed/confirmed) credential. The Copilot analogue of the Claude isEnrolled
 * env-block check — the forwarder's mintBearer needs exactly these three keys.
 */
export function isEnrolled(config) {
  if (!config || typeof config !== 'object') return false
  const hasRefresh = Boolean((config.oauth_refresh_token ?? '').trim?.())
  const hasBearer = Boolean((config.bearer_endpoint ?? '').trim?.())
  const hasInstance = Boolean((config.instance_id ?? '').trim?.())
  return hasRefresh && hasBearer && hasInstance
}

/**
 * Best-effort scan of a Copilot config object for an `@` email string value.
 * Schema-tolerant: Copilot does not document a stable email field, so we look at a
 * few likely shapes and otherwise give up (never guesses a non-email value).
 */
function emailFromCopilotConfig(obj) {
  if (!obj || typeof obj !== 'object') return null
  const candidates = [
    obj.email,
    obj.user?.email,
    obj.account?.email,
    obj.oauthAccount?.emailAddress,
    obj.user?.login, // GitHub login is sometimes an email
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes('@')) return c.trim()
  }
  return null
}

/**
 * Determine the claimed email for the enrol, or null if none is trustworthy.
 * Source order documented in the module header (git identity first — Copilot has
 * no Claude OAuth email file). NEVER guesses — a missing email skips enrolment
 * rather than claiming a wrong identity.
 */
export function readClaimedEmail({ cwd = process.cwd(), home = homedir() } = {}) {
  // 1. The repo's / global git identity — the email the developer commits as.
  try {
    const e = execFileSync('git', ['config', 'user.email'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (e.includes('@')) return e
  } catch {
    /* no git / no configured identity — fall through */
  }
  // 2. Fallback: any email Copilot persisted in ~/.copilot/{config,apps}.json.
  for (const f of ['config.json', 'apps.json']) {
    try {
      const obj = JSON.parse(readFileSync(join(home, '.copilot', f), 'utf8'))
      const e = emailFromCopilotConfig(obj)
      if (e) return e
    } catch {
      /* no such file / not parseable — try the next */
    }
  }
  return null
}

/**
 * A stable per-host device-binding hint. The server treats this as an opaque dedup
 * key (HMAC-hashed at rest), never an auth factor, so a best-effort stable value is
 * sufficient. /etc/machine-id when present, else just the hostname.
 */
export function computeDeviceBinding() {
  let machineId = ''
  try {
    machineId = readFileSync('/etc/machine-id', 'utf8').trim()
  } catch {
    /* not a systemd host */
  }
  return machineId ? `${hostname()}:${machineId}` : hostname()
}

/** Atomic temp+rename write (mode if given) — never truncates on a crash mid-write. */
function writeFileAtomic(path, content, mode) {
  const tmp = `${path}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', ...(mode != null ? { mode } : {}) })
    if (mode != null) chmodSync(tmp, mode) // defeat umask
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* best-effort cleanup */
    }
    throw err
  }
}

/**
 * Build the ~/.tokenscope/config.json payload from a COPILOT-shaped enroll response.
 *
 * The enroll POST now passes `tool: 'copilot-cli'` (P1-5), so the server returns the
 * copilot bundle directly (telemetry.copilot, the CopilotBundle shape — TOKENSCOPE_*
 * endpoints + an OTEL_RESOURCE_ATTRIBUTES that ALREADY says tool=copilot-cli) instead
 * of a claude bundle the client had to regex-rewrite. We map those fields onto the
 * forwarder's config shape — the SAME mapping copilot-redeem.mjs's writeTokenscopeConfig
 * uses (the exact keys copilot-forwarder.mjs's loadConfig + mintBearer read). The span
 * file path is a RELATIVE per-project value (PROJECT_LOCAL_DIR) resolved by Copilot
 * against its launch cwd — matching copilot-redeem (never a server-sent ~/... value).
 * Throws if the attribution-critical fields are missing (so we never write a
 * half-config the forwarder would silently fail on). Exported for unit testing.
 */
export function buildCopilotConfig(resp) {
  const copilot = resp?.telemetry?.copilot
  const instanceId = (resp?.instance_id ?? copilot?.instance_id ?? '').trim?.() || ''
  const bearerEndpoint =
    (resp?.bearer_endpoint ?? copilot?.TOKENSCOPE_BEARER_ENDPOINT ?? '').trim?.() || ''
  const logsEndpoint =
    (copilot?.TOKENSCOPE_LOGS_ENDPOINT ?? resp?.logs_endpoint ?? '').trim?.() || ''
  const tokenEndpoint =
    (resp?.oauth_token_endpoint ?? copilot?.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT ?? '').trim?.() || ''
  const clientId =
    (resp?.oauth_client_id ?? copilot?.TOKENSCOPE_OAUTH_CLIENT_ID ?? '').trim?.() || ''
  const refreshToken = (resp?.oauth_refresh_token ?? '').trim?.() || ''
  // tool=copilot-cli is already baked into the server bundle — no client rewrite.
  const attrs = (copilot?.OTEL_RESOURCE_ATTRIBUTES ?? '').trim?.() || ''

  // Attribution invariant: a non-empty instance id, or every record is unjoinable
  // to a teammate. `tokenscope.instance_id=` with an empty value is just as broken.
  if (!instanceId) throw new Error('enroll response missing instance_id')
  if (!/tokenscope\.instance_id=[^,\s]/.test(attrs)) {
    throw new Error(
      'enroll response missing a non-empty OTEL_RESOURCE_ATTRIBUTES tokenscope.instance_id',
    )
  }
  // The durable emit credential + endpoints the forwarder's mintBearer requires —
  // a partial response would write a credential otel-headers-helper.sh treats as
  // NOT CONFIGURED (silent zero telemetry).
  if (!bearerEndpoint) throw new Error('enroll response missing bearer endpoint')
  if (!logsEndpoint) throw new Error('enroll response missing logs endpoint')
  if (!tokenEndpoint || !clientId || !refreshToken) {
    throw new Error('enroll response missing a complete OAuth emit credential')
  }
  // S2 fix — validate the resolved endpoint bundle is SAFE (https, or an
  // explicitly allowed loopback) BEFORE it is returned for persisting. Reuses
  // copilot-redeem.mjs's assertSafeRedeemBundle (imported above) rather than a
  // second validator: emit-on-install and the manual redeem write onto the
  // IDENTICAL ~/.tokenscope/config.json contract, so both paths must agree on
  // what "safe" means. Throws — the caller (enrollIfNeeded) already treats any
  // throw from buildCopilotConfig as a fail-open 'write-failed'.
  assertSafeRedeemBundle({
    TOKENSCOPE_BEARER_ENDPOINT: bearerEndpoint,
    TOKENSCOPE_LOGS_ENDPOINT: logsEndpoint,
    TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: tokenEndpoint,
  })

  return {
    instance_id: instanceId,
    bearer_endpoint: bearerEndpoint,
    logs_endpoint: logsEndpoint,
    oauth_token_endpoint: tokenEndpoint,
    oauth_client_id: clientId,
    oauth_refresh_token: refreshToken,
    // RELATIVE per-project path — must match copilot-redeem's contract so emit-on-install
    // and a later manual redeem agree. Copilot resolves it against its launch cwd (=
    // project root) → each project writes its own <project>/.tokenscope.local/ span file;
    // the forwarder's config-fallback resolves the same relative value against ITS cwd.
    copilot_otel_file_path: join(PROJECT_LOCAL_DIR, 'copilot-otel.jsonl'),
    otel_resource_attributes: attrs,
  }
}

/**
 * Write the enroll config into `targetDir` (default ~/.tokenscope), mirroring
 * copilot-redeem's writeTokenscopeConfig on-disk contract:
 *   - config.json (mode 0600, atomic) — the forwarder-readable durable store.
 *   - oauth-access.json (mode 0600) — the helper's access-token cache, written as
 *     an EMPTY placeholder ONLY when absent (never clobber a live cache).
 * Exported for unit testing.
 */
export function writeTokenscopeConfig(config, targetDir = stateDir()) {
  mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  const configPath = join(targetDir, 'config.json')
  writeFileAtomic(configPath, JSON.stringify(config, null, 2) + '\n', 0o600)

  const oauthPath = join(targetDir, 'oauth-access.json')
  if (!existsSync(oauthPath)) {
    writeFileAtomic(
      oauthPath,
      JSON.stringify({ access_token: '', expires_at: 0 }, null, 2) + '\n',
      0o600,
    )
  }
}

/**
 * Enrol this device for emit-on-install IFF it is a fresh install of the real
 * (publish-injected) plugin. Returns { enrolled, reason?, instanceId? }; never
 * throws (fail-open). Dependencies are injectable for unit testing.
 *
 * @param {{
 *   targetDir?: string,
 *   apiBase?: string|null,
 *   enrollmentSecret?: string,
 *   claimedEmail?: string|null,
 *   deviceBinding?: string,
 *   timeoutMs?: number,
 *   post?: typeof httpsPostJson,
 *   writeConfig?: typeof writeTokenscopeConfig,
 *   checkManagedTelemetry?: typeof detectManagedTelemetry,
 *   cwd?: string,
 *   home?: string,
 * }} [opts]
 */
export async function enrollIfNeeded({
  targetDir = stateDir(),
  apiBase = null,
  enrollmentSecret = resolveEnrollmentSecret(),
  claimedEmail = undefined,
  deviceBinding = undefined,
  timeoutMs = ENROLL_TIMEOUT_MS,
  post = httpsPostJson,
  writeConfig = writeTokenscopeConfig,
  // Arms span emission for future copilot launches (the shell-rc export). Injectable so
  // unit tests don't touch the real ~/.bashrc; defaults to the real relative-path arming.
  armRc = (h) => armOtelExporterRc(detectShellRcTargets(undefined, h)),
  // Workstream D §10.1 — injectable so unit tests don't touch the real filesystem/
  // registry; defaults to the real detector.
  checkManagedTelemetry = detectManagedTelemetry,
  cwd = process.cwd(),
  home = homedir(),
} = {}) {
  // 1. Already enrolled — never re-enrol / never clobber an existing credential.
  if (isEnrolled(readConfig(join(targetDir, 'config.json')))) {
    return { enrolled: false, reason: 'already-enrolled' }
  }

  // 2. No bundled secret (un-injected dev build) — only the real distributed plugin
  //    enrols. Trim-guarded inside resolveEnrollmentSecret.
  if (!enrollmentSecret) return { enrolled: false, reason: 'no-secret' }

  // 3. Need a trustworthy claimed email — never guess.
  const email = claimedEmail === undefined ? readClaimedEmail({ cwd, home }) : claimedEmail
  if (!email) return { enrolled: false, reason: 'no-email' }

  // 4. Resolve the enroll URL from the configured api base. S2 fix: a naive
  //    startsWith('http') guard accepts http:// as readily as https:// — replaced
  //    with assertSafeEndpoint so a misconfigured (or MITM'd) TOKENSCOPE_API_BASE
  //    is refused, not silently POSTed to in plaintext (allowLoopback for local dev).
  const base = resolveApiBase(apiBase)
  const url = `${base}/api/v1/setup/enroll`
  try {
    assertSafeEndpoint(url, { allowLoopback: true })
  } catch {
    return { enrolled: false, reason: 'no-base' }
  }

  // 5. POST best-effort (bounded). A failure here must stay silent.
  const binding = deviceBinding === undefined ? computeDeviceBinding() : deviceBinding
  let resp
  try {
    // tool=copilot-cli (P1-5): a SERVER-SIDE discriminator so the endpoint returns
    // the copilot bundle (telemetry.copilot, tool=copilot-cli) directly — no
    // client-side regex rewrite of a claude bundle's tool= token.
    resp = await post(
      url,
      {
        enrollment_secret: enrollmentSecret,
        claimed_email: email,
        device_binding: binding,
        tool: 'copilot-cli',
      },
      { timeoutMs },
    )
  } catch {
    return { enrolled: false, reason: 'post-failed' }
  }

  // 6. Validate + write. buildCopilotConfig throws on any incomplete/unattributable
  //    bundle BEFORE we touch config.json (so we never write a half-config).
  try {
    const config = buildCopilotConfig(resp)
    writeConfig(config, targetDir)
    // Arm span emission for FUTURE copilot launches (parity with Claude's settings.json
    // emit-on-install). Copilot reads COPILOT_OTEL_FILE_EXPORTER_PATH at launch, so this
    // takes effect on the next shell that sources the rc — same next-launch contract as
    // Claude. Best-effort: a failed rc write must not fail the enrol (fail-open).
    try {
      armRc(home)
    } catch {
      /* rc arming is best-effort */
    }
    // Workstream D §10.1 — best-effort, NEVER blocks/fails the enrol: a hostile
    // enterprise-managed telemetry setting would otherwise silently strand this
    // FRESH device with a valid credential and zero delivered spans, discoverable
    // only much later via silence. Surface it immediately (forwarder-lifecycle.mjs
    // redirects this process's stderr to ~/.tokenscope/forwarder.log) and echo the
    // classification in the return value so a caller that inspects it can act.
    let managedTelemetry
    try {
      const managed = await checkManagedTelemetry()
      managedTelemetry = managed.classification
      if (managed.classification === 'hostile') {
        console.error(
          `[tokenscope-enroll] WARNING: an enterprise-managed Copilot telemetry setting (source: ${managed.source}) is HOSTILE to the file exporter — this device's credential is now valid, but Copilot itself may never write a span. Run the tokenscope-status skill for detail; this is a policy block, not a credential problem.`,
        )
      }
    } catch {
      managedTelemetry = 'unknown'
    }
    return { enrolled: true, instanceId: config.instance_id, managedTelemetry }
  } catch {
    return { enrolled: false, reason: 'write-failed' }
  }
}
