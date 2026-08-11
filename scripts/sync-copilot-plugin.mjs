#!/usr/bin/env node

/**
 * sync-copilot-plugin.mjs
 *
 * Copies the shared scripts from plugin/scripts/ into copilot-plugin/scripts/,
 * prepending a one-line SYNC NOTE so maintainers know the file is auto-generated.
 *
 * This script IS the source-of-truth mechanism for the vendored copies —
 * run it before any commit that touches plugin/scripts/.
 *
 * Usage:
 *   npm run sync:copilot-plugin
 *
 * The copies are checked for drift in CI via:
 *   npm run check:copilot-plugin-sync
 */
import { readFileSync, writeFileSync, statSync, chmodSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dir, '..')

const FILES = [
  { name: 'copilot-forwarder.mjs', type: 'js' },
  { name: 'otlp-logs.mjs', type: 'js' },
  { name: 'copilot-redeem.mjs', type: 'js' },
  // tokenscope-project.mjs — the client-neutral resolver/hasher the forwarder
  // reuses so Copilot + Claude hash an identical `.tokenscope` to the same
  // project.code_hash. MUST stay gated by check-copilot-plugin-sync.mjs: an
  // un-gated extracted module drifts silently → split attribution (P0-2).
  { name: 'tokenscope-project.mjs', type: 'js' },
  { name: 'otel-headers-helper.sh', type: 'sh' },
  // endpoint-guard.mjs (S1) — the ONE endpoint validator (assertSafeEndpoint /
  // isUsableDce). Dependency-free by design so it vendors verbatim; MUST stay
  // gated the same way tokenscope-project.mjs is — a second, un-gated guard
  // is exactly what this epic's opening principle forbids.
  { name: 'endpoint-guard.mjs', type: 'js' },
  // mcp-origin.mjs — the ONE resolver for "where is the MCP server actually
  // registered", used by BOTH redeem helpers so a handoff is always redeemed at
  // the server that minted it. Gated for the same reason endpoint-guard.mjs is:
  // a drifted second copy would send one client's single-use credential to a
  // host the other client never talked to.
  { name: 'mcp-origin.mjs', type: 'js' },
  // real-home.mjs — the ONE answer to "where is the account's home", used by
  // mcp-origin.mjs to decide which config names the redeem host and by
  // claude-redeem.mjs to decide where the durable credential is written. Gated
  // for the same reason endpoint-guard.mjs is, and more sharply: a drifted copy
  // that fell back to os.homedir() would silently restore the $HOME trust
  // boundary this module exists to remove, on one client only.
  { name: 'real-home.mjs', type: 'js' },
  // managed-telemetry.mjs (Workstream D §10.1) — the ONE detector for GitHub
  // Copilot CLI's enterprise-managed `telemetry` block (hostile/benign/none/
  // unknown). Copilot's own status/setup/enroll are the primary consumers;
  // gated the same way as the others — a drifted second copy on the Copilot
  // side is exactly the failure class this whole vendoring mechanism exists to
  // prevent, and here it would mean the two clients disagree about whether a
  // credential-valid probe is actually emission-healthy.
  { name: 'managed-telemetry.mjs', type: 'js' },
]

// Single-line SYNC NOTE markers — the parity check strips lines starting with these.
const JS_NOTE = (name) =>
  `// SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/${name}. Re-generate with: npm run sync:copilot-plugin`
const SH_NOTE = (name) =>
  `# SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/${name}. Re-generate with: npm run sync:copilot-plugin`

for (const { name, type } of FILES) {
  const src = resolve(root, 'plugin/scripts', name)
  const dst = resolve(root, 'copilot-plugin/scripts', name)

  const content = readFileSync(src, 'utf8')
  const note = type === 'sh' ? SH_NOTE(name) : JS_NOTE(name)

  // Insert the note AFTER a shebang if the file has one (a line before `#!` would
  // break it); otherwise prepend at the very top. otlp-logs.mjs has no shebang (it
  // opens with a block comment), so its note goes on line 1 rather than inside `/* */`.
  const lines = content.split('\n')
  const output = lines[0].startsWith('#!')
    ? [lines[0], note, ...lines.slice(1)].join('\n')
    : [note, ...lines].join('\n')

  writeFileSync(dst, output, { encoding: 'utf8' })

  // Preserve executable permission from source (important for .sh files).
  const srcMode = statSync(src).mode
  if (srcMode & 0o111) chmodSync(dst, srcMode)

  console.log(`  ✓  ${name}`)
}

console.log('\nDone. Run npm run check:copilot-plugin-sync to verify parity.')
