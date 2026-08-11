#!/usr/bin/env node
/*
 * claude-redeem — local helper that redeems a TokenScope emit handoff for a
 * Claude Code device. Called by the tokenscope-setup skill AFTER provision_emit
 * returns a handoff_code + redeem_command. Runs process→server (NOT through the
 * MCP/chat), so the durable emit credential never enters the LLM's context.
 *
 * This is the Claude-Code analogue of copilot-redeem.mjs. The cutover to the
 * MCP-first OAuth client (commit c88228b) deleted the old enrol-time global
 * writer (enrol.mjs + env-builder's buildDeviceEnvBlock) on the premise that
 * `provision_emit → /setup/redeem` would replace it — but only the Copilot
 * redeem helper was ever written, so claude-code lost its global-settings writer
 * entirely. This restores it.
 *
 * Writes (merging, never clobbering):
 *   ~/.claude/settings.json (mode 0600, atomic temp+rename) —
 *     - otelHeadersHelper: absolute path to scripts/otel-headers-helper.sh (the
 *       only way to configure the Azure Monitor Bearer as a refreshing helper).
 *     - env: CLAUDE_CODE_ENABLE_TELEMETRY + logs-only OTLP plumbing +
 *       TOKENSCOPE_BEARER_ENDPOINT + the durable OAuth emit credential
 *       (TOKENSCOPE_OAUTH_REFRESH_TOKEN/_TOKEN_ENDPOINT/_CLIENT_ID) +
 *       OTEL_RESOURCE_ATTRIBUTES (tokenscope.instance_id=<sid>,tool=claude-code).
 *   Pre-existing top-level keys (e.g. permissions, statusLine, otelHeadersHelper)
 *   are always preserved. Same-environment re-runs rotate the credential in place.
 *   When the redeem points at a DIFFERENT deployment than the one currently
 *   configured (the bearer-endpoint host changed — Sandbox→Dev, Dev→Prod), the
 *   env block is REPLACED wholesale instead of additively merged, so stale
 *   credentials and endpoints from the old environment (a now-removed legacy
 *   TOKENSCOPE_SESSION_TOKEN, TOKENSCOPE_READ_*, TOKENSCOPE_OAUTH_*, and the old
 *   TOKENSCOPE_BEARER_ENDPOINT / OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) cannot survive
 *   at rest pointing at the wrong deployment. Mirrors tag-repo's replaceEnv pin.
 *
 * Usage (prefer the --handoff-code form — a base64url code can begin with `-`,
 * which a bare positional arg would be mis-parsed as a flag):
 *   node claude-redeem.mjs --handoff-code <code> [--redeem-url <url>] \
 *       [--api-base <base>] [--instance-id <uuid>] [--settings-path <path>]
 *   node claude-redeem.mjs <code>            # positional also accepted
 *
 * The API base defaults to the plugin's baked deployment (api-base.mjs); override
 * with --api-base or TOKENSCOPE_API_BASE for local dev / another instance.
 *
 * Restart `claude` after running — Claude reads its OTel config once at startup.
 */
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveApiBase } from './api-base.mjs'
import { discoverMcpOrigin } from './mcp-origin.mjs'
import { resolveHelperPath, httpsPostJson, stateDir, realHome } from './plugin-runtime.mjs'
import { mergeClaudeSettings, applyOtlpProxyRepoint } from './env-builder.mjs'
import { emitEnvLabel } from './statusline.mjs'
import { assertSafeEndpoint, unsafeEndpointError } from './endpoint-guard.mjs'

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    handoffCode: null,
    redeemUrl: null,
    apiBase: null,
    instanceId: null,
    settingsPath: null,
  }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--handoff-code':
        out.handoffCode = argv[++i]
        break
      case '--redeem-url':
        out.redeemUrl = argv[++i]
        break
      case '--api-base':
        out.apiBase = argv[++i]
        break
      case '--instance-id':
        out.instanceId = argv[++i]
        break
      case '--settings-path':
        out.settingsPath = argv[++i]
        break
      default:
        // Accept a bare positional argument as the handoff code (documented
        // fallback). The canonical invocation uses --handoff-code, which is
        // robust to a base64url code that begins with '-'.
        if (!argv[i].startsWith('--') && !out.handoffCode) out.handoffCode = argv[i]
    }
  }
  return out
}

