#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * check-skill-prompts-sync.mjs — CI gate.
 *
 * server/utils/skill-prompts.gen.ts must equal what sync-skill-prompts.mjs would
 * generate from docs/skills/tokenscope/*.md. Fails if a prompt .md was edited
 * without re-running `npm run sync:skill-prompts` (the drift the generator exists
 * to prevent).
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate } from './sync-skill-prompts.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = resolve(root, 'server/utils/skill-prompts.gen.ts')

const expected = generate()
let actual = ''
try {
  actual = readFileSync(TARGET, 'utf8')
} catch {
  /* missing → treated as stale below */
}

if (expected !== actual) {
  console.error('✗  server/utils/skill-prompts.gen.ts is STALE vs docs/skills/tokenscope/*.md')
  console.error('   Run:  npm run sync:skill-prompts   (then commit the regenerated file)')
  process.exit(1)
}
console.log('✓  skill-prompts.gen.ts is in sync with docs/skills/tokenscope/*.md')
