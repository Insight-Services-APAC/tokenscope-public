#!/usr/bin/env node
 
/**
 * check-skill-prompts-sync.mjs — CI gate.
 *
 * server/utils/skill-prompts.gen.ts must equal what sync-skill-prompts.mjs would
 * generate from docs/skills/tokenscope/*.md. Fails if a prompt .md was edited
 * without re-running `npm run sync:skill-prompts` (the drift the generator exists
 * to prevent).
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate } from './sync-skill-prompts.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = resolve(root, 'server/utils/skill-prompts.gen.ts')
const SOURCE_DIR = resolve(root, 'docs/skills/tokenscope')

/*
 * A TREE WITHOUT THE SOURCE CANNOT BE OUT OF SYNC WITH IT.
 *
 * `docs/skills/` is internal-only (tools/publish/internal-only-paths.txt) while
 * the GENERATED `skill-prompts.gen.ts` ships — it is what the MCP server serves.
 * So in the public mirror `generate()` threw ENOENT and took the whole Static
 * job down. Same publish defect as the prototype gates: published code reading a
 * deliberately-dropped directory.
 *
 * The condition is the SOURCE DIRECTORY being absent, not any individual file
 * being missing — a tree that has the directory but is missing one prompt is a
 * real inconsistency and still fails inside generate(). Internally the directory
 * is tracked, so the gate is untouched where it means anything.
 */
if (!existsSync(SOURCE_DIR)) {
  console.log(
    '✓  skill-prompts: docs/skills/tokenscope is absent — this tree does not carry the prompt sources (the public mirror drops them); the generated file is authoritative here. Nothing to check.',
  )
  process.exit(0)
}

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
