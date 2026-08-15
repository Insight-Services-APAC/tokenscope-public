/*
 * plugin-runtime — shared runtime helpers for the TokenScope plugin's command +
 * hook scripts. Centralises what was drifting across status.mjs, usage.mjs,
 * session-start.mjs, read-credential.mjs (and partly backfill.mjs / tag-repo.mjs):
 *
 *   - locating the bundled scripts dir + otel-headers-helper.sh (the real emit path)
 *   - reading a settings.json `env` block (global or repo-local)
 *   - the TokenScope state dir and the emit-failure sentinel
 *   - invoking the REAL emit path and classifying the result WITHOUT ever
 *     surfacing the bearer it prints to stdout
 *
 * One module owning the emit-path contract means a change there (stdio handling,
 * the Authorization-header check, the state-dir layout) lands in exactly one
 * place — the supportability win behind this extraction.
 *
 * NOTE: backfill.mjs deliberately keeps its OWN helper invocation: it needs the
 * raw bearer VALUE to POST telemetry, whereas runEmitHelper() here only returns
 * whether a bearer was minted (never the token) — the right contract for a health
 * probe, the wrong one for a re-emitter.
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import https from 'node:https'
import http from 'node:http'
import { assertSafeEndpoint, unsafeEndpointError } from './endpoint-guard.mjs'
// Re-exported so existing importers keep one name, and so mcp-origin.mjs can
// reach it without importing this module (copilot-plugin does not vendor it).
import { realHome } from './real-home.mjs'
export { realHome }

// Re-exported so every existing importer of plugin-runtime.mjs has ONE name to
// reach for (S1 fix 3) — the implementation lives in endpoint-guard.mjs, which
// stays dependency-free so it can also be vendored standalone into the Copilot
// distribution. plugin-runtime.mjs itself is NOT vendored (it imports Node
// builtins beyond what endpoint-guard needs and carries Claude-lane settings
// resolution the Copilot lane has no use for).
export { assertSafeEndpoint } from './endpoint-guard.mjs'

/**
 * POST a JSON body and resolve the parsed JSON response (dependency-free; shared
 * by the redeem helpers so a fix to the HTTP path lands in one place). Rejects on
 * a non-2xx status or a non-JSON body. NEVER logs the body — callers redeem
 * credential material through this.
 *
 * Times out by default (30s): an unresponsive endpoint must fail loud rather than
 * hang the enrolment forever while the 5-min handoff code expires.
 *
 * The URL is validated via assertSafeEndpoint (S1 fix 3) — this used to pick
 * `http` for ANY non-https URL with no complaint (the "plain-http fallback"),
 * which would silently downgrade a poisoned endpoint instead of refusing it.
 * `allowLoopback` defaults true: every caller of this helper is a plugin
 * script resolving its OWN target (via api-base.mjs, which validates itself),
 * and the documented local-dev override (`http://localhost:3450`) must keep
 * working end-to-end through this shared POST path.
 */
export function httpsPostJson(urlStr, body, { timeoutMs = 30_000, allowLoopback = true } = {}) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = assertSafeEndpoint(urlStr, { allowLoopback })
    } catch (err) {
      // Redact at the throw site: assertSafeEndpoint's message embeds the
      // REJECTED endpoint, and this promise's rejection is printed by callers'
      // generic handlers that interpolate err.message. Rejecting the raw guard
      // error is the CodeQL js/clear-text-logging class.
      reject(unsafeEndpointError('Endpoint', err))
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

/** The bundled plugin scripts dir (CLAUDE_PLUGIN_ROOT/scripts, else this file's dir). */
export function resolveScriptsDir() {
  return process.env.CLAUDE_PLUGIN_ROOT
    ? join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts')
    : dirname(fileURLToPath(import.meta.url))
}

/** Absolute path to the bundled otel-headers-helper.sh (the real emit path). */
export function resolveHelperPath() {
  return join(resolveScriptsDir(), 'otel-headers-helper.sh')
}

/**
 * The TokenScope state dir (TOKENSCOPE_STATE_DIR or ~/.tokenscope), anchored on
 * the passwd home so it is stable across a leaked `HOME`. This dir is
 * plugin-owned (forwarder stash/log/pid, landed state) — it is NOT `~/.claude`,
 * which stays on `homedir()` to match Claude Code's own settings resolution.
 *
 * The `env` parameter is accepted but deliberately UNUSED (kept only for
 * call-site compatibility — readEmitSentinel and others still pass one; JS
 * ignores an extra argument). See the S1 note inside the function body.
 */
// eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
export function stateDir(env) {
  // The override is a PROCESS-level concern (a deployment pin / test sandbox):
  // nothing anywhere legitimately writes TOKENSCOPE_STATE_DIR to settings.json,
  // global or repo. So this reads `process.env` ONLY and ignores a passed
  // `env.TOKENSCOPE_STATE_DIR` entirely — the parameter still exists so call
  // sites need not change, it simply no longer influences the state dir.
  // Anchored on the passwd home (HOME-leak-proof).
  //
  // WHAT THIS DOES NOT BUY, stated plainly because an earlier version of this
  // comment claimed the opposite: reading `process.env` is NOT safer than
  // reading a settings-derived object. Claude Code merges a repository's
  // settings `env` block into the process environment, so on this code path
  // `process.env` IS settings-derived and a hostile repo can set this key.
  // Ignoring the passed `env` therefore closes one route and leaves the other
  // open — it is a narrowing, not a boundary.
  //
  // The boundary lives at the CALLER, which is the only layer that still knows
  // provenance: see `hookStateDir()` in plugin/hooks/session-start.mjs, which
  // asks whether a repo-local settings file named the key and replaces or drops
  // it if so. `safeProcessEnv()` cannot do that job here — it strips a COPY,
  // while this function reads the live environment.
  const override = (process.env.TOKENSCOPE_STATE_DIR ?? '').trim()
  return override || trustedStateDir()
}

/**
 * The state dir with NO environment override — `~/.tokenscope` on the passwd
 * home, and nothing else.
 *
 * For the paths where a directory decides who receives a secret and the caller
 * has NOT established the provenance of `TOKENSCOPE_STATE_DIR`. `stateDir()`
 * deliberately honours that variable (a deployment pin, a test sandbox); this is
 * the answer for callers that cannot afford to.
 */
export function trustedStateDir() {
  return join(realHome(), '.tokenscope')
}

/** Read a settings.json's `env` block (or {} on any failure). */
export function readSettingsEnv(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'))
    return s && typeof s.env === 'object' && s.env ? s.env : {}
  } catch {
    return {}
  }
}