// ── env-block builder ─────────────────────────────────────────────────────────
// Mirrors the (deleted) env-builder buildDeviceEnvBlock, EMIT-ONLY: the redeem
// leg ships only the device's durable emit credential — the read+tag credential
// came from the SAME OAuth consent that authorised provision_emit (the MCP grant),
// so no TOKENSCOPE_READ_* keys are written here. Prefer the server-sent bundle
// values; fall back to the documented defaults if a field is absent.
// (assertClaudeRedeemResponse guarantees the attribution-critical fields are
// present before this runs on the real path.) Exported for unit testing.

// Retired credential keys a pre-OAuth/legacy enrolment may have left in
// settings.json. The read credential is gone (read rides the MCP-client OAuth
// bearer); TOKENSCOPE_SESSION_TOKEN is the removed pre-OAuth session token.
// Single source of truth: stripped from the new block (buildClaudeDeviceEnv) AND
// from the merged result (writeClaudeSettings) so they never survive a redeem —
// including a SAME-environment additive merge where the old block is kept.
const RETIRED_ENV_KEYS = [
  'TOKENSCOPE_SESSION_TOKEN',
  'TOKENSCOPE_READ_REFRESH_TOKEN',
  'TOKENSCOPE_READ_CLIENT_ID',
]

function buildClaudeDeviceEnv(claude, oauth) {
  if (!claude) return {}
  const env = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: claude.OTEL_LOGS_EXPORTER ?? 'otlp',
    OTEL_METRICS_EXPORTER: claude.OTEL_METRICS_EXPORTER ?? 'none',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: claude.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? '',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: claude.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? 'http/protobuf',
    // Device attrs carry sid + tool only (no project.code_hash — that's per-repo,
    // written by the SessionStart hook into ./.claude/settings.local.json).
    OTEL_RESOURCE_ATTRIBUTES: claude.OTEL_RESOURCE_ATTRIBUTES ?? '',
    // The bearer endpoint the helper presents the OAuth access token to. The
    // claude bundle carries it as otel_headers_helper_url.
    TOKENSCOPE_BEARER_ENDPOINT: claude.otel_headers_helper_url ?? '',
  }
  // The durable OAuth emit credential — only emit these keys when the redeem
  // response carried a COMPLETE block, so a partial/legacy response never writes
  // a half-configured (and thus silently ignored) credential. otel-headers-helper.sh
  // requires all three or it fails loud ("emission auth NOT CONFIGURED").
  if (oauth && oauth.refresh_token && oauth.token_endpoint && oauth.client_id) {
    env.TOKENSCOPE_OAUTH_REFRESH_TOKEN = oauth.refresh_token
    env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT = oauth.token_endpoint
    env.TOKENSCOPE_OAUTH_CLIENT_ID = oauth.client_id
  }
  // Defence-in-depth: the keys are never SET above, but explicitly strip the
  // retired legacy credentials so this block can never carry them — even if a
  // future change or a copied object reintroduces one. Mirrors tag-repo's
  // `delete deviceEnv.TOKENSCOPE_READ_*` (the read credential is gone — read now
  // rides the MCP-client OAuth bearer) plus the pre-OAuth TOKENSCOPE_SESSION_TOKEN.
  // (writeClaudeSettings also strips these from the MERGED result, covering the
  // same-environment additive-merge case where the old block is preserved.)
  for (const k of RETIRED_ENV_KEYS) delete env[k]
  return env
}

