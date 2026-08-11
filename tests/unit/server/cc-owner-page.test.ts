/*
 * F5 — the cost-centre owner's page, server side.
 *
 * T22 the ranked ladder: the whole-company rung ranks REGIONS, and no
 *     parent-cost-centre rung exists anywhere in the tree.
 * T23 the scope block: where a reader lands, and when a selector is a selector.
 * T26 a zero with an allocation is `not-started`, and the rollup counts it.
 * T30 the model-tier banding: the catalogue's own bands, and an unmatched model
 *     in `unclassified` rather than folded into the cheapest one.
 *
 * Each assertion is written so that reverting its fix turns it red — the
 * partition assertions and the `unclassified` case in particular, which are the
 * two that a "reasonable-looking" wrong implementation would still pass without
 * them.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  costCentreScope,
  summariseCostCentres,
  foldTeammateTierMix,
  NO_PROJECT_ROW_KEY,
  NO_PROJECT_ROW_LABEL,
  type CostCentreCard,
  type VisibleCostCentre,
} from '../../../server/reporting/cost-centres'
import { costCentreBudgetState, MODEL_TIER_BANDS } from '../../../shared/reports/types'
import type { CatalogEntry } from '../../../server/usage/insights'
import { stripComments as stripCommentsShared } from '../../helpers/strip-comments'

const ROOT = join(import.meta.dirname, '../../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
/** Comments out, so a note ABOUT a deleted thing is not the thing. Scanner,
 * not a regex — see the helper's header for the two CodeQL alerts that killed
 * the regex versions. */
const stripComments = (src: string) => stripCommentsShared(src)

function cc(over: Partial<VisibleCostCentre> = {}): VisibleCostCentre {
  return {
    id: 'id-1',
    code: 'c1',
    displayName: 'AI Apps & Data',
    regionId: 'r1',
    regionCode: 'apac',
    owned: false,
    ...over,
  }
}

function card(burnUsd: number, allocationUsd: number): CostCentreCard {
  return {
    id: 'x', code: 'x', displayName: 'X', regionCode: 'apac',
    burnUsd, chargeUsd: 0, allocationUsd,
    utilisation: allocationUsd > 0 ? burnUsd / allocationUsd : null,
    exhaustionDate: null, forecast: null, asOfDate: null,
  }
}

/*
 * ── T22 · THE LADDER ─────────────────────────────────────────────────────────
 *
 * `R:445-449` — `company:{child:'regions'}, region:{child:'centres'},
 * cc:{child:null}`; `R:554-555` — *"A cost centre has no child org node. Its
 * children are its PROJECTS."*
 *
 * So: the whole-company rung ranks REGIONS, cost centres are the children of a
 * REGION, and the parent-cost-centre rung does not exist. An earlier design
 * invented that middle rung (`parentCostCentreId`, `hasChildCostCentres`, a
 * descendant-visibility RBAC clause, a whole deferred slice); the prototype had
 * foreclosed it in one sentence. This is the guard that keeps it deleted.
 */
