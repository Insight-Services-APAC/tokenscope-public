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

/**
 * POST a JSON body and resolve the parsed JSON response (dependency-free; shared
 * by the redeem helpers so a fix to the HTTP path lands in one place). Rejects on
 * a non-2xx status or a non-JSON body. NEVER logs the body — callers redeem
 * credential material through this.
 *
 * Times out by default (30s): an unresponsive endpoint must fail loud rather than
 * hang the enrolment forever while the 5-min handoff code expires.
 */
export function httpsPostJson(urlStr, body, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
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

/** The TokenScope state dir (TOKENSCOPE_STATE_DIR or ~/.tokenscope). */
export function stateDir(env = process.env) {
  return (env.TOKENSCOPE_STATE_DIR ?? '').trim() || join(homedir(), '.tokenscope')
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
 * @param {{env?: Record<string,string>, timeoutMs?: number}} [opts]
 */
export function runEmitHelper({ env = process.env, timeoutMs } = {}) {
  const helper = resolveHelperPath()
  if (!existsSync(helper)) return { ran: false, status: null, hasAuth: false }
  const res = spawnSync('sh', [helper], {
    encoding: 'utf8',
    env,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  })
  let hasAuth = false
  try {
    hasAuth = Boolean(JSON.parse(res.stdout || '{}').Authorization)
  } catch {
    hasAuth = false
  }
  return { ran: true, status: res.status, hasAuth }
}
