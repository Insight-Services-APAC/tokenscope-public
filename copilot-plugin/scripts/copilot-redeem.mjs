#!/usr/bin/env node
// SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/copilot-redeem.mjs. Re-generate with: npm run sync:copilot-plugin
/*
 * copilot-redeem — local helper that redeems a TokenScope emit handoff for a
 * Copilot CLI device. Called by the tokenscope-setup skill AFTER provision_emit
 * returns a handoff_code + redeem_url. Runs process→server (NOT through the
 * MCP/chat), so the durable emit credential never enters the LLM's context.
 *
 * Writes (1 + 2 under the account's PASSWD home, which `$HOME` cannot move —
 * see TOKENSCOPE_DIR):
 *   1. ~/.tokenscope/config.copilot-cli.json — durable emit creds + endpoints (mode 0600).
 *   2. ~/.tokenscope/oauth-access.copilot-cli.json — OAuth creds (mode 0600). (same shape
 *      as otel-headers-helper.sh expects)
 *   3. Copilot's settings.json: enabledFeatureFlags.EXTENSIONS (and extensions.mode
 *      load_only unless the user chose one), so the CLI loads the plugin's usage
 *      extension (armUsageExtension). Nothing is written into a shell
 *      rc any more; a TokenScope block an earlier setup wrote (`# >>> TokenScope >>>
 *      … # <<< TokenScope <<<`, login AND non-login rc files) is removed.
 *
 * Usage (both forms accepted):
 *   node copilot-redeem.mjs <handoff_code> [--api-base <base>] [--shell-rc <path>]
 *   node copilot-redeem.mjs --handoff-code <code> [--api-base <base>] [--shell-rc <path>]
 *
 * --remove: removes the TokenScope block from the shell RC and exits 0
 *           (the analogue of /tokenscope:statusline-toggle disable).
 *
 * EVERY flag is validated before it is used (argv-guard.mjs). Copilot CLI has no
 * `allowed-tools` mechanism at all — its skills are plain SKILL.md prose — so the
 * argv of this process is whatever the model wrote, and this file is the only
 * place a control can sit: an unknown flag is refused outright, --shell-rc is
 * confined to rc files in the user's own home, and --api-base may only SELECT
 * among the origins this device already knows (loopback, or the MCP registration
 * discovered in local config). `--redeem-url` was deleted rather than validated:
 * it named the POST target for a live single-use handoff code outright.
 *
 * Env:
 *   TOKENSCOPE_API_BASE — deliberately NOT read on this path (see main()); a
 *                         checked-out repository can set environment variables.
 */
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  rmSync,
  rmdirSync,
  lstatSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import http from 'node:http'
import { assertSafeEndpoint, unsafeEndpointError } from './endpoint-guard.mjs'
import { copilotSettingsPath, readCopilotSettings, extensionsOn, legacyConfigOverrides } from './copilot-emit.mjs'
import { discoverMcpOrigin } from './mcp-origin.mjs'
import { realHome } from './real-home.mjs'
import { deviceStorePath, assertStoreConsistent } from './device-store.mjs'
import {
  acceptApiBaseArg,
  assertConfinedPath,
  assertKnownFlag,
  flagValue,
} from './argv-guard.mjs'

// ── constants ────────────────────────────────────────────────────────────────
const BLOCK_START = '# >>> TokenScope >>>'
const BLOCK_END = '# <<< TokenScope <<<'
/**
 * The durable Copilot credential store. Anchored on the PASSWD home, not `$HOME`.
 *
 * `config.copilot-cli.json` under this dir holds `oauth_refresh_token` — a long-lived
 * credential — so this path is a TRUST SINK, not merely a location. `os.homedir()`
 * consults `HOME` first, so a leaked or model-set `HOME` would write a live
 * refresh token into a directory somebody else chose (the working tree, a shared
 * dir). `realHome()` reads the passwd entry, which an env var cannot move.
 *
 * The Claude lane already made exactly this call (`claude-redeem.mjs`'s
 * `trustedHome`), which is why the Copilot lane was the inconsistent one. Like
 * that lane, there is NO read-time fallback to a `$HOME`-derived path: a
 * fallback would let a moved `HOME` re-choose the store the moment the trusted
 * one is absent, which is the bypass this anchor exists to remove. `main()` says
 * so out loud instead, naming both paths, when the two homes differ.
 *
 * NOT the shell-rc files — those are read by the user's SHELL, which resolves
 * them through `$HOME`; see `detectShellRcTargets` and the `--shell-rc` guard.
 */
const TOKENSCOPE_DIR = join(realHome(), '.tokenscope')
/**
 * Per-PROJECT dir of the legacy file forwarder, RELATIVE to the project root: its
 * span file, byte-offset and singleton lock. Used only while a shell that still
 * exports the old variable is open (copilot-forwarder.mjs).
 */
const PROJECT_LOCAL_DIR = '.tokenscope.local'
/** Network timeout for the redeem POST — a black-holed endpoint must fail loud, not hang. */
const HTTP_TIMEOUT_MS = 30_000

