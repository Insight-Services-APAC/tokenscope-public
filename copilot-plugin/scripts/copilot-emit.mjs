// SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/copilot-emit.mjs. Re-generate with: npm run sync:copilot-plugin
/*
 * copilot-emit.mjs — the Copilot lane's ONE emit implementation: credential store,
 * bearer mint, guarded OTLP POST, and the project/org stamps. Shared by the file
 * forwarder (copilot-forwarder.mjs) and the usage extension
 * (copilot-plugin/extensions/tokenscope-usage). Node built-ins only.
 * Design: docs/design/copilot-usage-extension.md.
 */
import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { join, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { trustedGitPath } from './trusted-git.mjs'
import { resolveRepoProjectCode, computeCodeHash } from './tokenscope-project.mjs'
import { assertSafeEndpoint, unsafeEndpointError } from './endpoint-guard.mjs'
import { realHome } from './real-home.mjs'
import { deviceStorePath, resolveStorePath } from './device-store.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/*
 * The durable store holds `oauth_refresh_token` and the endpoint it is spent at, so
 * its location is a TRUST SINK: anchor on the passwd home (realHome), never `$HOME`,
 * and never fall back to a `$HOME`-derived path. The TOKENSCOPE_STATE_DIR pin grants
 * nothing new — the helper spawned below already honours it. Rationale: real-home.mjs.
 */
export const TOKENSCOPE_DIR =
  (process.env.TOKENSCOPE_STATE_DIR ?? '').trim() || join(realHome(), '.tokenscope')
export const CONFIG_PATH = deviceStorePath('copilot-cli', TOKENSCOPE_DIR)
/** Own store, else the pre-split one. Per call: a redeem can land mid-run. */
export const configPathNow = () => resolveStorePath('copilot-cli', TOKENSCOPE_DIR)

const HTTP_TIMEOUT_MS = 30_000

/**
 * Copilot's user settings file: `$COPILOT_HOME/settings.json`, else `$HOME/.copilot`.
 * `$HOME`, not the passwd home: this is Copilot's file, found the way Copilot finds it
 * (like the shell rc files beside it), not one of our credential stores.
 */
export function copilotSettingsPath(env = process.env, home = homedir()) {
  const h = (env.COPILOT_HOME ?? '').trim()
  return join(h && isAbsolute(h) ? h : join(home, '.copilot'), 'settings.json')
}

/**
 * Whether this device is migrated: Copilot will load the TokenScope usage extension
 * (feature on, mode not 'disabled', the extension not switched off), read from its
 * settings as Copilot reads them. The one lane signal every process can read (Copilot
 * hides the span variable from hooks and tools, never these files). On: the usage
 * extension sends every session and the forwarder idles. Off: the CLI loads no
 * extension and the forwarder runs as before.
 * docs/design/copilot-usage-extension.md §Coexistence.
 */
export function extensionsEnabled(env = process.env, home = homedir()) {
  return extensionsOn(effectiveCopilotSettings(copilotSettingsPath(env, home)))
}

/**
 * The CLI loads the TokenScope usage extension: the feature is on, extension mode is
 * not 'disabled', and the user has not switched this extension off (`/extensions`).
 */
export function extensionsOn(settings) {
  const off = Array.isArray(settings?.extensions?.disabledExtensions) ? settings.extensions.disabledExtensions : []
  return (
    settings?.enabledFeatureFlags?.EXTENSIONS === true &&
    settings?.extensions?.mode !== 'disabled' &&
    !off.some((id) => typeof id === 'string' && (id === 'tokenscope-usage' || id.endsWith(':tokenscope-usage')))
  )
}

/**
 * The keys Copilot also reads from its legacy config.json, where that file wins.
 * Returns only those keys from config.json, or {} when it has none or cannot be read.
 */
export function legacyConfigOverrides(settingsPath) {
  try {
    const { settings } = readCopilotSettings(join(dirname(settingsPath), 'config.json'))
    const out = {}
    for (const k of ['enabledFeatureFlags', 'extensions']) if (settings[k] !== undefined) out[k] = settings[k]
    return out
  } catch {
    return {}
  }
}

/** What Copilot acts on: settings.json with config.json's overriding keys on top. null if neither reads. */
export function effectiveCopilotSettings(settingsPath) {
  let settings = null
  try {
    settings = readCopilotSettings(settingsPath).settings
  } catch {
    /* absent or unreadable */
  }
  const over = legacyConfigOverrides(settingsPath)
  return Object.keys(over).length ? { ...(settings ?? {}), ...over } : settings
}

/**
 * Copilot's settings.json, read the one way every TokenScope process reads it. Plain
 * JSON, or JSON with full-line // comments and trailing commas (`jsonc: true`), which
 * the user may have written by hand: readable, but never rewritten by us. Throws when
 * absent or unparseable.
 */
export function readCopilotSettings(path) {
  const raw = fs.readFileSync(path, 'utf8')
  let settings
  let jsonc = false
  try {
    settings = JSON.parse(raw)
  } catch {
    settings = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'))
    jsonc = true
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not an object')
  return { settings, jsonc }
}

/**
 * Whether the legacy forwarder sends this session, so the extension must only shadow:
 * a device not yet migrated, whose Copilot was started with the span path setup used
 * to export. Only that path: a variable naming any other file writes spans nothing
 * forwards. (In the CLI the extension loads only on a migrated device, so this is
 * false there unless extensions were turned on another way.)
 */
export function legacyForwarderActive(env = process.env, { migrated = () => extensionsEnabled(env) } = {}) {
  const v = (env.COPILOT_OTEL_FILE_EXPORTER_PATH ?? '').trim().replace(/\\/g, '/')
  return (v === LEGACY_SPAN_PATH || v.endsWith(`/${LEGACY_SPAN_PATH}`)) && !migrated()
}

/** The project-relative span file setup exported for Copilot, and the forwarder reads. */
export const LEGACY_SPAN_PATH = '.tokenscope.local/copilot-otel.jsonl'

export function isProvisioned() {
  return fs.existsSync(configPathNow())
}

export function loadConfig() {
  const path = configPathNow()
  if (!fs.existsSync(path)) {
    throw new Error(`TokenScope config not found at ${path} — run the tokenscope-setup skill first.`)
  }
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

// Bound to the endpoint it was minted for: the store can change under a long-lived
// process, and an unbound bearer would follow the new endpoint until a 401.
let cachedBearer = null

/*
 * The refresh token reaches the helper through ITS env only (a child process, never
 * this process's own env or argv). The state dir travels as an argument because the
 * helper deliberately ignores TOKENSCOPE_STATE_DIR (otel-headers-helper.sh header).
 * `/bin/sh` absolute because PATH is untrusted. POSIX-only by construction.
 */
export function mintBearer(force = false) {
  const cfg = loadConfig()
  if (cachedBearer && !force && cachedBearer.bearerEndpoint === cfg.bearer_endpoint) {
    return cachedBearer.token
  }
  const helperPath = join(__dirname, 'otel-headers-helper.sh')
  const env = {
    ...process.env,
    TOKENSCOPE_BEARER_ENDPOINT: cfg.bearer_endpoint,
    TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: cfg.oauth_token_endpoint,
    TOKENSCOPE_OAUTH_CLIENT_ID: cfg.oauth_client_id,
    TOKENSCOPE_OAUTH_REFRESH_TOKEN: cfg.oauth_refresh_token,
  }
  const out = execFileSync(
    '/bin/sh',
    [helperPath, '--state-dir', TOKENSCOPE_DIR, '--tool', 'copilot-cli'],
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'inherit'] },
  )
  cachedBearer = { token: JSON.parse(out).Authorization, bearerEndpoint: cfg.bearer_endpoint }
  return cachedBearer.token
}

/*
 * POST a protobuf batch. assertSafeEndpoint runs BEFORE any request is built, so a
 * poisoned logs_endpoint is refused rather than downgraded to plaintext. The guard's
 * error embeds the rejected endpoint, so it is redacted HERE (CodeQL
 * js/clear-text-logging) whichever handler ends up printing it.
 */
export function httpsPost(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = assertSafeEndpoint(urlStr, { allowLoopback: true })
    } catch (err) {
      reject(unsafeEndpointError('OTLP endpoint', err))
      return
    }
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        headers: {
          ...headers,
          'content-type': 'application/x-protobuf',
          'content-length': body.length,
        },
      },
      (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 200) }))
      },
    )
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`request timed out after ${HTTP_TIMEOUT_MS}ms`))
    })
    req.on('error', (e) => reject(e))
    req.write(body)
    req.end()
  })
}