// ── redeem-response validation ─────────────────────────────────────────────────
// Throw a clear Error on any response that would enrol the device into a broken
// state, rather than writing it and printing a false success. Returns
// { claude, oauth } on success. Exported for unit testing.
//
// The OTEL_RESOURCE_ATTRIBUTES check is load-bearing for the project's core
// objective: a bundle missing the instance id would enrol "successfully" yet emit
// telemetry that can never be joined to a teammate (silent unattributable spend).
// otel-headers-helper.sh only validates the bearer/OAuth env, so nothing else
// would catch it.
function assertClaudeRedeemResponse(resp) {
  const claude = resp?.telemetry?.claude
  if (resp?.tool === 'copilot-cli' || (!claude && resp?.telemetry?.copilot)) {
    throw new Error(
      'Redeem returned a Copilot bundle — provision_emit was called with tool=copilot-cli. ' +
        'Use copilot-redeem.mjs, or re-run provision_emit with tool=claude-code.',
    )
  }
  if (!claude || !claude.otel_headers_helper_url || !claude.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) {
    throw new Error(
      'Redeem did not return a usable Claude Code bundle (bundle=' +
        !!claude +
        ' bearer_endpoint=' +
        !!claude?.otel_headers_helper_url +
        ' logs_endpoint=' +
        !!claude?.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT +
        ').',
    )
  }
  // S1 fix 3 — validate BEFORE persisting a server-supplied bundle: a
  // compromised/MITM'd redeem response could otherwise plant a plaintext or
  // malformed endpoint into settings.json, and every SUBSEQUENT bearer mint
  // (otel-headers-helper.sh, every ~29 min) would then send the real durable
  // credential wherever that endpoint points. Loopback allowed — a
  // locally-running dev server legitimately returns its own loopback address.
  for (const [label, value] of [
    ['otel_headers_helper_url', claude.otel_headers_helper_url],
    ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', claude.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT],
  ]) {
    try {
      assertSafeEndpoint(value, { allowLoopback: true })
    } catch (err) {
      // REASON ONLY, never the value — this bundle is SERVER-supplied and the
      // caller prints this message. unsafeEndpointError() enforces that
      // structurally, including dropping the value-bearing `cause` that Node
      // would otherwise print. See endpoint-guard.mjs.
      throw unsafeEndpointError(`Redeem bundle's ${label}`, err)
    }
  }
  // Attribution invariant: the device attrs MUST carry a NON-EMPTY instance id, or
  // every emitted record is unjoinable to the teammate. `tokenscope.instance_id=`
  // with an empty value (e.g. `tokenscope.instance_id=,tool=claude-code`) is just
  // as broken as the key being absent, so require at least one non-delimiter char.
  const attrs = claude.OTEL_RESOURCE_ATTRIBUTES
  if (typeof attrs !== 'string' || !/tokenscope\.instance_id=[^,\s]/.test(attrs)) {
    throw new Error(
      'Redeem bundle is missing a non-empty OTEL_RESOURCE_ATTRIBUTES tokenscope.instance_id — ' +
        'refusing to enrol a device that would emit unattributable telemetry.',
    )
  }
  // The durable OAuth credential must be complete — a partial response (schema
  // mismatch / out-of-date server) would write an emit credential that
  // otel-headers-helper.sh silently treats as NOT CONFIGURED.
  for (const field of ['oauth_refresh_token', 'oauth_token_endpoint', 'oauth_client_id']) {
    if (!resp[field] || typeof resp[field] !== 'string') {
      throw new Error(`Redeem response missing ${field} — server may be out of date.`)
    }
  }
  // S1 fix 3 — same "before persisting" rule for the OAuth token endpoint: the
  // helper POSTs the durable refresh token there every ~29 min.
  try {
    assertSafeEndpoint(resp.oauth_token_endpoint, { allowLoopback: true })
  } catch (err) {
    throw unsafeEndpointError("Redeem response's oauth_token_endpoint", err)
  }
  return {
    claude,
    oauth: {
      refresh_token: resp.oauth_refresh_token,
      token_endpoint: resp.oauth_token_endpoint,
      client_id: resp.oauth_client_id,
    },
  }
}

