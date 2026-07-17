#!/usr/bin/env node
 
/**
 * check-copilot-plugin-sync.mjs
 *
 * CI parity gate: diffs plugin/scripts/* against copilot-plugin/scripts/*,
 * ignoring the SYNC NOTE header line added by sync-copilot-plugin.mjs.
 *
 * Also verifies (PLG-9) that the baked TokenScope API host is CONSISTENT across
 * the three uncoordinated places it lives: plugin/scripts/api-base.mjs
 * (DEFAULT_API_BASE), plugin/.mcp.json (the ${TOKENSCOPE_API_BASE:-…} default),
 * and copilot-plugin/.mcp.json (a literal URL — Copilot CLI does not expand
 * ${VAR}). A partial host update silently splits the plugin: MCP talks to one
 * server while redeem/emit talk to another.
 *
 * Exits 1 if any file pair differs (drift detected) or the API hosts diverge.
 * Run: npm run check:copilot-plugin-sync
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dir, '..')

const FILES = [
  'copilot-forwarder.mjs',
  'otlp-logs.mjs',
  'copilot-redeem.mjs',
  // tokenscope-project.mjs — extracted client-neutral resolver/hasher (P0-2).
  // Gated here so the vendored copilot copy can never drift from the canonical
  // plugin/scripts/ source (drift = Copilot + Claude hash the same .tokenscope
  // differently = split attribution).
  'tokenscope-project.mjs',
  'otel-headers-helper.sh',
]

// Match the FULL auto-generated signature (not a bare `// SYNC NOTE:` prefix), so a
// legitimate body comment that happens to start with the prefix can't mask real drift
// by being stripped from both sides. Keep in sync with sync-copilot-plugin.mjs.
const SYNC_NOTE_SIGNATURE = 'SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution.'

/** Strip the single auto-generated SYNC NOTE line (matched by its full signature). */
function stripSyncNote(content) {
  return content
    .split('\n')
    .filter((line) => !line.includes(SYNC_NOTE_SIGNATURE))
    .join('\n')
}

let failed = false

for (const name of FILES) {
  const canonical = resolve(root, 'plugin/scripts', name)
  const vendored  = resolve(root, 'copilot-plugin/scripts', name)

  if (!existsSync(canonical)) {
    console.error(`ERROR: canonical source missing: plugin/scripts/${name}`)
    failed = true
    continue
  }
  if (!existsSync(vendored)) {
    console.error(`ERROR: vendored copy missing: copilot-plugin/scripts/${name}`)
    console.error(`  Run: npm run sync:copilot-plugin`)
    failed = true
    continue
  }

  const canonicalNorm = stripSyncNote(readFileSync(canonical, 'utf8'))
  const vendoredNorm  = stripSyncNote(readFileSync(vendored,  'utf8'))

  if (canonicalNorm !== vendoredNorm) {
    console.error(`DRIFT: copilot-plugin/scripts/${name} is out of sync with plugin/scripts/${name}`)
    console.error(`  Run: npm run sync:copilot-plugin`)
    failed = true
  }
}

if (!failed) {
  console.log('✓  copilot-plugin/scripts/ is in sync with plugin/scripts/')
}

// ── API-host consistency (PLG-9) ─────────────────────────────────────────────

/** Extract the origin (scheme://host[:port]) of a URL string, or null. */
function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** plugin/scripts/api-base.mjs — the exported DEFAULT_API_BASE literal. */
function apiBaseHost() {
  const src = readFileSync(resolve(root, 'plugin/scripts/api-base.mjs'), 'utf8')
  const m = src.match(/DEFAULT_API_BASE\s*=\s*'([^']+)'/)
  return m ? originOf(m[1]) : null
}

/** plugin/.mcp.json — the ${TOKENSCOPE_API_BASE:-<default>} fallback in the url. */
function claudeMcpHost() {
  const cfg = JSON.parse(readFileSync(resolve(root, 'plugin/.mcp.json'), 'utf8'))
  const url = cfg?.mcpServers?.tokenscope?.url ?? ''
  const m = url.match(/\$\{TOKENSCOPE_API_BASE:-([^}]+)\}/)
  return originOf(m ? m[1] : url)
}

/** copilot-plugin/.mcp.json — a literal URL (Copilot CLI does not expand ${VAR}). */
function copilotMcpHost() {
  const cfg = JSON.parse(readFileSync(resolve(root, 'copilot-plugin/.mcp.json'), 'utf8'))
  return originOf(cfg?.mcpServers?.tokenscope?.url ?? '')
}

const hosts = [
  { where: 'plugin/scripts/api-base.mjs (DEFAULT_API_BASE)', host: apiBaseHost() },
  { where: 'plugin/.mcp.json (mcpServers.tokenscope.url default)', host: claudeMcpHost() },
  { where: 'copilot-plugin/.mcp.json (mcpServers.tokenscope.url)', host: copilotMcpHost() },
]

let hostFailed = false
for (const { where, host } of hosts) {
  if (!host) {
    console.error(`ERROR: could not extract an API host from ${where}`)
    hostFailed = true
  }
}
if (!hostFailed && new Set(hosts.map((h) => h.host)).size !== 1) {
  console.error('DRIFT: the baked TokenScope API host differs between:')
  for (const { where, host } of hosts) console.error(`  ${host}  ←  ${where}`)
  console.error('  A partial update silently splits the plugin (MCP at one server, redeem at another). Update all three together.')
  hostFailed = true
}
if (hostFailed) {
  failed = true
} else {
  console.log(`✓  API host consistent across api-base.mjs + both .mcp.json (${hosts[0].host})`)
}

process.exit(failed ? 1 : 0)
