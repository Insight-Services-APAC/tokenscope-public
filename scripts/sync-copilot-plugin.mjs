#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * sync-copilot-plugin.mjs
 *
 * Copies the four shared scripts from plugin/scripts/ into copilot-plugin/scripts/,
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
  { name: 'otlp-logs.mjs',         type: 'js' },
  { name: 'copilot-redeem.mjs',    type: 'js' },
  // tokenscope-project.mjs — the client-neutral resolver/hasher the forwarder
  // reuses so Copilot + Claude hash an identical `.tokenscope` to the same
  // project.code_hash. MUST stay gated by check-copilot-plugin-sync.mjs: an
  // un-gated extracted module drifts silently → split attribution (P0-2).
  { name: 'tokenscope-project.mjs', type: 'js' },
  { name: 'otel-headers-helper.sh', type: 'sh' },
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