describe('T22 — the ranked ladder is company → regions → cost centres → projects', () => {
  it('the whole-company view ranks REGIONS, and says that is the only place it answers "which region"', () => {
    const across = read('app/components/reporting/ScopeAcrossRegionsView.vue')
    // The whole-company rung's children table (`R:570-579`) — a REGION ranking,
    // rendered by its own card and mounted here.
    expect(across).toContain('RegionRankCard')
    expect(read('app/components/reporting/across/RegionRankCard.vue')).toContain(
      'data-testid="across-region-rank"',
    )
    // Not merely present: NAMED as the single home of that fact, which is what
    // stops a second regional ranking growing beside it (`R:902-907`).
    expect(across).toMatch(/the ONLY[\s\S]{0,120}which region/)
  })

  it('the COST-CENTRE page no longer ranks cost centres', () => {
    /*
     * `burnerRows` mapped `report.cards`, and the cards ARE the cost centres —
     * so "Top burners" ranked the very dimension the page is about, across
     * every region the viewer could see. That is what made a scoped owner's
     * page read as somebody else's unscoped list.
     */
    const view = read('app/components/reporting/ScopeCostCentreView.vue')
    expect(view).not.toContain('cc-top-burners')
    expect(view).not.toContain('burnerRows')
    expect(view).not.toContain('Top burners')
    // And nothing re-introduced a ranked-magnitude chart over the card list.
    expect(view).not.toContain('ChartRankedBar')
  })

  it('neither cost-centre hero renders a second, TRUNCATED ranking above its table', () => {
    /*
     * `R:628-630` — *"Neither list is a 'top N'. At 14 people and 9 projects the
     * list IS the population — truncating it would hide the person the owner
     * came to find."* Both heroes used to render a `ChartRankedBar :top-n="10"`
     * above a `DriversTable` that already carries a share-of-spend bar per row:
     * ten of fourteen, with nothing saying so, twice.
     *
     * Asserted on the SOURCE rather than the DOM because a truncating chart is
     * a component that renders nothing testable in this environment — a DOM
     * assertion for its absence passes whether or not it is there, which is
     * worse than no assertion.
     */
    // Comments stripped first: the file's own note explaining WHY the chart was
    // removed names it, and a note about a deleted thing is not the thing.
    const drill = stripComments(read('app/components/reporting/cost-centre/CcDrill.vue'))
    expect(drill).not.toContain('ChartRankedBar')
    expect(drill).not.toContain('top-n')
  })

  it('NO parent-cost-centre rung exists anywhere in app/, server/ or shared/', () => {
    for (const p of [
      'app/components/reporting/ScopeCostCentreView.vue',
      'app/components/reporting/ScopeCostCentre.vue',
      'app/components/reporting/cost-centre-report-types.ts',
      'server/reporting/cost-centres.ts',
      'server/api/v1/reports/cost-centres/index.get.ts',
      'server/api/v1/reports/cost-centres/[ccId].get.ts',
      'shared/reports/types.ts',
    ]) {
      const src = read(p)
      expect(src, p).not.toContain('parentCostCentreId')
      expect(src, p).not.toContain('hasChildCostCentres')
      expect(src, p).not.toContain('visibleChildCount')
    }
  })
})

/*
 * ── T23 · LANDING SCOPED ─────────────────────────────────────────────────────
 * `R:551-559`, note `scope`: the tab lands ON a centre; the selector is
 * grant-scoped; *"a reader with exactly one gets no selector at all, just the
 * name — one option is not a selector, it is a label."*
 */
describe('T23 — the scope block lands the reader and knows when a selector is one', () => {
  /*
   * Selector visibility is NOT on the wire — the view counts `options`
   * (`CcScopeLine.vue:65`). So what the server owes is the LIST; these assert
   * its length, which is the same fact without a second copy of it to drift.
   */
  it('ONE visible centre: it is the landing, it is the label, and the list is one long', () => {
    const scope = costCentreScope([cc()])
    expect(scope.defaultCcId).toBe('id-1')
    expect(scope.scopeLabel).toBe('AI Apps & Data')
    expect(scope.options).toHaveLength(1)
  })

  it('several visible centres: the reader lands on the one they OWN, not the one that sorts first', () => {
    /*
     * The ordering the resolver returns is (region, display_name) — an admin's
     * 38-row list. Landing on `[0]` would put a cost-centre owner on somebody
     * else's centre and call it theirs, which is the reported symptom wearing a
     * scope line.
     */
    const scope = costCentreScope([
      cc({ id: 'a', displayName: 'A Centre' }),
      cc({ id: 'b', displayName: 'B Centre', owned: true }),
      cc({ id: 'c', displayName: 'C Centre' }),
    ])
    expect(scope.defaultCcId).toBe('b')
    expect(scope.scopeLabel).toBe('B Centre')
    expect(scope.options.map((o) => o.id)).toEqual(['a', 'b', 'c'])
  })

  it('a reader who owns none lands on the first VISIBLE centre — never nowhere', () => {
    const scope = costCentreScope([cc({ id: 'a' }), cc({ id: 'b' })])
    expect(scope.defaultCcId).toBe('a')
  })

  /*
   * `toEqual` and not `toMatchObject` ON PURPOSE: this is the wire shape. It
   * goes red if a redundant derived flag (the deleted `selectorVisible`, which
   * no consumer ever read) is put back on the block.
   */
  it('no visible centre at all: null landing, null label, and nothing else on the block', () => {
    const scope = costCentreScope([])
    expect(scope).toEqual({ options: [], defaultCcId: null, scopeLabel: null })
  })
})