// ── env-change detection ───────────────────────────────────────────────────────
// URL host of a TOKENSCOPE_BEARER_ENDPOINT, lowercased, or '' if absent/unparseable.
// Reuses the host-derivation idea from statusline.emitEnvLabel: the bearer
// endpoint names the deployment origin, so its host is the stable per-deployment key.
function bearerHost(env) {
  try {
    return new URL((env?.TOKENSCOPE_BEARER_ENDPOINT || '').trim()).host.toLowerCase()
  } catch {
    return ''
  }
}

// Detect whether the redeem points at a DIFFERENT deployment than the one already
// configured, by comparing the bearer-endpoint host of the EXISTING env vs the new
// one. Returns { changed, oldLabel, newLabel }. `changed` is false on a fresh
// device (no existing bearer host) and on a same-host re-run; true only when both
// hosts are present AND differ — the cross-environment transition this guards.
function detectEnvChange(existing, newEnvBlock) {
  const oldHost = bearerHost(existing?.env)
  const newHost = bearerHost(newEnvBlock)
  const changed = Boolean(oldHost) && Boolean(newHost) && oldHost !== newHost
  return {
    changed,
    oldLabel: emitEnvLabel(existing?.env) ?? oldHost ?? null,
    newLabel: emitEnvLabel(newEnvBlock) ?? newHost ?? null,
  }
}

/**
 * S1 fix 4 — write the durable OAuth refresh token into the device's OWN
 * shared credential store (`${STATE_DIR}/config.json` → `.oauth_refresh_token`).
 * This is the SAME store copilot-redeem.mjs already writes+reads
 * (`~/.tokenscope/config.json` by default on both lanes — a single physical
 * file when both plugins are installed on one host), keyed by the SAME field
 * name — one shared format, not a second one.
 *
 * WHY: tag-repo.mjs now strips TOKENSCOPE_OAUTH_REFRESH_TOKEN from every
 * repo-local tag it writes (a hostile repo must not be able to exfiltrate the
 * durable credential merely by being cloned). otel-headers-helper.sh falls
 * back to this store when the repo-local env omits the key, so a TAGGED
 * repo's session still finds a refresh token — from the device, never from
 * the repo. Without this writer, removing the key from the repo tag would
 * simply brick emission in every tagged repo.
 *
 * Best-effort: a failure here must NOT fail the whole redeem — the primary
 * credential already landed in `settingsPath` (the untagged/global emit
 * path), and this is a fallback for the tagged-repo case only. Read-merge-
 * write so any other field an operator might have placed in config.json
 * survives; atomic (0600) so a concurrent reader never sees a half-written
 * file.
 */