/** The GLOBAL ~/.claude/settings.json `env` block. */
export function globalSettingsEnv() {
  return readSettingsEnv(join(homedir(), '.claude', 'settings.json'))
}

/**
 * S1 fix (1) — the POSITIVE ALLOWLIST for a repo-local settings merge. Takes
 * `OTEL_RESOURCE_ATTRIBUTES` from the repo-local env and NOTHING else; every
 * other key comes from `globalEnv`. This replaces the `{...global, ...repo}`
 * shape that used to sit at five call sites in session-start.mjs: an
 * additive spread lets a repo committed into any cloned repository override
 * ANY single key — most dangerously the endpoint the credential is POSTed
 * to, while the credential itself still comes from the trusted global file.
 *
 * A DENY-list would miss `TOKENSCOPE_STATE_DIR`, which is credential-bearing:
 * `otel-headers-helper.sh` writes the freshly-minted emit ACCESS TOKEN into
 * it, so a repo-steered state dir drops a live token inside the attacker's
 * working tree with NO network call at all — an exfil path an endpoint
 * validator can never catch. An allowlist closes it structurally: nothing a
 * repo sets other than the resource attrs can ever reach the merged env.
 *
 * @param {Record<string,string>} globalEnv
 * @param {Record<string,string>} repoEnv
 * @returns {Record<string,string>}
 */
export function repoTagEnv(globalEnv, repoEnv) {
  const out = { ...(globalEnv && typeof globalEnv === 'object' ? globalEnv : {}) }
  const attrs =
    repoEnv && typeof repoEnv === 'object' ? repoEnv.OTEL_RESOURCE_ATTRIBUTES : undefined
  if (typeof attrs === 'string') out.OTEL_RESOURCE_ATTRIBUTES = attrs
  return out
}

/**
 * S1 fix (2) — the safe env for scripts that read LIVE `process.env` directly
 * (status.mjs, backfill.mjs). Claude Code itself has already applied a
 * TAGGED repo's `settings.local.json` onto `process.env` by REPLACEMENT
 * before spawning this process (ADR-0006 §2), so `process.env` may be
 * entirely repo-controlled by the time these scripts run — `repoTagEnv`
 * above cannot help here, because there is no separate "repo env" object to
 * allowlist against; Claude has already merged the two.
 *
 * STRIP FIRST, THEN LAYER THE GLOBAL ON TOP. The earlier shape here was
 * `{...env, ...globalSettingsEnv()}` — the global wins for every key it
 * actually CONTAINS, which is only the enrolled-device case. On a device with
 * no `~/.claude/settings.json`, or one enrolled before a key existed, there is
 * nothing to "win" and the repo-supplied value survives the spread untouched.
 * That is precisely the un-enrolled or partially-enrolled developer — the
 * person most likely to be opening an unfamiliar repository — so the weakest
 * device got the weakest protection.
 *
 * CI proved it: with no global settings file, the hostile-repo fixture's
 * `TOKENSCOPE_BEARER_ENDPOINT` reached the assertion intact, while the same
 * test passed on an enrolled workstation. A control whose strength depends on
 * unrelated local state is not a control.
 *
 * Deleting first makes absence FAIL-SAFE instead of fail-open: a key the
 * global does not supply is simply absent, and every consumer already falls
 * back to its compiled default (`api-base.mjs`'s `DEFAULT_API_BASE`, the
 * helper's `$HOME/.tokenscope`). A repo can no longer contribute any of these
 * values whether or not the device is enrolled.
 *
 * `TOKENSCOPE_STATE_DIR` and `TOKENSCOPE_API_BASE` stay deleted UNCONDITIONALLY
 * — not restored from the global either — because `stateDir()` reads
 * `process.env` directly by design and the API base has a compiled default; a
 * genuine process-level override still reaches them by the documented path.
 *
 * @param {Record<string,string>} [env]
 * @returns {Record<string,string>}
 */