/*
 * ── T26 · A ZERO WITH AN ALLOCATION SAYS WHY ─────────────────────────────────
 * "$0.00 of $500.00 · 0% · On track" reads as a data failure to the one person
 * who can act on it. The truth is "nobody homed here emitted this month", and
 * it is a state of its own — named `not-started`, the word `useRagState.ts:121`
 * and both prototypes already use, never a second name for one fact.
 */
describe('T26 — a zero with an allocation is `not-started`, not `ok`', () => {
  it('classifies zero utilisation as not-started while every other band is unmoved', () => {
    expect(costCentreBudgetState(0)).toBe('not-started')
    expect(costCentreBudgetState(null)).toBe('none')
    expect(costCentreBudgetState(0.0001)).toBe('ok')
    expect(costCentreBudgetState(0.5)).toBe('ok')
    expect(costCentreBudgetState(0.8)).toBe('warn')
    expect(costCentreBudgetState(1)).toBe('over')
    expect(costCentreBudgetState(1.4)).toBe('over')
  })

  it('the word is `not-started`, never `idle`', () => {
    const src = read('shared/reports/types.ts')
    expect(src).toContain("'not-started'")
    expect(src).not.toContain('countIdle')
    // The label a reader sees is the one the existing pace vocabulary uses.
    expect(read('app/composables/useRagState.ts')).toContain(
      "if (pace === 'not-started') return 'Not started'",
    )
  })

  it('the rollup counts it separately, and the five counts still partition the cards', () => {
    const cards = [card(120, 100), card(90, 100), card(10, 100), card(0, 500), card(50, 0)]
    const s = summariseCostCentres(cards, null)
    expect(s.countNotStarted).toBe(1)
    // The regression this pins: it used to be counted as On track.
    expect(s.countOnTrack).toBe(1)
    expect(
      s.countOverBudget + s.countNearBudget + s.countOnTrack + s.countNotStarted +
        s.countNoAllocation,
    ).toBe(cards.length)
  })
})

/*
 * ── T30 · THE MODEL-TIER MEASURE ─────────────────────────────────────────────
 * The banding is `resolveTier`'s — SUBSTRING against `lower(model)`, first
 * match by `sort_order ASC` — and an unmatched model is `unclassified`, a band
 * in its own right. Folding it into the cheapest band would understate frontier
 * exposure by exactly the spend nobody has classified yet, which is the spend
 * most likely to be new and dear.
 */
const CATALOG: CatalogEntry[] = [
  { model_pattern: 'gpt-5-mini', tier: 'lightweight', sort_order: 50 },
  { model_pattern: 'gpt-5', tier: 'frontier', sort_order: 70 },
  { model_pattern: 'claude-opus', tier: 'frontier', sort_order: 10 },
  { model_pattern: 'claude-sonnet', tier: 'workhorse', sort_order: 20 },
  { model_pattern: 'claude-haiku', tier: 'lightweight', sort_order: 30 },
]
const row = (teammate_id: string | null, model: string | null, value: string) => ({
  teammate_id, model, value,
})