function writeSharedCredentialStore(oauthRefreshToken, dir) {
  if (!oauthRefreshToken) return
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const configPath = join(dir, 'config.json')
    let existing = {}
    if (existsSync(configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
      } catch {
        existing = {}
      }
    }
    const next = { ...existing, oauth_refresh_token: oauthRefreshToken }
    const tmp = `${configPath}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, configPath)
  } catch {
    /* best-effort — settingsPath already carries the primary credential */
  }
}

// ── ~/.claude/settings.json writer ─────────────────────────────────────────────
// Read-merge-write so a developer's pre-existing top-level settings (permissions,
// statusLine, otelHeadersHelper) survive. Never logs the env block (it carries the
// refresh token). Refuses to proceed if an existing settings.json is present but
// unparseable, rather than clobbering it. Writes atomically (temp + rename, 0600)
// so a concurrent `claude` / SessionStart hook never reads a half-written file.
//
// CROSS-ENVIRONMENT TRANSITION: when the existing config points at a DIFFERENT
// deployment (the bearer-endpoint host changed), the env block is REPLACED
// wholesale (replaceEnv) instead of additively merged — otherwise stale
// credentials/endpoints from the old environment would survive at rest pointing at
// the wrong deployment (mirrors tag-repo's replaceEnv pin). On a same-environment
// re-run or a fresh device the merge stays ADDITIVE, so an unrelated env key a
// developer set by hand is preserved. Returns the env-change descriptor so main()
// can print a one-line note (never a credential).
function writeClaudeSettings(settingsPath, helperPath, envBlock) {
  let existing = null
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf8')
    try {
      existing = JSON.parse(raw)
    } catch {
      throw new Error(
        `Existing ${settingsPath} is not valid JSON — refusing to overwrite. Fix or move it, then re-run.`,
      )
    }
  }
  const envChange = detectEnvChange(existing, envBlock)
  // Replace the env block ONLY on a detected environment change; an additive merge
  // would leave the old deployment's credentials/endpoints at rest. mergeClaudeSettings
  // preserves top-level non-env keys (permissions, statusLine) in both modes.
  const merged = mergeClaudeSettings(existing, helperPath, envBlock, {
    replaceEnv: envChange.changed,
  })
  // Strip retired credentials from the MERGED result, not just the new block: on a
  // same-environment re-provision (replaceEnv=false) the additive merge keeps the
  // old env, so a legacy TOKENSCOPE_SESSION_TOKEN/READ_* would otherwise persist at
  // rest. replaceEnv=true already drops them, so this is the same-env safety net.
  if (merged.env) for (const k of RETIRED_ENV_KEYS) delete merged.env[k]
  mkdirSync(dirname(settingsPath), { recursive: true })
  const tmp = `${settingsPath}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    chmodSync(tmp, 0o600) // defeat umask so the file is 0600 even if writeFileSync's mode was masked
    renameSync(tmp, settingsPath) // atomic on the same filesystem
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* best-effort cleanup */
    }
    throw err
  }
  // Mirror the fresh refresh token into the shared device credential store —
  // BOTH lanes (this redeem's own env AND any tagged repo relying on the
  // state-dir fallback) must agree on the same value. Uses envBlock (the
  // value THIS redeem just minted), not merged.env, though they agree.
  writeSharedCredentialStore(envBlock.TOKENSCOPE_OAUTH_REFRESH_TOKEN, stateDir())
  return envChange
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.handoffCode) {
    console.error(
      '[tokenscope] handoff code is required (pass it as the first argument or via --handoff-code)',
    )
    process.exit(1)
  }

  // Resolve the full redeem URL. A handoff can ONLY be redeemed at the server
  // that minted it, so the base must track wherever the MCP server is actually
  // registered — not the baked default. `setup.md` forbids passing --api-base
  // (the allowed-tools grant is one fixed command, so a prompt-injected model
  // cannot nominate the host a live single-use secret is posted to), which
  // means the origin has to be discovered from local configuration rather than
  // relayed through the conversation. discoverMcpOrigin reads only files a
  // human wrote at registration time; it returns null on a stock install, where
  // the baked default is right by construction.
  //
  // Nothing is passed to keep the environment out of this any more. setup.md
  // forbids --api-base so the CONVERSATION cannot nominate the host, but the
  // resolver used to rank TOKENSCOPE_API_BASE above discovery, and Claude Code
  // merges a repository's .claude/settings.local.json env over the global one:
  // a cloned repo could nominate the host the live handoff is posted to, which
  // is the exact outcome the --api-base ban exists to prevent, reached through
  // a different door. That was first patched here with `trustEnv: false`, and
  // the flag is now gone — resolveApiBase only honours an OFF-BOX env value if
  // there is no such thing, because it accepts the variable solely when it
  // names loopback. A caller can no longer opt back into the hole, or forget to
  // opt out of it.
  const apiBase = resolveApiBase(args.apiBase, {
    discovered: discoverMcpOrigin(fileURLToPath(new URL('.', import.meta.url)), {
      client: 'claude',
    }),
  })
  const redeemPath = args.redeemUrl ?? '/api/v1/setup/redeem'
  const redeemUrl = redeemPath.startsWith('http') ? redeemPath : `${apiBase}${redeemPath}`
  if (!redeemUrl.startsWith('http')) {
    console.error(
      '[tokenscope] Cannot resolve redeem URL — the API base needs an http(s):// scheme (set --api-base or TOKENSCOPE_API_BASE).',
    )
    process.exit(1)
  }

  console.log('[tokenscope] Redeeming handoff...')
  const reqBody = { handoff_code: args.handoffCode }
  // Defence-in-depth: bind the redeem to the instance provision_emit returned, so
  // a code can't be redirected onto another device (the server 401s a mismatch).
  if (args.instanceId) reqBody.instance_id = args.instanceId

  let resp
  try {
    resp = await httpsPostJson(redeemUrl, reqBody)
  } catch (err) {
    console.error(`[tokenscope] Redeem failed: ${err.message}`)
    process.exit(1)
  }

  // Validate the response before writing — do NOT log the raw response (it carries
  // the durable oauth_refresh_token).
  let claude, oauth
  try {
    ;({ claude, oauth } = assertClaudeRedeemResponse(resp))
  } catch (err) {
    console.error(`[tokenscope] ${err.message}`)
    process.exit(1)
  }

  const envBlock = buildClaudeDeviceEnv(claude, oauth)
  // Re-point the logs endpoint at the local Content-Length forwarder (CC #72671)
  // and stash the real DCE URL for it. Kill-switch: TOKENSCOPE_OTLP_PROXY=0.
  applyOtlpProxyRepoint(envBlock)
  const helperPath = resolveHelperPath()
  // The durable emit credential lands in this file, which makes the path a
  // trust sink and not merely a location. os.homedir() trusts $HOME, so a
  // leaked or planted HOME writes a live refresh token into a directory
  // somebody else chose. Anchor it on the passwd entry, which an env var
  // cannot move.
  //
  // This does mean that under a moved HOME we write somewhere Claude Code --
  // which resolves its own settings through HOME -- will not read, so setup
  // succeeds and emission never starts. That is the right way round: the
  // alternative hands the credential to whoever moved HOME. Say so loudly,
  // because the failure is otherwise invisible, and name both paths so it is
  // fixable rather than merely reported.
  const trustedHome = realHome()
  if (!args.settingsPath && trustedHome !== homedir()) {
    console.error(
      `[tokenscope] WARN: $HOME (${homedir()}) differs from your account's real home (${trustedHome}). ` +
        'Writing the credential to the real home; Claude Code reads $HOME, so emission may not start ' +
        'until HOME is corrected.',
    )
  }
  const settingsPath = args.settingsPath ?? join(trustedHome, '.claude', 'settings.json')
  let envChange
  try {
    envChange = writeClaudeSettings(settingsPath, helperPath, envBlock)
  } catch (err) {
    console.error(`[tokenscope] ${err.message}`)
    process.exit(1)
  }

  console.log('')
  // Cross-environment transition note (never prints a credential — only env labels).
  // The bearer-endpoint host changed, so the device just moved deployments and the
  // env block was REPLACED with a fresh config (stale old-env creds/endpoints dropped).
  if (envChange?.changed) {
    const from = envChange.oldLabel ?? 'previous'
    const to = envChange.newLabel ?? 'new'
    console.log(
      `[tokenscope] Environment changed: ${from} → ${to} — minting/writing fresh config for the new environment (old credentials and endpoints dropped).`,
    )
  }
  console.log('[tokenscope] ✓ Claude Code device enrolled — emitting provisioned.')
  console.log(`[tokenscope]   Instance ID: ${resp.instance_id}`)
  console.log(`[tokenscope]   Wrote OTel plumbing to ${settingsPath} (mode 0600).`)
  console.log('[tokenscope]   Restart `claude` — the OTel config is read once at startup.')
  console.log(
    '[tokenscope]   Then tag this repo with the `project` prompt so its sessions attribute to a budget.',
  )
}

// Only run main() when executed directly (not when imported as a module for testing).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[tokenscope] Fatal:', err.message)
    process.exit(1)
  })
}

// Named exports for unit testing only — not part of the public API.
export {
  buildClaudeDeviceEnv,
  assertClaudeRedeemResponse,
  writeClaudeSettings,
  writeSharedCredentialStore,
  parseArgs,
}
