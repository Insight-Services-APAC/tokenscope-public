#!/usr/bin/env node
/*
 * copilot-redeem — local helper that redeems a TokenScope emit handoff for a
 * Copilot CLI device. Called by the tokenscope-setup skill AFTER provision_emit
 * returns a handoff_code + redeem_url. Runs process→server (NOT through the
 * MCP/chat), so the durable emit credential never enters the LLM's context.
 *
 * Writes:
 *   1. ~/.tokenscope/config.json — durable emit creds + endpoints (mode 0600).
 *   2. ~/.tokenscope/oauth-access.json — OAuth creds (mode 0600). (same shape
 *      as otel-headers-helper.sh expects)
 *   3. Shell RC files (login AND non-login: ~/.bashrc + ~/.profile [+ ~/.bash_profile
 *      if present]; or ~/.zshrc [+ ~/.zprofile/~/.zshenv]) — a DELIMITED REMOVABLE
 *      BLOCK (`# >>> TokenScope >>> … # <<< TokenScope <<<`), idempotent by markers.
 *      Exports only COPILOT_OTEL_FILE_EXPORTER_PATH (attribution is config-driven).
 *   4. The Copilot plugin hooks.json provides sessionStart/Stop lifecycle —
 *      no ~/.copilot/config.json write needed here.
 *
 * Usage (both forms accepted):
 *   node copilot-redeem.mjs <handoff_code> [--redeem-url <url>] \
 *       [--api-base <base>] [--shell-rc <path>]
 *   node copilot-redeem.mjs --handoff-code <code> [--redeem-url <url>] \
 *       [--api-base <base>] [--shell-rc <path>]
 *
 * --remove: removes the TokenScope block from the shell RC and exits 0
 *           (the analogue of /tokenscope:statusline-toggle disable).
 *
 * Env:
 *   TOKENSCOPE_API_BASE — the TokenScope server base URL (e.g. https://ts.example.com).
 *                         Required unless --api-base is passed or --redeem-url is absolute.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import http from 'node:http'

// ── constants ────────────────────────────────────────────────────────────────
const BLOCK_START = '# >>> TokenScope >>>'
const BLOCK_END = '# <<< TokenScope <<<'
const TOKENSCOPE_DIR = join(homedir(), '.tokenscope')
/**
 * Per-PROJECT telemetry dir, RELATIVE to the project root (= Copilot's launch cwd).
 * The span file, byte-offset, and singleton lock all live here so telemetry travels
 * with the PROJECT, never HOME (Copilot runs container-per-project; only the device
 * credential — ~/.tokenscope/config.json — stays in HOME). NOT an absolute path: the
 * shell-rc export below is deliberately relative so Copilot's file exporter resolves
 * it against the project root, and config.json carries the same relative value as the
 * fallback the forwarder resolves against ITS cwd (the project root).
 */
const PROJECT_LOCAL_DIR = '.tokenscope.local'
/** Network timeout for the redeem POST — a black-holed endpoint must fail loud, not hang. */
const HTTP_TIMEOUT_MS = 30_000

// ── atomic file write (temp + rename) ────────────────────────────────────────
// The forwarder daemon loadConfig()s config.json every tick and a crash mid-write
// must never truncate a shell RC file — write to a per-process temp then rename
// (atomic on the same filesystem). Same pattern as claude-redeem's writeClaudeSettings.
function writeFileAtomic(path, content, mode) {
  const tmp = `${path}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', ...(mode != null ? { mode } : {}) })
    if (mode != null) chmodSync(tmp, mode) // defeat umask
    renameSync(tmp, path)
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch { /* best-effort cleanup */ }
    throw err
  }
}

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { handoffCode: null, redeemUrl: null, apiBase: null, shellRc: null, remove: false }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--handoff-code': out.handoffCode = argv[++i]; break
      case '--redeem-url':   out.redeemUrl = argv[++i]; break
      case '--api-base':     out.apiBase = argv[++i]; break
      case '--shell-rc':     out.shellRc = argv[++i]; break
      case '--remove':       out.remove = true; break
      default:
        // Accept a bare positional argument as the handoff code (documented usage).
        if (!argv[i].startsWith('--') && !out.handoffCode) out.handoffCode = argv[i]
    }
  }
  return out
}

// ── HTTP helper (no external deps) ───────────────────────────────────────────
function httpsPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const bodyBuf = Buffer.from(JSON.stringify(body), 'utf8')
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
        Accept: 'application/json',
      },
    }, (res) => {
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)) } catch { reject(new Error(`Non-JSON response: ${data.slice(0, 200)}`)) }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`))
        }
      })
    })
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`request timed out after ${HTTP_TIMEOUT_MS}ms`))
    })
    req.on('error', reject)
    req.write(bodyBuf)
    req.end()
  })
}