describe('T30 — the drill bands models by the catalogue, and an unknown model is its own band', () => {
  it('an UNMATCHED model lands in `unclassified`, never in the cheapest band', () => {
    const mix = foldTeammateTierMix(
      [row('t1', 'claude-opus-5', '60'), row('t1', 'some-new-model-nobody-catalogued', '40')],
      CATALOG,
    )
    const bands = mix.get('t1')!
    expect(bands.map((b) => b.band)).toEqual(['frontier', 'unclassified'])
    expect(bands.find((b) => b.band === 'unclassified')!.usd).toBe(40)
    // The load-bearing negative: the cheapest band did NOT absorb it.
    expect(bands.find((b) => b.band === 'lightweight')).toBeUndefined()
  })

  it('resolves a model matching TWO patterns by the lowest sort_order, and never twice', () => {
    /*
     * `gpt-5-mini` matches both the `gpt-5-mini` pattern (50, lightweight) and
     * the `gpt-5` pattern (70, frontier). A SQL equijoin would fan out and
     * return the same dollar once per matching pattern, overstating every band
     * AND the total. Resolution happens before a dollar is added, so it cannot.
     */
    const bands = foldTeammateTierMix([row('t1', 'gpt-5-mini', '100')], CATALOG).get('t1')!
    expect(bands).toEqual([{ band: 'lightweight', label: 'Economy', usd: 100 }])
    expect(bands.reduce((a, b) => a + b.usd, 0)).toBe(100)
  })

  it('emits bands in the shared hottest-to-coolest order, not the order the scan returned', () => {
    const bands = foldTeammateTierMix(
      [
        row('t1', 'unknown-thing', '1'),
        row('t1', 'claude-haiku-4-5', '2'),
        row('t1', 'claude-sonnet-5', '3'),
        row('t1', 'claude-opus-5', '4'),
      ],
      CATALOG,
    ).get('t1')!
    const order = bands.map((b) => b.band)
    expect(order).toEqual([...MODEL_TIER_BANDS].filter((b) => order.includes(b)))
    expect(order).toEqual(['frontier', 'workhorse', 'lightweight', 'unclassified'])
  })

  it('a NULL model is OMITTED, never banded — it is a different fact from "unclassified"', () => {
    /*
     * "A model we have not classified" and "spend that never carried a model at
     * all" are two different facts (prototype note `data`). `ModelTierBand` has
     * no member for the second, so it is left out of the mix rather than
     * assigned a band it does not have.
     */
    const mix = foldTeammateTierMix(
      [row('t1', null, '999'), row('t1', 'claude-opus-5', '10')],
      CATALOG,
    )
    expect(mix.get('t1')).toEqual([{ band: 'frontier', label: 'Frontier', usd: 10 }])
  })

  it('a teammate with no banded spend gets NO entry — absence is "not available", not "no frontier usage"', () => {
    expect(foldTeammateTierMix([row('t1', null, '50')], CATALOG).get('t1')).toBeUndefined()
    expect(foldTeammateTierMix([row(null, 'claude-opus-5', '50')], CATALOG).size).toBe(0)
  })
})

describe('T30 — the "Not on a project" row is named once, and is not the untagged-axis key', () => {
  it('has its own key and its own words', () => {
    expect(NO_PROJECT_ROW_LABEL).toBe('Not on a project')
    // NOT `__null_project`: that key means "the axis could not identify a
    // project"; this row names a real, actionable state.
    expect(NO_PROJECT_ROW_KEY).toBe('__no_project')
    expect(NO_PROJECT_ROW_KEY).not.toContain('null')
  })

  it('the project axis clamp admits it — a `p`-only clamp structurally cannot', () => {
    const src = read('server/reporting/cost-centres.ts')
    expect(src).toContain('u.project_id IS NULL AND u.cost_owning_unit_id')
  })
})
