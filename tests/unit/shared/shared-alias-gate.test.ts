/*
 * The `#shared` alias gate.
 *
 * WHY THIS EXISTS. An `app/` -> `shared/` import written as a relative path
 * resolves correctly in dev, in vitest, and under `vue-tsc`. It fails only in
 * the production nitro build, as `RollupError: UNRESOLVED_IMPORT`. CI does not
 * run `npm run build`, so nothing between a developer's keyboard and a deploy
 * says a word about it.
 *
 * On 2026-08-05 this cost three build cycles on the fix sprint: F1 added
 * `shared/reports/clock.ts` and `shared/reports/day-axis.ts`, and
 * `app/pages/projects/index.vue` imported both relatively. The full suite was
 * green — 6453 tests — typecheck was clean, lint was clean, and the prod build
 * failed on the first one. Fixing it revealed the second, one build later.
 * Discovering this class one build at a time is the failure mode; a gate that
 * names all of them at once is the fix.
 *
 * TYPE-ONLY IMPORTS ARE ERASED and cannot break the build, so they are not the
 * hazard. They are still caught here on purpose: the day someone adds a value
 * to an existing `import type { … }` line, a harmless import silently becomes a
 * deploy-breaking one, and no diff review reliably notices that. One rule with
 * no exceptions is cheaper to hold than a rule with a carve-out.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

// `__dirname`, matching `clock-static-gate.test.ts`. `import.meta.url` is not a
// file: URL under this vitest config and throws at collection time.
const ROOT = resolve(__dirname, '../../..')
const APP = resolve(ROOT, 'app')

/** `from '../shared/…'` / `'../../shared/…'` at any depth, import or re-export. */
const RELATIVE_SHARED = /from\s+'(?:\.\.\/)+shared\//g

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|vue)$/.test(entry)) out.push(full)
  }
  return out
}

describe('app -> shared imports use the #shared alias', () => {
  it('no file under app/ imports shared/ by relative path', () => {
    const offenders = sourceFiles(APP)
      .map((file) => ({ file, hits: readFileSync(file, 'utf8').match(RELATIVE_SHARED) }))
      .filter((r) => r.hits !== null)
      .map((r) => `${r.file.slice(ROOT.length + 1)} (${r.hits!.length})`)

    // Named, not counted: the assertion prints every offending path, because the
    // cost of this defect is finding them one prod build at a time.
    expect(offenders).toEqual([])
  })

  it('the pattern it guards actually matches a relative shared import', () => {
    // Guard the guard: a regex that matched nothing would make this test a
    // permanent, silent pass.
    expect("import { x } from '../../shared/reports/clock'".match(RELATIVE_SHARED)).toHaveLength(1)
    expect("import type { X } from '../../../shared/schemas/usage'".match(RELATIVE_SHARED)).toHaveLength(1)
    expect("import { x } from '#shared/reports/clock'".match(RELATIVE_SHARED)).toBeNull()
    // A shared/ -> shared/ relative import is legal and must not be flagged.
    expect("import { x } from './day-axis'".match(RELATIVE_SHARED)).toBeNull()
  })
})