// ── shell-rc block helpers ────────────────────────────────────────────────────
// Copilot may launch from a NON-LOGIN shell (reads ~/.bashrc) OR a LOGIN shell
// (reads ~/.bash_profile / ~/.profile, and skips ~/.bashrc). SSH, tmux, and many
// terminals open login shells — so writing only ~/.bashrc (the old behaviour) left
// `COPILOT_OTEL_FILE_EXPORTER_PATH` unset on those launches and Copilot emitted
// nothing. Write the block to ALL relevant init files so the export loads either way.
export function detectShellRcTargets(explicit, home = homedir(), shell = process.env.SHELL ?? '') {
  if (explicit) return [explicit]
  if (shell.toLowerCase().includes('zsh')) {
    // zsh: ~/.zshrc (interactive, incl. interactive-login); + ~/.zprofile (login) and
    // ~/.zshenv (read by ALL zsh, incl. non-interactive) when they already exist.
    const t = [join(home, '.zshrc')]
    for (const f of ['.zprofile', '.zshenv']) if (existsSync(join(home, f))) t.push(join(home, f))
    return t
  }
  // bash / sh. Non-login bash reads ~/.bashrc; login bash reads the FIRST of
  // ~/.bash_profile, ~/.bash_login, ~/.profile; sh/dash login reads ~/.profile.
  // ~/.bashrc + ~/.profile cover non-login + the common login path; also write
  // ~/.bash_profile / ~/.bash_login when they exist (each shadows ~/.profile for
  // login bash). We never CREATE those two — creating one would itself change
  // bash-login resolution (it would stop falling back to ~/.profile).
  const t = [join(home, '.bashrc'), join(home, '.profile')]
  for (const f of ['.bash_profile', '.bash_login']) {
    if (existsSync(join(home, f))) t.push(join(home, f))
  }
  return t
}

/** Remove the TokenScope block (between markers, inclusive) from content. */
function removeBlock(content) {
  const lines = content.split('\n')
  const out = []
  let inBlock = false
  for (const line of lines) {
    if (line.trim() === BLOCK_START) { inBlock = true; continue }
    if (line.trim() === BLOCK_END) { inBlock = false; continue }
    if (!inBlock) out.push(line)
  }
  // Normalize trailing newlines: if the original ended with \n, keep exactly one.
  const joined = out.join('\n')
  return content.endsWith('\n') ? joined.replace(/\n+$/, '') + '\n' : joined
}

/** Replace or insert the TokenScope block idempotently. */
function upsertBlock(content, envLines) {
  const stripped = removeBlock(content)
  const block = [BLOCK_START, ...envLines, BLOCK_END].join('\n')
  // Append with a separator blank line.
  const base = stripped.endsWith('\n') ? stripped : stripped + '\n'
  return base + '\n' + block + '\n'
}

/**
 * Arm Copilot span emission: write the RELATIVE `COPILOT_OTEL_FILE_EXPORTER_PATH`
 * export into each shell-rc target (idempotent per file). This is the ONLY trigger
 * Copilot's file exporter honours, so both the manual redeem AND emit-on-install enroll
 * must call it — otherwise Copilot writes spans nowhere and the forwarder tails an empty
 * file. The path is deliberately relative so each project's Copilot resolves it against
 * its own launch cwd (= project root); see the DOGFOOD-VERIFY note in main().
 *
 * @param {string[]} rcTargets — shell-rc files to write (from detectShellRcTargets).
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {string[]} the rcTargets written (for caller logging).
 */
