#!/usr/bin/env node
/*
 * check-workflow-pins.mjs — CI guard.
 *
 * Every third-party `uses:` in .github/workflows/*.yml must be pinned to a
 * 40-hex commit SHA (`owner/repo@<sha> # vX.Y.Z`), not a floating tag like
 * `@v4` — a tag can be retargeted by the action's maintainer (or an attacker
 * who compromises their account) to point at different code without the
 * version string changing. .github/workflows/wiki-publish.yml already does
 * this correctly (`actions/checkout@de0fac2...  # v6.0.0`); this check stops
 * a NEW workflow (or a re-edited existing one) from regressing back to a
 * floating tag.
 *
 * Local composite actions (`uses: ./path`) and Docker image references
 * (`uses: docker://image:tag`) are exempt — there is no upstream tag to spoof.
 *
 * Run: npm run check:workflow-pins
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOWS_DIR = resolve(root, '.github/workflows')

const SHA_RE = /^[0-9a-f]{40}$/

/**
 * Find every `uses:` value in a workflow file and report the ones that are
 * not pinned to a 40-hex commit SHA. Exported for the unit test.
 */
export function findUnpinnedUses(content) {
  const problems = []
  const lines = content.split('\n')
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:-\s*)?uses:\s*(\S+)/)
    if (!m) return
    const ref = m[1]
    // Local composite action or Docker image reference — no upstream tag to pin.
    if (ref.startsWith('./') || ref.startsWith('docker://')) return

    const at = ref.lastIndexOf('@')
    if (at === -1) {
      problems.push({ line: i + 1, ref, reason: 'no @ref at all' })
      return
    }
    const pin = ref.slice(at + 1)
    if (!SHA_RE.test(pin)) {
      problems.push({ line: i + 1, ref, reason: `pinned to "${pin}", not a 40-hex commit SHA` })
    }
  })
  return problems
}

function main() {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  let failed = false

  for (const file of files) {
    const full = resolve(WORKFLOWS_DIR, file)
    const rel = relative(root, full)
    const problems = findUnpinnedUses(readFileSync(full, 'utf8'))
    for (const p of problems) {
      console.error(`✗ ${rel}:${p.line}: ${p.ref} — ${p.reason}`)
      failed = true
    }
  }

  if (failed) {
    console.error('\nPin every third-party `uses:` to a 40-hex commit SHA, e.g.:')
    console.error('  actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0')
    console.error('Resolve with: gh api repos/<owner>/<repo>/git/ref/tags/<tag>')
    console.error('(dereference annotated tag objects via git/tags/<sha> to the underlying commit — do not use the tag object SHA)')
    process.exit(1)
  }
  console.log(`✓ every uses: in ${files.length} workflow file(s) is pinned to a commit SHA`)
}

// Allow import for unit testing without running main().
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
