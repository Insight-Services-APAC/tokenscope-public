// @vitest-environment node
/*
 * D9 gate (docs/design/reporting-consolidation/09-reports-performance-plan.md,
 * test T7): every client fetch of a /api/v1/reports endpoint opts out of
 * ofetch's implicit auto-retry.
 *
 * WHY: no call site passes `retry`, and ofetch 1.5.1 defaults GETs to ONE
 * retry with ZERO backoff on 408/409/425/429/500/502/503/504 — the Dev trend
 * 504 immediately re-fired a 30 s query against a struggling server, with no
 * server-side cancellation. `retry: false` must ride every report fetch.
 *
 * Same enforcement pattern as consumption-perf-gate: source-grep over the
 * fetch call sites. Each `useFetch`/`$fetch` call whose URL targets
 * /api/v1/reports must carry `retry: false` inside its options — checked
 * within the call's source window. A NEW report fetch added without the
 * opt-out fails here by construction (the site count is not pinned; every
 * site found is checked).
 *
 * KNOWN LIMIT (v1-L1, accepted): this is a grep gate, not an AST pass — a
 * call whose URL is a computed expression (no /api/v1/reports literal in the
 * first argument) or whose options run past the 800-char window would evade
 * it. Every in-repo site is a literal (template literals included — the
 * regex admits backticks), and the >=17 floor below fails loudly if the
 * sites move somewhere this gate cannot see, which is the cue to extend it
 * rather than a silent pass.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = process.cwd()

/** Every .vue/.ts under app/ (the report fetches all live there). */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else if (/\.(vue|ts)$/.test(name)) out.push(p)
  }
  return out
}

/**
 * Fetch call sites targeting the reports API: `useFetch...(<'/api/v1/reports...`
 * or `$fetch...(` with a template/plain string URL. The window from the call
 * start must contain `retry: false` before the options object can plausibly
 * have closed — 800 chars is generous for every in-repo option block while
 * still local enough that a NEIGHBOURING call's opt-out cannot satisfy it.
 */
const CALL_RE = /(?:useFetch|\$fetch)\s*(?:<[^>]*>)?\s*\(\s*[`'"][^`'"]*\/api\/v1\/reports/g

describe('report fetches never auto-retry (T7 / plan D9)', () => {
  it('every /api/v1/reports fetch call site carries retry: false', () => {
    const offenders: string[] = []
    let sites = 0
    for (const file of walk(join(ROOT, 'app'))) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(CALL_RE)) {
        sites++
        const window = src.slice(m.index!, m.index! + 800)
        if (!/retry:\s*false/.test(window)) {
          const line = src.slice(0, m.index!).split('\n').length
          offenders.push(`${file.replace(ROOT + '/', '')}:${line}`)
        }
      }
    }
    // The gate must actually be looking at something — if the fetches move,
    // this fails loudly instead of passing over an empty set.
    expect(sites).toBeGreaterThanOrEqual(17)
    expect(offenders, 'report fetches missing retry: false').toEqual([])
  })
})
