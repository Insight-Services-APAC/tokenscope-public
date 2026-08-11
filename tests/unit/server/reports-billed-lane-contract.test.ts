// @vitest-environment node
/*
 * The BILLED lane's STATIC contract — the half `reports-lane-firewall.test.ts`
 * deliberately does not cover, and the half `billed-drivers.test.ts` cannot.
 *
 * Three different tests guard three different things, and none of them
 * subsumes another:
 *
 *   reports-lane-firewall — no reporting file names a banned RELATION
 *                           (`attribution_record`, `attribution_aggregate`, raw
 *                           `actual_spend`), one statement at a time.
 *   THIS FILE             — the billed-lane MODULE reads one relation and no
 *                           other, and the retired `outsideBilledLane` measure
 *                           is gone from the tree.
 *   billed-drivers (int)  — every billed FIGURE is invariant under a change to
 *                           the attributed lane, which is the only way to catch
 *                           a two-query in-memory fold. A ratio built across two
 *                           statements is invisible to both static tests.
 *
 * Comments are stripped first, so a doc-comment discussing a relation (like this
 * file's own, or the module's header, which names `v_complete_usage` several
 * times while never reading it) is not a false positive.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const BILLED_AXIS = join(ROOT, 'server', 'reporting', 'engine', 'billed-axis.ts')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|vue)$/.test(full)) out.push(full)
  }
  return out
}

/** Strip block + line comments (line-comment strip skips `https://` URLs). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const SOURCE_DIRS = ['server', 'shared', 'app'].map((d) => join(ROOT, d))

describe('the billed axis reads ONE relation', () => {
  const code = stripComments(readFileSync(BILLED_AXIS, 'utf8'))

  it('reads `provider_usage_fact` (sanity — the assertions below are about real SQL)', () => {
    expect(code).toMatch(/\bprovider_usage_fact\b/)
  })

  it('never reads the ATTRIBUTED lane — a billed figure has no attributed operand', () => {
    // The mechanism a coverage ratio needs: a second relation to divide by. If
    // this module never names one, `f` cannot be built inside it, and the
    // integration suite proves it is not built across it either.
    expect(code).not.toMatch(/\bv_complete_usage\b/)
    expect(code).not.toMatch(/\bunaccounted_usage\b/)
    expect(code).not.toMatch(/\battribution_record\b/)
    expect(code).not.toMatch(/\battribution_aggregate\b/)
  })

  it('never reads a §B bill view — the billed lane is the fact table, not the ledger', () => {
    // `provider_usage_fact` and `v_finance_*` are BOTH "billing-ish" and are not
    // the same thing: the fact table is per-teammate provider truth, the finance
    // views are the chargeback ledger. One query holding both is a figure nobody
    // can name.
    expect(code).not.toMatch(/\bv_finance_/)
    expect(code).not.toMatch(/\bcopilot_pool_bill\b/)
    expect(code).not.toMatch(/\bactual_spend\b/)
  })
})

describe('`outsideBilledLane` is gone', () => {
  /*
   * It was a MEASURE (plus a footer) whose entire job was to explain the missing
   * GitHub arm of the provider transform. That arm now exists — mig 0120 and
   * `provider-transform-github.ts` — so the measure explains a gap that is not
   * there, and a caveat that names a closed gap is worse than no caveat: a
   * reader discounts a figure for a reason that stopped being true.
   *
   * What SURVIVES is `availability` (`no-data-yet` | `none-in-scope` |
   * `present`), which is a real and permanent state: an hourly transform will
   * always have a window it has not reached yet.
   */
  const files = SOURCE_DIRS.flatMap(walk)

  it('scans the source tree (sanity — files are present)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('appears in no source file, in any casing form', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, `${f} still references outsideBilledLane`).not.toMatch(/outsideBilledLane/i)
      expect(src, `${f} still references outside_billed_lane`).not.toMatch(/outside_billed_lane/i)
    }
  })

  it('the state that REPLACED it is still declared', async () => {
    // Guards the other direction: deleting the caveat must not also delete the
    // honest empty-state, or a fresh environment renders "$0 across all
    // drivers" and states something about the estate the data cannot support.
    const types = readFileSync(join(ROOT, 'shared', 'reports', 'types.ts'), 'utf8')
    for (const state of ['no-data-yet', 'none-in-scope', 'present']) {
      expect(types).toContain(`'${state}'`)
    }
  })
})

describe('the provider-measure authority is the only place the split is written', () => {
  it('agrees with `fetchTierExposure` about which provider meters consumption', async () => {
    /*
     * The two modules answer NEIGHBOURING questions — "may this money be called
     * billed?" and "may this money be banded by model?" — and today they have
     * the same answer for the same underlying reason (Copilot's credits sit at
     * the record root, day grain). They are deliberately separate functions, so
     * this is the assertion that stops them drifting into disagreeing about the
     * FACT while continuing to answer their own questions.
     */
    const { providerMeasure } = await import('../../../shared/reports/provider-measure')
    const tier = stripComments(
      readFileSync(join(ROOT, 'server', 'reporting', 'engine', 'tier-exposure.ts'), 'utf8'),
    )
    expect(providerMeasure('github')).toBe('consumption')
    expect(tier).toMatch(/provider === 'github' \? 'mix-only'/)

    // Anything not named is BILLED by default — the loud failure direction.
    expect(providerMeasure('anthropic')).toBe('billed')
    expect(providerMeasure('some-future-provider')).toBe('billed')
  })
})