export function armOtelExporterRc(rcTargets, { log } = {}) {
  const otelFilePath = join(PROJECT_LOCAL_DIR, 'copilot-otel.jsonl')
  const envLines = [
    `export COPILOT_OTEL_FILE_EXPORTER_PATH=${JSON.stringify(otelFilePath)}`,
  ]
  // Write to EVERY target (login + non-login init files) so the export loads no
  // matter how Copilot's shell is launched. upsertBlock is idempotent per file.
  for (const rcPath of rcTargets) {
    const rcContent = existsSync(rcPath) ? readFileSync(rcPath, 'utf8') : ''
    writeFileAtomic(rcPath, upsertBlock(rcContent, envLines)) // never truncate an RC file on a crash mid-write
    if (log) log(`[tokenscope] Wrote env var to ${rcPath}`)
  }
  return rcTargets
}

// ── env-change detection + label classification ───────────────────────────────
// The credential/endpoint fields config.json manages — always overwritten with the
// fresh redeem values. A SAME-environment re-run preserves any OTHER (user-set) key
// but rewrites these; an environment change drops everything not in this set so no
// stale cross-env field can survive at rest. Single source of truth for "managed".
const MANAGED_CONFIG_KEYS = [
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
// sibling scripts (only the four vendored files), so it cannot import them. Mirrors
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
    oldLabel: emitEnvLabel(existingConfig?.bearer_endpoint, existingConfig?.logs_endpoint) ?? oldHost ?? null,
    newLabel: emitEnvLabel(newBundle?.TOKENSCOPE_BEARER_ENDPOINT, newBundle?.TOKENSCOPE_LOGS_ENDPOINT) ?? newHost ?? null,
  }
}

// ── ~/.tokenscope/config.json ─────────────────────────────────────────────────
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

  // config.json — the stable, forwarder-readable store.
  // IMPORTANT: oauth_refresh_token lives HERE, not in oauth-access.json.
  // otel-headers-helper.sh uses oauth-access.json as its *access-token cache*
  // (it mv's a {access_token,expires_at} object over it on every refresh) so
  // putting the refresh_token there would destroy it on the first bearer mint.
  const configPath = join(targetDir, 'config.json')

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
    instance_id: bundle.instance_id,
    bearer_endpoint: bundle.TOKENSCOPE_BEARER_ENDPOINT,
    logs_endpoint: bundle.TOKENSCOPE_LOGS_ENDPOINT,
    oauth_token_endpoint: bundle.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT,
    oauth_client_id: oauthClientId,
    oauth_refresh_token: oauthRefreshToken,
    // PER-PROJECT, RELATIVE telemetry path. Telemetry + forwarder state live with the
    // PROJECT (`<project-root>/.tokenscope.local/`), NOT in HOME — Copilot runs
    // container-per-project, so the span file belongs to the project; only this
    // config.json (the device credential) stays in HOME. We store the RELATIVE value
    // (not join(targetDir, …)) so the forwarder's fallback resolves it against ITS cwd
    // (= the project root). A HOME-absolute fallback would silently drag the forwarder
    // back to the old per-HOME model on a host where COPILOT_OTEL_FILE_EXPORTER_PATH
    // was somehow unset.
    copilot_otel_file_path: join(PROJECT_LOCAL_DIR, 'copilot-otel.jsonl'),
    otel_resource_attributes: bundle.OTEL_RESOURCE_ATTRIBUTES,
  }

  // SAME environment (or fresh device): carry forward any legitimately user-set
  // (non-managed) keys, then overwrite the managed fields with the fresh values.
  // ENVIRONMENT CHANGE: start from a CLEAN object so no stale cross-env field (an
  // old deployment's endpoints, a foreign oauth credential, or anything the old
  // config carried) can survive at rest pointing at the wrong deployment.
  const configData = { ...managed }
  if (!envChange.changed && existingConfig) {
    for (const [k, v] of Object.entries(existingConfig)) {
      if (!MANAGED_CONFIG_KEYS.includes(k)) configData[k] = v
    }
  }

  // Atomic temp+rename: the forwarder daemon loadConfig()s this file every tick —
  // a re-redeem must never race it into a half-written read.
  writeFileAtomic(configPath, JSON.stringify(configData, null, 2) + '\n', 0o600)

  // oauth-access.json — the helper's access-token cache (access_token + expires_at only).
  // Written as an empty initial placeholder; otel-headers-helper.sh will populate and
  // overwrite it on first bearer mint. Do NOT store the refresh_token here.
  // SKIP when the file already exists (re-redeem): clobbering a live cache would
  // discard a perfectly valid access token for no reason — the helper self-heals a
  // superseded one anyway. EXCEPTION: on an environment change the cached access token
  // was minted by the OLD deployment's credential and is useless against the new
  // bearer endpoint, so reset it to the empty placeholder (the helper re-mints).
  const oauthPath = join(targetDir, 'oauth-access.json')
  if (!existsSync(oauthPath) || envChange.changed) {
    const oauthData = { access_token: '', expires_at: 0 }
    writeFileAtomic(oauthPath, JSON.stringify(oauthData, null, 2) + '\n', 0o600)
  }

  return envChange
}



// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const rcTargets = detectShellRcTargets(args.shellRc)

  if (args.remove) {
    let removed = 0
    for (const rcPath of rcTargets) {
      if (!existsSync(rcPath)) continue
      const content = readFileSync(rcPath, 'utf8')
      const stripped = removeBlock(content)
      if (stripped !== content) {
        writeFileAtomic(rcPath, stripped) // never truncate an RC file on a crash mid-write
        console.log(`[tokenscope] Removed TokenScope env block from ${rcPath}`)
        removed++
      }
    }
    if (removed === 0) console.log('[tokenscope] No TokenScope env block found — nothing to remove')
    return
  }

  if (!args.handoffCode) {
    console.error('[tokenscope] --handoff-code is required')
    process.exit(1)
  }

  // Resolve the full redeem URL
  const apiBase = args.apiBase ?? process.env.TOKENSCOPE_API_BASE ?? ''
  const redeemPath = args.redeemUrl ?? '/api/v1/setup/redeem'
  const redeemUrl = redeemPath.startsWith('http') ? redeemPath : `${apiBase}${redeemPath}`
  if (!redeemUrl.startsWith('http')) {
    console.error('[tokenscope] Cannot resolve redeem URL — pass --api-base or TOKENSCOPE_API_BASE')
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
    console.error('[tokenscope] Redeem did not return a Copilot bundle — was provision_emit called with tool=copilot-cli?')
    console.error('[tokenscope] Validation: bundle=' + (!!bundle) + ' instance_id=' + (!!bundle?.instance_id) + ' bearer_endpoint=' + (!!bundle?.TOKENSCOPE_BEARER_ENDPOINT))
    process.exit(1)
  }
  // M3 fix: validate top-level OAuth fields before writing config.json.
  // If the server returns a partial response (schema mismatch, old server version),
  // writing config.json without oauth_refresh_token would silently re-introduce the
  // B1 defect (mintBearer passes undefined to otel-headers-helper.sh → exits 1).
  if (!resp.oauth_refresh_token || typeof resp.oauth_refresh_token !== 'string') {
    console.error('[tokenscope] Redeem response missing oauth_refresh_token — server may be out of date')
    process.exit(1)
  }
  if (!resp.oauth_client_id || typeof resp.oauth_client_id !== 'string') {
    console.error('[tokenscope] Redeem response missing oauth_client_id — server may be out of date')
    process.exit(1)
  }

  // 1. Write ~/.tokenscope/ credentials
  const envChange = writeTokenscopeConfig(bundle, resp.oauth_refresh_token, resp.oauth_client_id)
  // Cross-environment transition note (never prints a credential — only env labels).
  // The bearer host changed, so the device just moved deployments and config.json was
  // written CLEAN (stale old-env credentials/endpoints dropped, not carried forward).
  if (envChange?.changed) {
    const from = envChange.oldLabel ?? 'previous'
    const to = envChange.newLabel ?? 'new'
    console.log(`[tokenscope] Environment changed: ${from} → ${to} — wrote a fresh config for the new environment (old credentials and endpoints dropped).`)
  }
  console.log(`[tokenscope] Wrote credentials to ${TOKENSCOPE_DIR}`)

  // 2. Write shell-rc env block (idempotent).
  // ONLY the file-exporter path goes in the shell rc — and deliberately so:
  //   - It is the single var Copilot genuinely needs to emit (its file exporter
  //     activates on COPILOT_OTEL_FILE_EXPORTER_PATH; Copilot has no config-file
  //     way to set it). It has no hash to corrupt, and Claude Code ignores it — so
  //     it cannot collide with a co-installed Claude.
  //   - OTEL_RESOURCE_ATTRIBUTES is intentionally NOT exported. It is a SHARED
  //     OTel var: exporting Copilot's value would clobber Claude Code's (and vice
  //     versa) in any shell that launches both, silently mis-attributing one to
  //     the other. Attribution (instance / project / tool) is instead stamped by
  //     the forwarder from ~/.tokenscope/config.json (see copilot-forwarder.mjs),
  //     so plain `copilot` Just Works with no per-tool OTel env in the shell.
  //
  // PER-PROJECT, RELATIVE path (`.tokenscope.local/copilot-otel.jsonl`). Copilot runs
  // container-per-project; telemetry must land WITH the project, not in HOME. A
  // relative value is resolved by Copilot's file exporter against the LAUNCH cwd (=
  // the project root), so a single shell-rc export Just Works across every project the
  // dev opens — each writes its own `<project>/.tokenscope.local/copilot-otel.jsonl`
  // and the per-project forwarder tails the one in ITS cwd.
  //
  // ⚠️ DOGFOOD-VERIFY — the ONE unverified item in this re-architecture: that Copilot's
  // OTEL file exporter resolves a RELATIVE COPILOT_OTEL_FILE_EXPORTER_PATH against the
  // process launch cwd (not against $HOME or a Copilot-internal dir). If a dogfood run
  // shows Copilot writes the relative path somewhere other than the project root, the
  // fallback (NOT built unless trivial) is a tiny `copilot` shell wrapper/alias that
  // exports an ABSOLUTE `COPILOT_OTEL_FILE_EXPORTER_PATH="$PWD/.tokenscope.local/copilot-otel.jsonl"`
  // immediately before exec'ing the real `copilot` — documented in
  // docs/build/copilot-followups.md, do not build it speculatively.
  armOtelExporterRc(rcTargets, { log: (m) => console.log(m) })

  // 3. (hooks handled by copilot-plugin/hooks/hooks.json — the canonical plugin mechanism.
  //    copilot-redeem.mjs no longer writes ~/.copilot/config.json hooks to avoid a
  //    competing wiring with inconsistent casing/args — B3 fix.)

  console.log('')
  console.log('[tokenscope] ✓ Copilot CLI enrolled successfully.')
  console.log(`[tokenscope]   Instance ID: ${bundle.instance_id}`)
  console.log('[tokenscope]   Restart your terminal (or run: source ' + rcTargets[0] + ')')
  console.log('[tokenscope]   The Copilot plugin hooks.json provides sessionStart/Stop lifecycle.')
  console.log('[tokenscope]   Start a new `copilot` session — spans will forward automatically.')
}

// Only run main() when executed directly (not when imported as a module for testing).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[tokenscope] Fatal:', err.message)
    process.exit(1)
  })
}

// Named exports for unit testing only — not part of the public API.
export { writeTokenscopeConfig, removeBlock, upsertBlock, PROJECT_LOCAL_DIR }