/** POST, re-minting the bearer ONCE on 401/403 (it can expire mid-session). */
export async function postWithRetry(url, proto, mint, post) {
  let result = await post(url, { authorization: mint(false) }, proto)
  if (result.status === 401 || result.status === 403) {
    result = await post(url, { authorization: mint(true) }, proto)
  }
  return result
}

/**
 * The GitHub org from a remote URL or an "org/repo" slug (https, scp, ssh, bare
 * host/path, or a bare slug). GHE hosts are accepted: the org, not the host, is the
 * F2 key. Returns the lowercased org, or null.
 */
export function parseGithubOrg(remote) {
  let s = String(remote || '').trim()
  if (!s) return null
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  s = s.replace(/^[^/@\s]+@/, '')
  let path
  const colon = s.indexOf(':')
  const slash = s.indexOf('/')
  if (colon !== -1 && (slash === -1 || colon < slash)) {
    path = s.slice(colon + 1).replace(/^\d+\//, '')
  } else if (slash !== -1) {
    // The first segment is a host only if it looks like one; otherwise a bare
    // "org/repo" slug would lose its org.
    const head = s.slice(0, slash)
    path = /\./.test(head) || head === 'localhost' ? s.slice(slash + 1) : s
  } else {
    return null
  }
  const m = path.match(/^([^/\s]+)\/[^\s]/)
  if (!m) return null
  return m[1].replace(/\.git$/, '').toLowerCase() || null
}

/** The origin remote of `cwd` via the TRUSTED git binary only; null on any failure. */
export function gitRemoteOrgUrl(cwd = process.cwd()) {
  try {
    const git = trustedGitPath()
    if (!git) return null
    const out = execFileSync(git, ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

/** Org stamp: the git remote first (deterministic), `spanRepo` ("org/repo") as fallback. */
export function resolveGithubOrg(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const readRemote = opts.readRemote ?? gitRemoteOrgUrl
  const fromRemote = parseGithubOrg(readRemote(cwd))
  if (fromRemote) return fromRemote
  return parseGithubOrg(opts.spanRepo ?? null)
}

/**
 * project.code_hash from the committed `.tokenscope` at `cwd`, via the SHARED
 * resolver so Copilot and Claude hash an identical repo identically (drift = split
 * attribution). No `.tokenscope` → null (untagged, not an error). `cfg` is unused and
 * kept for signature stability.
 */
export function resolveProjectCodeHash(cfg, opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  try {
    const { code } = resolveRepoProjectCode({ arg: '', cwd })
    return computeCodeHash(code)
  } catch {
    return null
  }
}