/**
 * Keys a repo-local `settings.local.json` must never contribute: each one
 * either steers a credential-presenting network call or names where a minted
 * credential is written. Restored from the GLOBAL file when it has them.
 */
export const REPO_UNTRUSTED_ENV_KEYS = Object.freeze([
  'TOKENSCOPE_BEARER_ENDPOINT',
  'TOKENSCOPE_OAUTH_TOKEN_ENDPOINT',
  'TOKENSCOPE_OAUTH_CLIENT_ID',
  'TOKENSCOPE_OAUTH_REFRESH_TOKEN',
  'TOKENSCOPE_READ_CLIENT_ID',
  'TOKENSCOPE_READ_REFRESH_TOKEN',
  'TOKENSCOPE_SESSION_TOKEN',
  'TOKENSCOPE_DCE_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
])

/** Deleted outright and never restored — see safeProcessEnv's doc. */
const REPO_UNTRUSTED_ENV_KEYS_NO_RESTORE = Object.freeze([
  'TOKENSCOPE_STATE_DIR',
  'TOKENSCOPE_API_BASE',
])

export function safeProcessEnv(env = process.env) {
  const out = { ...env }
  for (const k of REPO_UNTRUSTED_ENV_KEYS) delete out[k]
  for (const k of REPO_UNTRUSTED_ENV_KEYS_NO_RESTORE) delete out[k]
  // The device's OWN global config may legitimately supply the restorable keys.
  const global = globalSettingsEnv()
  for (const k of REPO_UNTRUSTED_ENV_KEYS) {
    if (typeof global[k] === 'string') out[k] = global[k]
  }
  return out
}

/** Read the helper's emit-failure sentinel for `env`'s state dir (or null). */
export function readEmitSentinel(env = process.env) {
  try {
    return JSON.parse(readFileSync(join(stateDir(env), 'emit-failure.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Invoke the REAL emit path (otel-headers-helper.sh) and classify the result
 * WITHOUT surfacing the bearer it prints. Returns { ran, status, hasAuth }:
 *   - ran:     false if the helper binary is missing (nothing executed)
 *   - status:  the helper's exit code (0 = a bearer was minted)
 *   - hasAuth: stdout parsed to a JSON object carrying an Authorization header
 * The helper itself writes/clears the emit-failure sentinel as a side effect.
 *
 * THE STATE DIR TRAVELS AS AN ARGUMENT, not in `env`. The helper stopped reading
 * `TOKENSCOPE_STATE_DIR` because Claude Code invokes it directly with a
 * repo-merged environment (see the header of otel-headers-helper.sh and the
 * capture it cites), so passing it here is what keeps THIS invocation writing
 * its token cache where the caller resolved rather than wherever the ambient
 * environment says. Defaults to `stateDir()` — the same value the helper's own
 * passwd-home fallback would compute when nothing is pinned.
 *
 * `/bin/sh`, not `sh`: the interpreter is resolved by the OS from PATH when the
 * command is a bare name, and PATH is one of the variables a repository can set
 * (same capture). An absolute path is not steerable.
 *
 * THE DEFAULT IS `trustedStateDir()`, NOT `stateDir()`. `stateDir()` honours a
 * `TOKENSCOPE_STATE_DIR` process-level pin, which is right for a deployment or
 * test sandbox — but this function MINTS A CREDENTIAL, and on the Claude lane
 * that variable is repo-settable (the settings merge; see the capture doc). The
 * callers that legitimately pin — the SessionStart hook, which has established
 * provenance — pass `stateDir` explicitly. The callers that do NOT pass one
 * (`status.mjs`, and any added later) get the passwd home rather than silently
 * inheriting whatever the ambient environment says, which is the safe default
 * for a function whose side effect is writing a token cache.
 *
 * @param {{env?: Record<string,string>, timeoutMs?: number, stateDir?: string}} [opts]
 */
export function runEmitHelper({ env = process.env, timeoutMs, stateDir: dir } = {}) {
  const helper = resolveHelperPath()
  if (!existsSync(helper)) return { ran: false, status: null, hasAuth: false }
  const res = spawnSync('/bin/sh', [helper, '--state-dir', dir ?? trustedStateDir()], {
    encoding: 'utf8',
    env,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  })
  let hasAuth = false
  try {
    hasAuth = Boolean(JSON.parse(res.stdout || '{}').Authorization)
  } catch {
    // Unparseable helper output → treat as no auth; `hasAuth` stays false.
  }
  return { ran: true, status: res.status, hasAuth }
}
