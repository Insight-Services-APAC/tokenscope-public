#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * sync-skill-prompts.mjs — generate server/utils/skill-prompts.gen.ts from the
 * SINGLE source of truth: docs/skills/tokenscope/*.md.
 *
 * The MCP prompt text loads into Claude's context, so it must ship inside the
 * server bundle. Previously the text was hand-copied into mcp.ts and kept in sync
 * by a comment — and it DRIFTED. This makes the .md files authoritative and the
 * TS a generated, CI-verified artifact (mirrors the copilot-plugin vendoring).
 *
 * Run after editing any docs/skills/tokenscope/*.md:  npm run sync:skill-prompts
 * Verified in CI:                                      npm run check:skill-prompts-sync
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// const name → source .md (the prompt body, verbatim). Order is stable.
const PROMPTS = [
  { konst: 'SKILL_SETUP', file: 'tokenscope-setup.md' },
  { konst: 'SKILL_TAG', file: 'tag.md' },
  { konst: 'SKILL_PROJECT', file: 'project.md' },
  { konst: 'SKILL_USAGE', file: 'usage.md' },
]

/** Build the full generated-module text (pure — the check script reuses it). */
export function generate() {
  let out =
    '/* eslint-disable */\n' +
    '// AUTO-GENERATED — DO NOT EDIT BY HAND.\n' +
    '// Source of truth: docs/skills/tokenscope/*.md\n' +
    '// Regenerate: npm run sync:skill-prompts   ·   Verified in CI: npm run check:skill-prompts-sync\n\n'
  for (const { konst, file } of PROMPTS) {
    // Normalise trailing whitespace to exactly one newline so the generated
    // string is stable regardless of editor trailing-newline behaviour.
    const content = readFileSync(resolve(root, 'docs/skills/tokenscope', file), 'utf8').replace(/\s*$/, '\n')
    out += `export const ${konst} = ${JSON.stringify(content)}\n`
  }
  return out
}

const TARGET = resolve(root, 'server/utils/skill-prompts.gen.ts')

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(TARGET, generate(), 'utf8')
  console.log('  ✓  server/utils/skill-prompts.gen.ts')
  console.log('\nDone. Verify with: npm run check:skill-prompts-sync')
}
