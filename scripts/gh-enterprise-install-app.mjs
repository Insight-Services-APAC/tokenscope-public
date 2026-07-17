#!/usr/bin/env node
/*
 * gh-enterprise-install-app.mjs — bulk-install an enterprise-owned GitHub App across the
 * organizations of a GitHub Enterprise, WITHOUT per-org ownership or the SAML re-auth wall.
 *
 * WHY: the normal app-install page is gated on being an OWNER of each target org, and a
 * SAML-ENFORCED org blocks "join as owner" until you've joined as a SAML-authenticated member
 * (GitHub docs: an enterprise owner "cannot use the enterprise settings to join the
 * organization" when SAML is enforced). The ONLY documented way around this at scale is the
 * enterprise-level installation-automation API (GHEC, GA 2025-07-01):
 *
 *   POST /enterprises/{enterprise}/apps/organizations/{org}/installations   { client_id, repository_selection }
 *   GET  /enterprises/{enterprise}/apps/installable_organizations
 *   GET  /enterprises/{enterprise}/apps/organizations/{org}/installations
 *
 * These are authenticated as a GitHub App — no human browser session — so there is no
 * org-ownership check and no SAML re-auth. See docs/build/copilot-enterprise-app-install.md.
 *
 * TWO apps are involved (do not conflate):
 *   - the INSTALLER app: a small enterprise-owned App holding "Enterprise organization
 *     installations: write", installed ON THE ENTERPRISE. This script authenticates as it.
 *   - the TARGET app: the app you actually want on every org (the reconciliation app,
 *     client_id Iv23lierxwQlXzgBy2dz by default). It needs no repo access.
 *
 * SECURITY: never prints the PEM, the App JWT, or any installation token. Reads the PEM by
 * path only. Installs the TARGET with repository_selection='none' (no repo access requested).
 *
 * Usage:
 *   INSTALLER_APP_ID=<id> INSTALLER_PEM=<path> \
 *     node scripts/gh-enterprise-install-app.mjs <command> [orgs...] [--options]
 *
 * Commands:
 *   list-orgs                 List the enterprise's installable organizations.
 *   check                     Show whether the TARGET app is installed per org.
 *   install <org> [org...]    Install the TARGET on the named org(s) (pilot — do the SAML-enforced one first).
 *   install-all               Install the TARGET on ALL installable orgs.
 *
 * Options (or env):
 *   --enterprise <slug>       ENTERPRISE           (required; e.g. acme-partner-demo)
 *   --installer-app-id <id>   INSTALLER_APP_ID     (required)
 *   --installer-pem <path>    INSTALLER_PEM        (required)
 *   --target-client-id <id>   TARGET_CLIENT_ID     (default: the reconciliation app)
 *   --dry-run                 Print intended installs, change nothing.
 */
 
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const API = 'https://api.github.com'
const API_VERSION = '2026-03-10' // enterprise org-installation endpoints (verified against the docs)
const DEFAULT_TARGET_CLIENT_ID = 'Iv23lierxwQlXzgBy2dz' // TokenScope Copilot Reconciliation (app id 4178824)

// ── tiny arg parser ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const command = argv[0]
const positionals = []
const flags = {}
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    if (key === 'dry-run') flags['dry-run'] = true
    else flags[key] = argv[++i]
  } else positionals.push(a)
}

const enterprise = flags.enterprise ?? process.env.ENTERPRISE
const installerAppId = flags['installer-app-id'] ?? process.env.INSTALLER_APP_ID
const installerPem = flags['installer-pem'] ?? process.env.INSTALLER_PEM
const targetClientId = flags['target-client-id'] ?? process.env.TARGET_CLIENT_ID ?? DEFAULT_TARGET_CLIENT_ID
const dryRun = !!flags['dry-run']

function die(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}
if (!command || !['list-orgs', 'check', 'install', 'install-all'].includes(command)) {
  die('first arg must be one of: list-orgs | check | install <org...> | install-all')
}
if (!enterprise) die('--enterprise (or ENTERPRISE) is required')
if (!installerAppId || !/^\d+$/.test(installerAppId)) die('--installer-app-id (or INSTALLER_APP_ID) must be the numeric installer App id')
if (!installerPem) die('--installer-pem (or INSTALLER_PEM) path is required')