// ── atomic file write (temp + rename) ────────────────────────────────────────
// The forwarder daemon loadConfig()s config.copilot-cli.json every tick and a crash mid-write
// must never truncate a shell RC file — write to a per-process temp then rename
// (atomic on the same filesystem). Same pattern as claude-redeem's writeClaudeSettings.
function writeFileAtomic(path, content, mode) {
  // Random, not PID-only: PIDs collide across containers on the shared mount.
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`
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

// ── API-base discovery ───────────────────────────────────────────────────────
/**
 * Derive the TokenScope server base from the plugin's OWN .mcp.json.
 *
 * On a FRESH device neither --api-base nor TOKENSCOPE_API_BASE is set, and
 * provision_emit returns `redeem_url` as the RELATIVE '/api/v1/setup/redeem'
 * (deliberately — the server must not bake a Front-Door host). That left the
 * helper with nothing to resolve against, so first-time setup died at the redeem
 * step with "Cannot resolve a safe redeem URL" and no instruction anywhere
 * mentioned the flag (reproduced live 2026-07-28).
 *
 * The .mcp.json sitting beside this script is an authoritative, always-present
 * answer: provision_emit could only have been called THROUGH that server, so its
 * URL is by construction the right base. Its URL is required to be a literal
 * (Copilot CLI does not expand ${VAR}), so no interpolation is needed.
 *
 * Resolution is relative to the SCRIPT directory, never cwd, so a repository
 * cannot poison it. Returns an origin (scheme + host + port) or null. The caller
 * still runs assertSafeEndpoint over the result, so a poisoned .mcp.json is
 * refused exactly like a poisoned --api-base — this widens convenience, never
 * the trust model.
 */
function discoverApiBaseFromMcpJson() {
  // Delegates to the shared resolver so BOTH redeem helpers search the same
  // places in the same order. This used to look only at the plugin's own
  // bundled .mcp.json, i.e. the baked default — correct for a stock install and
  // exactly wrong for an operator who registered the MCP server at their own
  // URL, whose handoff would then be minted by their server and redeemed
  // against ours.
  return discoverMcpOrigin(fileURLToPath(new URL('.', import.meta.url)), { client: 'copilot' })
}

// ── arg parsing ──────────────────────────────────────────────────────────────
// The shell-rc filenames --shell-rc may name. Not "any file in your home": this
// flag OVERRIDES detectShellRcTargets, whose whole output is drawn from this set,
// and what lands in the named file is an export block every future shell then
// executes. An arbitrary path would be model-chosen persistence.
const SHELL_RC_BASENAMES = [
  '.bashrc',
  '.profile',
  '.bash_profile',
  '.bash_login',
  '.zshrc',
  '.zprofile',
  '.zshenv',
]

// STRICT: this process spends a live single-use handoff code and appends to shell
// init files, and Copilot CLI has no permission grant to narrow — the argv is
// whatever the model wrote. Anything the documented flow does not produce is
// refused rather than reinterpreted. Throws; main() runs inside the top-level
// catch that prints it.
function parseArgs(argv) {
  const out = { handoffCode: null, apiBase: null, shellRc: null, remove: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    switch (flag) {
      case '--handoff-code':
        out.handoffCode = flagValue(argv, ++i, flag, { allowLeadingDash: true })
        break
      case '--api-base':
        // Value-checked in main(), where the discovered MCP origin is in hand.
        out.apiBase = flagValue(argv, ++i, flag)
        break
      case '--shell-rc':
        // BOTH homes are accepted, deliberately — and the reason is now the ONLY
        // one left: a shell rc is read by the user's SHELL, which resolves it
        // through $HOME, so `detectShellRcTargets` anchors the no-flag default on
        // homedir(). Confining the override to realHome() alone would refuse the
        // very file the default writes on a moved-HOME host while still writing
        // it. Naming an rc file inside a home this process can already see is not
        // the capability being withheld here — naming a path outside both is.
        //
        // This list used to be justified by "everything else this file writes is
        // anchored on homedir(), TOKENSCOPE_DIR included". That was widening the
        // guard to match an unsafe anchor; the anchor is fixed (TOKENSCOPE_DIR is
        // on realHome() now) and the justification with it. What lands in an rc
        // file is an export line, never a credential.
        out.shellRc = assertConfinedPath(flagValue(argv, ++i, flag), {
          flag,
          roots: [realHome(), homedir()],
          allowedBasenames: SHELL_RC_BASENAMES,
        })
        break
      case '--remove':
        out.remove = true
        break
      default:
        // A stray empty token is not an argument at all.
        if (!flag.trim()) break
        assertKnownFlag(flag)
        // Accept a bare positional argument as the handoff code (documented
        // usage). A SECOND positional means the argv is not one this flow
        // produces — refuse rather than silently drop it.
        if (out.handoffCode) throw new Error('unexpected extra argument')
        out.handoffCode = flag
    }
  }
  return out
}

// ── HTTP helper (no external deps) ───────────────────────────────────────────
/**
 * POST a JSON body to `urlStr`, resolve the parsed JSON response. The URL is
 * validated via assertSafeEndpoint (S2 — closes the Copilot leg of
 * client-plugins:mitm:0003) BEFORE any request is built: this used to pick
 * `http` for ANY non-https URL with no complaint (the "plain-http fallback"),
 * which would silently downgrade a poisoned redeem endpoint (a bad --api-base,
 * or a redeemUrl derived from one) to plaintext instead of refusing it —
 * leaking the handoff code, and the server's response (which carries the
 * durable OAuth refresh token), off-box unencrypted. allowLoopback:true
 * mirrors claude-redeem.mjs's httpsPostJson (plugin-runtime.mjs) — a
 * locally-running dev server (TOKENSCOPE_API_BASE=http://localhost:3450)
 * legitimately answers on 127.0.0.1/::1.
 */
function httpsPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = assertSafeEndpoint(urlStr, { allowLoopback: true })
    } catch (err) {
      // Redact HERE, at the boundary, not at the caller. This promise's
      // rejection is printed by a generic top-level handler that interpolates
      // err.message, so rejecting with the raw guard error would put the
      // rejected endpoint on stderr. Redacting at the throw site makes the
      // property hold no matter which handler ends up printing it.
      reject(unsafeEndpointError('Redeem URL', err))
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
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`request timed out after ${HTTP_TIMEOUT_MS}ms`))
    })
    req.on('error', reject)
    req.write(bodyBuf)
    req.end()
  })
}

// ── shell-rc block helpers ────────────────────────────────────────────────────
// Earlier setups WROTE a block exporting COPILOT_OTEL_FILE_EXPORTER_PATH into the
// login and non-login init files of the user's shell. Setup now only REMOVES it.
export function detectShellRcTargets(explicit, home = homedir()) {
  // Cleanup only (setup no longer writes an rc): an explicit --shell-rc names the one
  // file; otherwise every supported rc that exists, whatever $SHELL is now, since an
  // earlier setup may have written them under a shell the user has since changed.
  if (explicit) return [explicit]
  return SHELL_RC_BASENAMES.map((b) => join(home, b)).filter((p) => existsSync(p))
}

/**
 * Remove the TokenScope block (between markers, inclusive) from content. Unless the
 * markers strictly alternate start, end, start, end, the file is left alone: a
 * nested or unmatched marker would take user lines with it.
 */
function removeBlock(content) {
  const lines = content.split('\n')
  let open = false
  for (const line of lines) {
    const t = line.trim()
    if (t !== BLOCK_START && t !== BLOCK_END) continue
    if ((t === BLOCK_START) === open) return content
    open = !open
  }
  if (open) return content
  const out = []
  let inBlock = false
  for (const line of lines) {
    if (line.trim() === BLOCK_START) {
      inBlock = true
      continue
    }
    if (line.trim() === BLOCK_END) {
      inBlock = false
      continue
    }
    if (!inBlock) out.push(line)
  }
  // Normalize trailing newlines: if the original ended with \n, keep exactly one.
  const joined = out.join('\n')
  return content.endsWith('\n') ? joined.replace(/\n+$/, '') + '\n' : joined
}

export { copilotSettingsPath }

/**
 * Turn on Copilot's EXTENSIONS feature so the CLI loads the plugin's usage extension,
 * with extension mode load_only unless the user chose a mode. settings.json is
 * Copilot's file, not ours: merge those keys into a plain JSON object (creating it
 * when absent); a symlinked or hand-written JSONC file is read but never rewritten;
 * a user's mode 'disabled', or keys in Copilot's legacy config.json (which override
 * settings.json), are never worked around. Otherwise say how to do it by hand.
 * Returns 'enabled' | 'already' | 'manual'.
 */
export function enableExtensionsFeature(path = copilotSettingsPath(), { log } = {}) {
  const HAND_EDIT = 'add "enabledFeatureFlags": { "EXTENSIONS": true } and "extensions": { "mode": "load_only" } to it'
  const manual = (why) => {
    log?.(`[tokenscope] Could not update ${path} (${why}). Enable Copilot extensions yourself: ${HAND_EDIT}, then re-run setup.`)
    return 'manual'
  }
  let settings = {}
  let link = false
  let jsonc = false
  if (existsSync(path)) {
    try {
      link = lstatSync(path).isSymbolicLink()
      ;({ settings, jsonc } = readCopilotSettings(path))
    } catch (err) {
      // A fixed reason, never err.message: a parse error quotes the file, and through a
      // symlink that could be any file, printed into the conversation.
      return manual(err instanceof SyntaxError ? 'it has syntax TokenScope cannot read' : String(err.code ?? 'unreadable'))
    }
  }
  // Copilot also reads these keys from its legacy config.json, and that file wins, so a
  // value there would silently override whatever we write here.
  const over = legacyConfigOverrides(path)
  if (Object.keys(over).length) {
    if (extensionsOn({ ...settings, ...over })) return 'already'
    return manual("Copilot's config.json defines enabledFeatureFlags or extensions, which override settings.json; move them into settings.json")
  }
  const mode = settings.extensions?.mode
  // 'disabled' is the user's own choice, and capture needs extensions loaded: never override it.
  if (mode === 'disabled') return manual('extensions are disabled in it')
  const on = extensionsOn(settings)
  const modeNote = (m) =>
    m === undefined
      ? ` Extension mode is the default (the agent can create and load extensions); for load_only, ${HAND_EDIT.replace(/^add .* and /, 'add ')}.`
      : ` Extension mode is ${m}, as you set it.`
  // Read through a symlink or a hand-written JSONC file; never rewrite either.
  if (link || jsonc) {
    if (!on) return manual(link ? 'symlink' : 'it has comments; edit it by hand')
    log?.(`[tokenscope] Copilot extensions are already enabled in ${path}.${modeNote(mode)}`)
    return 'already'
  }
  // load_only (extensions load, but the agent cannot create or reload its own in the
  // session) is set when the user has not chosen a mode; a mode they chose is kept.
  const wantMode = mode === undefined
  if (on && !wantMode) return 'already'
  const flags = settings.enabledFeatureFlags
  settings.enabledFeatureFlags = { ...(flags && typeof flags === 'object' && !Array.isArray(flags) ? flags : {}), EXTENSIONS: true }
  if (wantMode) {
    const ext = settings.extensions
    settings.extensions = { ...(ext && typeof ext === 'object' && !Array.isArray(ext) ? ext : {}), mode: 'load_only' }
  }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileAtomic(path, JSON.stringify(settings, null, 2) + '\n', 0o600)
  } catch (err) {
    // Already on: the migration stands; only the tightening could not be written.
    if (on) {
      log?.(`[tokenscope] Copilot extensions are already enabled; could not set load_only in ${path} (${err.code ?? 'unwritable'}).`)
      return 'already'
    }
    return manual(err.code ?? err.message)
  }
  log?.(`[tokenscope] Enabled Copilot extensions in ${path} (extension mode: ${settings.extensions?.mode ?? 'default'}).`)
  return 'enabled'
}

/**
 * Arm Copilot usage capture: the plugin's usage extension replaces the shell-rc span
 * exporter + forwarder (docs/design/copilot-usage-extension.md §Cutover). Removes the
 * TokenScope block a previous setup wrote into each shell rc (only files that carry
 * it are rewritten, atomically, keeping their mode; a symlinked rc is reported, not
 * replaced), once the EXTENSIONS feature is on: if it cannot be enabled, the old block
 * stays so capture is never left with neither lane. Once on, it also removes the
 * legacy forwarder's files from `projectDirs`; from then on the extension captures
 * every session, old shells included (docs/design/copilot-usage-extension.md
 * §Coexistence).
 *
 * @param {string[]} rcTargets — shell-rc files a previous setup may have written.
 * @returns {{ rcCleaned: string[], extensions: 'enabled' | 'already' | 'manual', projectsCleaned: string[] }}
 */
export function armUsageExtension(rcTargets, { log, settingsPath = copilotSettingsPath(), projectDirs = [] } = {}) {
  const rcCleaned = []
  // Make before break: without the feature the extension does not load, so the old
  // exporter stays until the user enables it.
  const extensions = enableExtensionsFeature(settingsPath, { log })
  if (extensions === 'manual') return { rcCleaned, extensions, projectsCleaned: [] }
  const projectsCleaned = removeLegacyForwarderFiles(projectDirs)
  if (projectsCleaned.length) log?.(`[tokenscope] Removed the old Copilot forwarder files from ${projectsCleaned.length} project(s).`)
  rcCleaned.push(...removeRcBlocks(rcTargets, { log }).cleaned)
  return { rcCleaned, extensions, projectsCleaned }
}

/**
 * Remove the TokenScope block from each rc that carries one: atomically, keeping the
 * file's mode; a symlinked rc is reported, not replaced; one that cannot be read or
 * rewritten is reported and skipped. Shared by migration and `--remove`.
 */
export function removeRcBlocks(rcTargets, { log } = {}) {
  const rcCleaned = []
  const skipped = []
  for (const rcPath of rcTargets) {
    // One rc that cannot be read or rewritten keeps its block and is reported; it never
    // aborts the caller (for setup, after the credentials have landed).
    try {
      if (!existsSync(rcPath)) continue
      const st = lstatSync(rcPath)
      const content = readFileSync(rcPath, 'utf8')
      const cleaned = removeBlock(content)
      if (cleaned === content) continue
      if (st.isSymbolicLink()) {
        // Replacing a link with a file would break a dotfile manager's checkout.
        log?.(`[tokenscope] ${rcPath} is a symlink: remove the "${BLOCK_START}" block from it yourself.`)
        skipped.push(rcPath)
        continue
      }
      writeFileAtomic(rcPath, cleaned, st.mode & 0o7777) // never truncate an RC file on a crash mid-write
      rcCleaned.push(rcPath)
      log?.(`[tokenscope] Removed the old TokenScope block from ${rcPath}`)
    } catch (err) {
      log?.(`[tokenscope] Could not clean ${rcPath} (${err.code ?? err.message}): remove the "${BLOCK_START}" block from it yourself.`)
      skipped.push(rcPath)
    }
  }
  return { cleaned: rcCleaned, skipped }
}

// The legacy forwarder's per-project files, and nothing else in that directory.
const LEGACY_FORWARDER_FILES = ['copilot-otel.jsonl', 'forwarder-offset', 'copilot-forwarder.pid']

/**
 * Once, at migration: delete the legacy forwarder's files from each project (its span
 * file, offset and lock) and the directory if that leaves it empty. A migrated device
 * never reads them again; spans a still-open old terminal writes meanwhile are lost,
 * which is accepted. Best-effort per project. Returns the projects cleaned.
 */
export function removeLegacyForwarderFiles(projectDirs) {
  const cleaned = []
  for (const project of new Set(projectDirs)) {
    if (typeof project !== 'string' || !isAbsolute(project)) continue
    const dir = join(project, PROJECT_LOCAL_DIR)
    try {
      if (lstatSync(dir).isSymbolicLink()) continue
    } catch {
      continue
    }
    let removed = false
    for (const f of LEGACY_FORWARDER_FILES) {
      try {
        rmSync(join(dir, f))
        removed = true
      } catch {
        /* absent */
      }
    }
    try {
      rmdirSync(dir) // only if now empty
    } catch {
      /* not empty, or gone */
    }
    if (removed) cleaned.push(project)
  }
  return cleaned
}

/**
 * The projects to clean at migration: the one setup runs in, and the folders Copilot
 * lists as trusted (where the user has run it). Copilot's config.json is read, never
 * written; if it cannot be parsed, only the current project is cleaned.
 */
export function legacyProjectDirs(cwd = process.cwd(), settingsPath = copilotSettingsPath()) {
  const dirs = [cwd]
  try {
    const cfg = readCopilotSettings(join(dirname(settingsPath), 'config.json')).settings
    if (Array.isArray(cfg?.trustedFolders)) dirs.push(...cfg.trustedFolders.filter((d) => typeof d === 'string'))
  } catch {
    /* current project only */
  }
  return dirs
}

// ── env-change detection + label classification ───────────────────────────────
// The credential/endpoint fields config.copilot-cli.json manages — always overwritten with the
// fresh redeem values. A SAME-environment re-run preserves any OTHER (user-set) key
// but rewrites these; an environment change drops everything not in this set so no
// stale cross-env field can survive at rest. Single source of truth for "managed".
const MANAGED_CONFIG_KEYS = [
  // The v2 envelope is managed, so a re-redeem repairs a mis-declared store.
  'version',
  'tool',
  'instance_id',
  'bearer_endpoint',
  'logs_endpoint',
  'oauth_token_endpoint',
  'oauth_client_id',
  'oauth_refresh_token',
  'copilot_otel_file_path',
  'otel_resource_attributes',
]

// URL host of a bearer endpoint, lowercased, or '' if absent/unparseable. The
// bearer endpoint names the deployment origin, so its host is the stable
// per-deployment key (same idea statusline.emitEnvLabel uses for Claude).
function bearerHost(endpoint) {
  try {
    return new URL((endpoint || '').trim()).host.toLowerCase()
  } catch {
    return ''
  }
}

// Human label for a deployment, DERIVED from the bearer (and optional logs) host —
// never hardcoded. Inlined rather than imported from statusline.mjs because the
// standalone copilot-plugin distribution ships copilot-redeem.mjs WITHOUT its
// sibling scripts (only the files in sync-copilot-plugin.mjs's list, which
// statusline.mjs is not one of), so it cannot import them. Mirrors
// statusline.emitEnvLabel's classification. Null when nothing recognised/present.
export function emitEnvLabel(bearerEndpoint, logsEndpoint) {
  const bearer = bearerHost(bearerEndpoint)
  const logs = bearerHost(logsEndpoint)
  if (!bearer && !logs) return null
  // Match the bounded product token `tokenscope-<env>` in EITHER host. Both \b
  // anchors matter: the right rejects tokenscope-development, the left rejects
  // mytokenscope-dev. The space join keeps a token from spanning the two hosts.
  const m = `${bearer} ${logs}`.match(/\btokenscope-(dev|sandbox|staging|production|prod)\b/)
  if (m) {
    const name = m[1] === 'production' ? 'prod' : m[1]
    return name.charAt(0).toUpperCase() + name.slice(1)
  }
  const isLocal = (h) => /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(h)
  if (isLocal(bearer) || isLocal(logs)) return 'Local'
  // Unrecognised deployment — prefer the bearer host (it names the deployment).
  return bearer || logs
}

// Detect whether the redeem points at a DIFFERENT deployment than the one already
// configured, by comparing the existing config's bearer host vs the new one.
// Returns { changed, oldLabel, newLabel }. `changed` is false on a fresh device (no
// existing bearer host) and on a same-host re-run; true only when both hosts are
// present AND differ — the cross-environment transition this guards. Exported for tests.
export function detectEnvChange(existingConfig, newBundle) {
  const oldHost = bearerHost(existingConfig?.bearer_endpoint)
  const newHost = bearerHost(newBundle?.TOKENSCOPE_BEARER_ENDPOINT)
  const changed = Boolean(oldHost) && Boolean(newHost) && oldHost !== newHost
  return {
    changed,
    oldLabel:
      emitEnvLabel(existingConfig?.bearer_endpoint, existingConfig?.logs_endpoint) ??
      oldHost ??
      null,
    newLabel:
      emitEnvLabel(newBundle?.TOKENSCOPE_BEARER_ENDPOINT, newBundle?.TOKENSCOPE_LOGS_ENDPOINT) ??
      newHost ??
      null,
  }
}

// ── ~/.tokenscope/config.copilot-cli.json ──────────────────────────────────────────
// CROSS-ENVIRONMENT TRANSITION: read any existing config first. When it points at a
// DIFFERENT deployment (the bearer host changed — Sandbox→Dev, Dev→Prod), write a
// CLEAN config so stale cross-env credentials/endpoints from the old deployment
// cannot survive at rest. On a same-environment re-run, preserve any legitimately
// user-set (non-managed) keys but always overwrite the credential/endpoint fields
// with the fresh values. Returns the env-change descriptor so main() can print a
// one-line note (never a credential). Mirrors claude-redeem's writeClaudeSettings.
function writeTokenscopeConfig(bundle, oauthRefreshToken, oauthClientId, overrideDir) {
  const targetDir = overrideDir ?? TOKENSCOPE_DIR
  mkdirSync(targetDir, { recursive: true, mode: 0o700 })

  // config.copilot-cli.json — the stable, forwarder-readable store.
  // IMPORTANT: oauth_refresh_token lives HERE, not in oauth-access.copilot-cli.json.
  // otel-headers-helper.sh uses oauth-access.copilot-cli.json as its *access-token cache*
  // (it mv's a {access_token,expires_at} object over it on every refresh) so
  // putting the refresh_token there would destroy it on the first bearer mint.
  // Per-tool: this lane owns config.copilot-cli.json outright, so a whole-file
  // write is correct. docs/design/device-store-per-tool-sections.md
  const configPath = deviceStorePath('copilot-cli', targetDir)

  // Read any existing config so we can (a) detect an environment change and (b) on a
  // same-env re-run preserve user-set extras. A present-but-unparseable config is
  // ignored (treated as absent) rather than aborting the redeem — the fresh write
  // below replaces it cleanly with valid JSON.
  let existingConfig = null
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existingConfig = parsed
    } catch {
      existingConfig = null
    }
  }
  const envChange = detectEnvChange(existingConfig, bundle)

  // The fresh, managed credential/endpoint fields — always written with this redeem's
  // values, regardless of env change.
  const managed = {
    version: 2,
    tool: 'copilot-cli',
    instance_id: bundle.instance_id,
    bearer_endpoint: bundle.TOKENSCOPE_BEARER_ENDPOINT,
    logs_endpoint: bundle.TOKENSCOPE_LOGS_ENDPOINT,
    oauth_token_endpoint: bundle.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT,
    oauth_client_id: oauthClientId,
    oauth_refresh_token: oauthRefreshToken,
    otel_resource_attributes: bundle.OTEL_RESOURCE_ATTRIBUTES,
  }

  // SAME environment (or fresh device): carry forward any legitimately user-set
  // (non-managed) keys, then overwrite the managed fields with the fresh values.
  // ENVIRONMENT CHANGE: start from a CLEAN object so no stale cross-env field (an
  // old deployment's endpoints, a foreign oauth credential, or anything the old
  // config carried) can survive at rest pointing at the wrong deployment.
  // Same rule the helper refuses on; a bad bundle fails HERE, loudly, not at
  // the next mint with a store nothing can repair.
  assertStoreConsistent('copilot-cli', managed)
  const configData = { ...managed }
  if (!envChange.changed && existingConfig) {
    for (const [k, v] of Object.entries(existingConfig)) {
      if (!MANAGED_CONFIG_KEYS.includes(k)) configData[k] = v
    }
  }

  // Atomic temp+rename: the forwarder daemon loadConfig()s this file every tick —
  // a re-redeem must never race it into a half-written read.
  writeFileAtomic(configPath, JSON.stringify(configData, null, 2) + '\n', 0o600)

  // The access-token cache (oauth-access.copilot-cli.json) is NOT touched: the
  // helper is its only writer, and it is bound to the bearer endpoint it was
  // minted for, so a cache from a previous deployment fails the binding and is
  // re-minted without anyone clearing it (design doc, cache section).
  return envChange
}

// ── redeem-bundle endpoint validation ─────────────────────────────────────────
/**
 * Validate the redeem response's server-supplied endpoint bundle is safe to
 * persist — called BEFORE writeTokenscopeConfig writes it into config.copilot-cli.json.
 * Mirrors claude-redeem.mjs's assertClaudeRedeemResponse (S1 fix 3 — "S1's fix
 * said 'both redeem paths'; this is the second one"): a compromised/MITM'd
 * redeem response could otherwise plant a plaintext or malformed endpoint into
 * config.copilot-cli.json, and every SUBSEQUENT bearer mint (otel-headers-helper.sh, every
 * ~29 min) or span forward (copilot-forwarder.mjs's httpsPost, every tick) would
 * then send the durable credential / span data wherever that endpoint points.
 * Loopback allowed — a locally-running dev server legitimately returns its own
 * loopback address. Throws a descriptive Error on the first unsafe/missing
 * field (assertSafeEndpoint's own "endpoint is empty" covers an absent field,
 * so this doubles as the presence check writeTokenscopeConfig itself does not
 * do). Exported for unit testing.
 */
export function assertSafeRedeemBundle(bundle) {
  for (const [label, value] of [
    ['TOKENSCOPE_BEARER_ENDPOINT', bundle?.TOKENSCOPE_BEARER_ENDPOINT],
    ['TOKENSCOPE_LOGS_ENDPOINT', bundle?.TOKENSCOPE_LOGS_ENDPOINT],
    ['TOKENSCOPE_OAUTH_TOKEN_ENDPOINT', bundle?.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT],
  ]) {
    try {
      assertSafeEndpoint(value, { allowLoopback: true })
    } catch (err) {
      // REASON ONLY, never the value. This bundle is SERVER-supplied and the
      // whole point of validating it is that we do not trust it; echoing the
      // rejected value into a log (which the caller prints) would carry
      // untrusted bytes to a clear-text sink. The field label plus a stable
      // reason code is enough to diagnose.
      //
      // This previously attached `{ cause: err }` on the belief that a cause is
      // kept "for a debugger without printing it". That belief was FALSE — Node
      // prints the cause chain both for console.error(err) and for an uncaught
      // throw, so the rejected value reached a clear-text sink through a field
      // this call site never named (CodeQL js/clear-text-logging #7).
      // unsafeEndpointError() now enforces the redaction structurally.
      throw unsafeEndpointError(`Redeem bundle's ${label}`, err)
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const rcTargets = detectShellRcTargets(args.shellRc)

  if (args.remove) {
    const { cleaned, skipped } = removeRcBlocks(rcTargets, { log: (m) => console.log(m) })
    if (!cleaned.length && !skipped.length) console.log('[tokenscope] No TokenScope env block found — nothing to remove')
    return
  }

  if (!args.handoffCode) {
    console.error('[tokenscope] --handoff-code is required')
    process.exit(1)
  }

  // Resolve the full redeem URL. S2 fix: a naive startsWith('http') guard accepts
  // http:// as readily as https:// — replaced with assertSafeEndpoint so a
  // misconfigured (or MITM'd) --api-base is refused with a clear message here,
  // rather than relying solely on httpsPost's own downstream check.
  // allowLoopback:true — local dev legitimately targets :3450.
  //
  // WHAT DECIDES THE HOST. Discovery: the MCP registration in the user's own
  // client config, then the plugin's bundled .mcp.json — files a human wrote,
  // outside the conversation and outside any checked-out repository.
  // `--api-base` may SELECT one of those origins (or loopback); a value naming
  // anything else is warned about and dropped, because the argv of this process
  // is composed by a model and this request carries a live single-use handoff
  // code whose answer is a durable emit credential. `--redeem-url`, which named
  // the POST target outright, is gone for the same reason.
  //
  // TOKENSCOPE_API_BASE is deliberately NOT in this chain either: it is
  // repo-settable, and a process cannot tell a repo-supplied value from one the
  // developer exported. (It was once read here through a `??` chain in which an
  // EMPTY value counted as an authoritative answer and suppressed discovery
  // outright — the fresh-device "Cannot resolve a safe redeem URL" failure.
  // acceptApiBaseArg treats a blank as absent for the same reason.)
  const discovered = discoverApiBaseFromMcpJson()
  const apiBase =
    acceptApiBaseArg(args.apiBase, { allowed: [discovered], warn: (m) => console.error(m) }) ??
    discovered ??
    ''
  const redeemUrl = `${apiBase}/api/v1/setup/redeem`
  try {
    assertSafeEndpoint(redeemUrl, { allowLoopback: true })
  } catch (err) {
    // Route through unsafeEndpointError for the SAME reason the bundle-field
    // sites do: assertSafeEndpoint's own message embeds the rejected value, and
    // this one is resolved partly from .mcp.json, so interpolating err.message
    // here prints an untrusted endpoint to stderr. The reason code is all a user
    // needs to act on.
    //
    // The remedy named is REGISTRATION, not the flag. `--api-base` can only
    // select an origin this device already knows, so on a device where nothing
    // was discovered the only values it accepts are loopback ones — telling the
    // user to "pass --api-base <your host>" here would be advice that cannot
    // work.
    const safe = unsafeEndpointError('Resolved redeem URL', err)
    console.error(
      `[tokenscope] Cannot resolve a safe redeem URL (${safe.reason}) — register the tokenscope MCP ` +
        'server in your own client config (~/.copilot/mcp-config.json) so this helper can discover ' +
        'its origin. --api-base only selects an origin already known here (loopback, or that ' +
        'registration).',
    )
    process.exit(1)
  }

  console.log('[tokenscope] Redeeming handoff...')
  let resp
  try {
    resp = await httpsPost(redeemUrl, { handoff_code: args.handoffCode })
  } catch (err) {
    console.error(`[tokenscope] Redeem failed: ${err.message}`)
    process.exit(1)
  }

  // Validate Copilot bundle — do NOT log the raw response (it contains oauth_refresh_token).
  const bundle = resp.telemetry?.copilot
  if (!bundle || !bundle.instance_id || !bundle.TOKENSCOPE_BEARER_ENDPOINT) {
    console.error(
      '[tokenscope] Redeem did not return a Copilot bundle — was provision_emit called with tool=copilot-cli?',
    )
    console.error(
      '[tokenscope] Validation: bundle=' +
        !!bundle +
        ' instance_id=' +
        !!bundle?.instance_id +
        ' bearer_endpoint=' +
        !!bundle?.TOKENSCOPE_BEARER_ENDPOINT,
    )
    process.exit(1)
  }
  // M3 fix: validate top-level OAuth fields before writing config.copilot-cli.json.
  // If the server returns a partial response (schema mismatch, old server version),
  // writing config.copilot-cli.json without oauth_refresh_token would silently re-introduce the
  // B1 defect (mintBearer passes undefined to otel-headers-helper.sh → exits 1).
  if (!resp.oauth_refresh_token || typeof resp.oauth_refresh_token !== 'string') {
    console.error(
      '[tokenscope] Redeem response missing oauth_refresh_token — server may be out of date',
    )
    process.exit(1)
  }
  if (!resp.oauth_client_id || typeof resp.oauth_client_id !== 'string') {
    console.error(
      '[tokenscope] Redeem response missing oauth_client_id — server may be out of date',
    )
    process.exit(1)
  }
  // S2 fix — validate the server-supplied endpoint bundle BEFORE persisting it
  // (see assertSafeRedeemBundle above). Must run before writeTokenscopeConfig.
  try {
    assertSafeRedeemBundle(bundle)
  } catch (err) {
    console.error(`[tokenscope] ${err.message}`)
    process.exit(1)
  }

  // 1. Write the durable credentials, under the PASSWD home (see TOKENSCOPE_DIR).
  //
  // Under a moved HOME that is a directory the user's own tooling may not look
  // in, so say so — the alternative (following $HOME, or falling back to it)
  // hands a live refresh token to whoever moved HOME. Name both paths so it is
  // fixable rather than merely reported. Mirrors claude-redeem.mjs's warning.
  if (realHome() !== homedir()) {
    console.error(
      `[tokenscope] WARN: $HOME (${homedir()}) differs from your account's real home (${realHome()}). ` +
        `Writing the credential to the real home (${TOKENSCOPE_DIR}); anything still reading $HOME ` +
        'will not see it until HOME is corrected.',
    )
  }
  const envChange = writeTokenscopeConfig(bundle, resp.oauth_refresh_token, resp.oauth_client_id)
  // Cross-environment transition note (never prints a credential — only env labels).
  // The bearer host changed, so the device just moved deployments and config.copilot-cli.json was
  // written CLEAN (stale old-env credentials/endpoints dropped, not carried forward).
  if (envChange?.changed) {
    const from = envChange.oldLabel ?? 'previous'
    const to = envChange.newLabel ?? 'new'
    console.log(
      `[tokenscope] Environment changed: ${from} → ${to} — wrote a fresh config for the new environment (old credentials and endpoints dropped).`,
    )
  }
  console.log(`[tokenscope] Wrote credentials to ${TOKENSCOPE_DIR}`)

  // 2. Usage capture: the plugin's usage extension (docs/design/copilot-usage-extension.md).
  // Enables Copilot's EXTENSIONS feature, then removes the shell-rc exporter block a
  // previous setup wrote; nothing new is written into the shell or the repository.
  const armed = armUsageExtension(rcTargets, { log: (m) => console.log(m), projectDirs: legacyProjectDirs() })

  // 3. (hooks handled by copilot-plugin/hooks/hooks.json — the canonical plugin mechanism.
  //    copilot-redeem.mjs no longer writes ~/.copilot/config.json hooks to avoid a
  //    competing wiring with inconsistent casing/args — B3 fix.)

  console.log('')
  console.log('[tokenscope] ✓ Copilot enrolled successfully.')
  console.log(`[tokenscope]   Instance ID: ${bundle.instance_id}`)
  if (armed.extensions === 'manual') {
    console.log('[tokenscope]   Usage capture needs Copilot extensions enabled (see the message above). Until then only a')
    console.log('[tokenscope]   terminal that still exports the old variable is captured. Re-run setup once they are enabled.')
  }
  console.log('[tokenscope]   Restart copilot: usage is captured by the TokenScope usage extension from the next session.')
}

// Only run main() when executed directly (not when imported as a module for testing).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[tokenscope] Fatal:', err.message)
    process.exit(1)
  })
}

// Named exports for unit testing only — not part of the public API.
// TOKENSCOPE_DIR is exported so a test can assert the ANCHOR (that a moved $HOME
// does not move the credential store) without writing to the real one.
export { writeTokenscopeConfig, removeBlock, PROJECT_LOCAL_DIR, parseArgs, TOKENSCOPE_DIR }
