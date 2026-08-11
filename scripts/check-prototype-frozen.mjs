/*
 * check-prototype-frozen — the approved artefact may not be rewritten by the
 * work that implements it.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * `1ac6a8fd` (PR #238) edited `prototype.html` (+306 lines) AND
 * `CcDrill.vue` (+253) in one commit, removed a rendered card from the build,
 * left it in the prototype, and never mentioned the removal in its message. The
 * owner went on believing the artefact they approved described the product.
 *
 * If the design an implementation is measured against can be edited by that
 * implementation, approval means nothing — there is no fixed point. So the two
 * move in separate changes: a prototype edit is a DESIGN change that gets
 * approved on its own, and the build change that follows is measured against
 * the approved result.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────
 * It does not stop the prototype changing, and it is not a substitute for the
 * parity gate. A prototype edit that ADDS a surface is caught here (wrong PR)
 * and then by `prototype-parity.test.ts` (unanswered surface). A build change
 * that DROPS a surface is caught by the parity gate alone — the map entry has
 * to become `missing` (fails) or `waived` (needs a reason and a decision), so a
 * silent removal is not expressible.
 *
 * Set ALLOW_PROTOTYPE_WITH_CODE=1 to override for a deliberate, reviewed
 * combined change (a rename sweep, say). The override is visible in the diff.
 */
import { execSync } from 'node:child_process'

const DESIGN_GLOBS = [/^docs\/design\/reporting-consolidation\/prototype\.html$/]
/** Implementation surface: if either side changes with the artefact, fail. */
const CODE_GLOBS = [/^app\//, /^server\//, /^shared\//, /^drizzle\//]

const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main'

let changed = []
try {
  const mergeBase = execSync(`git merge-base ${base} HEAD`, { encoding: 'utf8' }).trim()
  /*
   * Compare the merge base against the WORKING TREE, not against HEAD. Omitting
   * HEAD folds in staged and unstaged edits, so the guard answers the same way
   * before a commit as CI will answer after one. The HEAD-only form passed
   * cleanly on an uncommitted artefact edit sitting right beside app changes —
   * a guard that only fires once the mistake is committed is one round too late.
   */
  changed = execSync(`git diff --name-only ${mergeBase}`, { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
} catch {
  // No base to compare against (a shallow clone, a fresh repo) — do not invent a
  // verdict. A guard that fails open is honest; one that guesses is not.
  console.log(`check-prototype-frozen: no comparable base (${base}) — skipped.`)
  process.exit(0)
}

const artefact = changed.filter((f) => DESIGN_GLOBS.some((re) => re.test(f)))
const code = changed.filter((f) => CODE_GLOBS.some((re) => re.test(f)))

if (artefact.length && code.length) {
  if (process.env.ALLOW_PROTOTYPE_WITH_CODE === '1') {
    console.log('check-prototype-frozen: OVERRIDDEN by ALLOW_PROTOTYPE_WITH_CODE=1.')
    process.exit(0)
  }
  const more = code.length > 6 ? ` (+${code.length - 6} more)` : ''
  console.error(
    [
      'The approved prototype changed in the same PR as implementation code.',
      '',
      `  artefact: ${artefact.join(', ')}`,
      `  code:     ${code.slice(0, 6).join(', ')}${more}`,
      '',
      'Split them. A design change is approved on its own; the build that follows is',
      'measured against the approved result. PR #238 did both at once, dropped a card',
      'from the build, left it in the prototype, and nobody could see the difference.',
      '',
      'Deliberate combined change? Set ALLOW_PROTOTYPE_WITH_CODE=1 and say why in the PR.',
    ].join('\n'),
  )
  process.exit(1)
}

console.log('check-prototype-frozen: ok.')