// ── App JWT (RS256, iss=installer app id) — mirrors server/reconciliation/adapters/github-app-auth.ts ──
const PRIVATE_KEY = readFileSync(installerPem, 'utf8') // never logged
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function appJwt() {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: installerAppId }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  signer.end()
  return `${header}.${payload}.${b64url(signer.sign(PRIVATE_KEY))}`
}

async function gh(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'tokenscope-enterprise-installer',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* 204 / empty */
  }
  return { status: res.status, ok: res.ok, json }
}

// ── installer app → ENTERPRISE installation token (the installer app is installed on the enterprise) ──
async function enterpriseInstallToken() {
  const jwt = appJwt()
  const inst = await gh('GET', `/enterprises/${encodeURIComponent(enterprise)}/installation`, jwt)
  if (inst.status === 404) die(`the installer app is not installed on enterprise '${enterprise}' — install it on the enterprise first`)
  if (!inst.ok) die(`GET /enterprises/${enterprise}/installation → ${inst.status} ${JSON.stringify(inst.json)?.slice(0, 200)}`)
  const tok = await gh('POST', `/app/installations/${inst.json.id}/access_tokens`, jwt)
  if (!tok.ok) die(`token exchange → ${tok.status} ${JSON.stringify(tok.json)?.slice(0, 200)}`)
  return tok.json.token // never logged
}

async function listInstallableOrgs(token) {
  const out = []
  for (let page = 1; page <= 100; page++) {
    const r = await gh('GET', `/enterprises/${encodeURIComponent(enterprise)}/apps/installable_organizations?per_page=100&page=${page}`, token)
    if (!r.ok) die(`installable_organizations → ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`)
    const rows = Array.isArray(r.json) ? r.json : []
    out.push(...rows.map((o) => o.login))
    if (rows.length < 100) break
  }
  return out
}

async function targetInstalledOn(org, token) {
  const r = await gh('GET', `/enterprises/${encodeURIComponent(enterprise)}/apps/organizations/${encodeURIComponent(org)}/installations`, token)
  if (!r.ok) return { known: false, detail: `${r.status}` }
  const hit = (Array.isArray(r.json) ? r.json : []).find((i) => i.client_id === targetClientId)
  return { known: true, installed: !!hit, installationId: hit?.id ?? null }
}

async function installTargetOn(org, token) {
  if (dryRun) return { status: 'dry-run', detail: `would POST client_id=${targetClientId} repository_selection=none` }
  const r = await gh('POST', `/enterprises/${encodeURIComponent(enterprise)}/apps/organizations/${encodeURIComponent(org)}/installations`, token, {
    client_id: targetClientId,
    repository_selection: 'none',
  })
  if (r.status === 201) return { status: 'installed', detail: `installation id ${r.json?.id}` }
  if (r.status === 200) return { status: 'already/updated', detail: `installation id ${r.json?.id}` }
  return { status: 'FAILED', detail: `HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}` }
}

// ── main ──────────────────────────────────────────────────────────────────────
const token = await enterpriseInstallToken()
console.log(`enterprise: ${enterprise} · target client_id: ${targetClientId}${dryRun ? ' · DRY-RUN' : ''}`)

if (command === 'list-orgs') {
  const orgs = await listInstallableOrgs(token)
  console.log(`${orgs.length} installable organization(s):`)
  for (const o of orgs) console.log(`  ${o}`)
} else if (command === 'check') {
  const orgs = await listInstallableOrgs(token)
  for (const o of orgs) {
    const s = await targetInstalledOn(o, token)
    console.log(`  ${o.padEnd(28)} ${s.known ? (s.installed ? `INSTALLED (id ${s.installationId})` : 'not installed') : `unknown (${s.detail})`}`)
  }
} else if (command === 'install' || command === 'install-all') {
  const orgs = command === 'install-all' ? await listInstallableOrgs(token) : positionals
  if (orgs.length === 0) die(command === 'install' ? 'name at least one org: install <org> [org...]' : 'no installable organizations returned')
  console.log(`${dryRun ? 'DRY-RUN — would install' : 'installing'} the target on ${orgs.length} org(s):`)
  let ok = 0
  for (const o of orgs) {
    const r = await installTargetOn(o, token)
    if (['installed', 'already/updated', 'dry-run'].includes(r.status)) ok++
    console.log(`  ${o.padEnd(28)} ${r.status.padEnd(16)} ${r.detail}`)
  }
  console.log(`done: ${ok}/${orgs.length} ${dryRun ? 'would-succeed' : 'succeeded'}`)
}
