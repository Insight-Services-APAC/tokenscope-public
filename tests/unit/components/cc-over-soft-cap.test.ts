// @vitest-environment happy-dom
/*
 * CcOverSoftCap — "Unallocated spend over the soft cap", the cost-centre lead's
 * conversation list (docs/design/reporting-consolidation/04-prototype-delta.md §5).
 *
 * THE COPY IS THE DELIVERABLE, not just the arithmetic, and these assert the
 * claims a reader actually acts on:
 *
 *   1. THE RATE IS NOT A GATE. A heavy user tagging 88% of a large total still
 *      appears, because the multiple is what makes the row actionable. This is the
 *      defect two earlier drafts of this card shipped (a $250 floor, then a 60%
 *      rate) and the one the design names explicitly.
 *   2. THE SPLIT IS BY WHAT THE READER CAN ACT ON. "Nudge them" only ever appears
 *      beside someone who has a budget to be nudged toward.
 *   3. NO ACTION BUTTONS, ANYWHERE. `tagUnaccountedTx` permits only a record's own
 *      teammate to tag it, so a control here would be an affordance the reader
 *      cannot use. Asserted structurally (no buttons) rather than by reading copy,
 *      because copy can be right while a control is present.
 *   4. EMPTY IS A SENTENCE. "All within allowance", never a $0 headline — on a card
 *      about money going unnoticed, "$0" reads as a failed fetch.
 *   5. THE DENOMINATOR IS NAMED, and named as NOT the burn. The two are different
 *      populations and a reader who reconciles them concludes one is broken.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CcOverSoftCap from '../../../app/components/reporting/cost-centre/CcOverSoftCap.vue'
import type { OverSoftCap, OverSoftCapRow } from '#shared/reports/types'
// Asserted through the CONSTANT: these tests are about the CLAIM, and pinning
// the noun made a vocabulary change read as a behaviour regression.
import { BU_LABEL_LOWER } from '#shared/reports/vocabulary'

const row = (o: Partial<OverSoftCapRow> & { teammate: string }): OverSoftCapRow => ({
  teammateId: `id-${o.teammate}`,
  // THE DRILL FACTS (D34) — server-carried, never inferred by the card (r5-H1).
  isActive: true,
  isProvisional: false,
  unallocatedUsd: 0,
  capMultiple: 0,
  taggedRate: 0,
  projects: 0,
  group: 'on-no-project',
  ...o,
})

/*
 * The fixture IS the design's own worked example. ada.lovelace tags 88% of $6,749
 * and STILL leaves 8× the cap unallocated: he is the person every rate-gated draft
 * of this card dropped, so he is the row these tests are anchored on. Richard tags
 * 9% of a much smaller total — the opposite shape, present so "shows the untidy
 * ones" cannot be mistaken for the rule.
 */
const withOver: OverSoftCap = {
  softCapUsd: 100,
  rosterCount: 6,
  rosterUsd: 9_000,
  allocatedUsd: 7_000,
  unallocatedUsd: 2_000,
  over: [
    row({ teammate: 'Ada Lovelace', unallocatedUsd: 809.93, capMultiple: 8.1, taggedRate: 0.88, projects: 4, group: 'on-projects' }),
    row({ teammate: 'Richard Marshall', unallocatedUsd: 722.59, capMultiple: 7.2, taggedRate: 0.09, projects: 2, group: 'on-projects' }),
    row({ teammate: 'Kwame Osei', unallocatedUsd: 357.32, capMultiple: 3.6, taggedRate: 0, projects: 0, group: 'on-no-project' }),
  ],
  withinAllowance: { teammates: 3, unallocatedUsd: 40.5, fullyAllocated: 2 },
}

/** A cost centre where every dollar is on a budget — the "all within allowance" case. */
const allWithin: OverSoftCap = {
  softCapUsd: 100,
  rosterCount: 5,
  rosterUsd: 4_200,
  allocatedUsd: 4_200,
  unallocatedUsd: 0,
  over: [],
  withinAllowance: { teammates: 5, unallocatedUsd: 0, fullyAllocated: 5 },
}

const mountCard = (data: OverSoftCap) => mount(CcOverSoftCap, { props: { data } })
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('CcOverSoftCap — who is over the cap', () => {
  it('THE RATE IS NOT A GATE: an 88%-tagging heavy user is listed, with the rate as context', () => {
    /*
     * The whole argument for this card's shape. Every draft that gated on the rate
     * dropped exactly this row — the largest unallocated sum on the page — so the
     * assertion is that he is PRESENT, that his multiple is stated (what makes the
     * row actionable), and that his rate rides along beside it rather than deciding
     * anything.
     */
    const text = norm(mountCard(withOver).text())
    expect(text).toContain('Ada Lovelace')
    expect(text).toContain('$809.93')
    expect(text).toContain('8.1×')
    expect(text).toContain('88% tagged')
    // …and the low-rate row is not treated differently: both are simply over the cap.
    expect(text).toContain('Richard Marshall')
    expect(text).toContain('9% tagged')
  })

  it('the headline counts BOTH groups and names the cap it is over', () => {
    const h = norm(mountCard(withOver).find('[data-testid="cc-osc-headline"]').text())
    expect(h).toContain('$1,890') // 809.93 + 722.59 + 357.32, whole dollars
    expect(h).toContain('3')
    expect(h).toContain('$100 soft cap')
  })

  it('splits by what the reader can act on — "nudge them" only where a budget exists', () => {
    const w = mountCard(withOver)
    const onProjects = w.find('[data-testid="cc-osc-group-on-projects"]')
    const onNoProject = w.find('[data-testid="cc-osc-group-on-no-project"]')

    expect(norm(onProjects.text())).toContain('nudge them')
    expect(norm(onProjects.text())).toContain('a budget exists to put this on')
    expect(norm(onProjects.text())).toContain('Ada Lovelace')
    // The nudge NEVER appears over someone with nothing to tag to — that is an
    // instruction they cannot follow, and the write path would refuse it.
    expect(norm(onNoProject.text())).not.toContain('nudge them')
    expect(norm(onNoProject.text())).toContain('allocate to projects')
    expect(norm(onNoProject.text())).toContain('Kwame Osei')
    expect(norm(onNoProject.text())).toContain('on no project')
    expect(norm(onNoProject.text())).not.toContain('Ada Lovelace')
  })

  it('an empty group is absent, not an empty heading', () => {
    // A "On no project — 0 people" heading invites the reader to look for rows that
    // are not there, and reads as a truncated list rather than an answer.
    const w = mountCard({ ...withOver, over: withOver.over.filter((r) => r.group === 'on-projects') })
    expect(w.find('[data-testid="cc-osc-group-on-projects"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-osc-group-on-no-project"]').exists()).toBe(false)
  })

  it('NO ACTION BUTTONS — only a teammate can tag their own spend', () => {
    /*
     * Structural, not textual. The copy could say the right thing beside a control
     * that 403s, and that is the failure this asserts against: the card renders no
     * button and no link at all (its own CSV export is not passed in here).
     */
    const w = mountCard(withOver)
    expect(w.findAll('button').length).toBe(0)
    expect(w.findAll('a').length).toBe(0)
    /*
     * …and it no longer SAYS so either. "Only a teammate can tag their own spend,
     * so there is nothing to action from here — this is who to talk to, and about
     * what" told the reader how to interpret a list of names and defended the
     * absence of a button. The absence is the assertion; the sentence was
     * commentary on it.
     *
     * MUTATION: restore `cc-osc-no-action-note` — this goes red.
     */
    expect(w.find('[data-testid="cc-osc-no-action-note"]').exists()).toBe(false)
    expect(norm(w.text())).not.toContain('nothing to action from here')
  })

  it('names its OWN denominator — the placed roster, explicitly not the burn', () => {
    /*
     * `rosterUsd` and the drill's `burnUsd` are different questions over different
     * populations. Rendering the figure without saying so invites a reader to
     * reconcile them and report the gap as a defect.
     */
    const d = norm(mountCard(withOver).find('[data-testid="cc-osc-denominator"]').text())
    expect(d).toContain(`6 people placed in this ${BU_LABEL_LOWER}`)
    expect(d).toContain('$9,000.00')
    // One clause, not a paragraph explaining how the burn's denominator differs.
    expect(d).toContain('not the burn above')
    expect(d).toContain('Soft cap is each teammate\'s base allowance, configured.')
  })

  it('collapses within-allowance to ONE line, and never lists them', () => {
    const w = mountCard(withOver)
    expect(norm(w.find('[data-testid="cc-osc-within"]').text())).toBe(
      'Within allowance: $40.50 across 3 people, not shown. 2 fully allocated.',
    )
    // Exactly the over-cap rows are rows.
    expect(w.findAll('[data-testid="cc-osc-row"]').length).toBe(3)
  })

  it('a $0 cap has no multiple to state — an em-dash, never "0×" or "Infinity×"', () => {
    // NUXT_BASE_ALLOWANCE_USD=0 is a legal configuration (base-allowance.ts keeps
    // it), and both a fabricated 0 and an Infinity would be false statements.
    const w = mountCard({
      ...withOver,
      softCapUsd: 0,
      over: [row({ teammate: 'Zero Cap', unallocatedUsd: 5, capMultiple: null, taggedRate: 0, projects: 1, group: 'on-projects' })],
    })
    const text = norm(w.text())
    expect(text).not.toContain('0.0×')
    expect(text).not.toContain('Infinity')
    expect(text).not.toContain('NaN')
  })
})

describe('CcOverSoftCap — nobody over the cap', () => {
  it('renders "all within allowance" as a SENTENCE, never a $0 headline', () => {
    /*
     * The empty state named in the design's §7 table. On a card whose subject is
     * money nobody noticed, a big "$0" is indistinguishable from a failed fetch —
     * so the zero case is a claim in words, and the headline element is absent
     * rather than showing zero.
     */
    const w = mountCard(allWithin)
    expect(w.find('[data-testid="cc-osc-headline"]').exists()).toBe(false)
    const s = norm(w.find('[data-testid="cc-osc-all-within"]').text())
    expect(s).toContain('All within allowance')
    // The verdict is a WORD and its evidence are FIGURES now, not a 32-word
    // sentence. Same three facts: nobody over, the roster, the cap.
    expect(s).toContain('All within allowance')
    expect(s).toContain('5 people')
    expect(s).toContain('$100')
    expect(s).toContain('cap $100')
    expect(s).not.toContain('$0')
    expect(w.findAll('[data-testid="cc-osc-row"]').length).toBe(0)
  })

  it('under-cap unallocated money is still named — "within allowance" is not "all tagged"', () => {
    /*
     * Two different claims, and the card must not let one stand for the other. A
     * roster with $60 unallocated under the cap has money to allocate; saying only
     * "all within allowance" would let a reader hear "everything is tagged".
     */
    const s = norm(
      mountCard({
        ...allWithin,
        allocatedUsd: 4_140,
        unallocatedUsd: 60,
        withinAllowance: { teammates: 5, unallocatedUsd: 60, fullyAllocated: 2 },
      })
        .find('[data-testid="cc-osc-all-within"]')
        .text(),
    )
    expect(s).toContain('$60.00')
    expect(s).toContain('unallocated')
    // 'under the cap' was the sentence's clause; the verdict pill now carries it.
    expect(s).toContain('All within allowance')
  })
})

/* ── THE DRILL CONTRACT on this card (D29/D34, r5-H1) ───────────────────────── */

describe('CcOverSoftCap — a name is a link or plain text BY FACT, never by inference', () => {
  /*
   * THE DEFECT THESE PIN. This card used to call `teammateDrillTarget` with
   * `isActive: true` hard-coded — justified by the roster CTE's
   * `WHERE t.is_active = TRUE` — and to say nothing about `provisional` at all.
   * A PROVISIONAL SHADOW (the unauthenticated enrol path's teammate: ACTIVE, with
   * an email nobody has verified — mig 0057) therefore satisfied every conjunct
   * the card could see, and the cost-centre lead's "who to contact" list rendered
   * a victim's email as a live link onto a page that 403s.
   *
   * MUTATION: put `{ id: r.teammateId, isActive: true }` back in `targetFor`
   * (CcOverSoftCap.vue) and the first test goes red — the shadow is a link again.
   * Drop `${TEAMMATE_DRILL_FACTS}` from the roster CTE in
   * `server/reporting/engine/over-soft-cap.ts` and the integration sibling
   * (`tests/integration/reports/over-soft-cap.test.ts`) goes red instead.
   */
  const GRANTED = { teammate: 'people-scope', project: 'member-in-scope' } as const
  const FRAME = { src: 'cc:cc-1', month: '2026-07' }

  const withShadow: OverSoftCap = {
    ...withOver,
    over: [
      row({ teammate: 'Ada Lovelace', unallocatedUsd: 809.93, capMultiple: 8.1, taggedRate: 0.88, projects: 4, group: 'on-projects' }),
      row({ teammate: 'victim@corp.example', unallocatedUsd: 500, capMultiple: 5, taggedRate: 0, projects: 2, group: 'on-projects', isProvisional: true }),
      row({ teammate: 'Gone Away', unallocatedUsd: 400, capMultiple: 4, taggedRate: 0, projects: 1, group: 'on-projects', isActive: false }),
    ],
  }

  const mountDrillable = (data: OverSoftCap) =>
    mount(CcOverSoftCap, {
      props: { data, drillGrants: GRANTED, drillFrame: FRAME },
      global: {
        stubs: { NuxtLink: { props: ['to'], template: '<a><slot /></a>' }, ExportCsvButton: true },
      },
    })

  const stateOf = (w: ReturnType<typeof mountDrillable>, name: string): 'link' | 'plain' => {
    const r = w.findAll('[data-testid="cc-osc-row"]').find((x) => x.text().includes(name))!
    expect(r, `no row for ${name}`).toBeTruthy()
    return r.find('[data-testid="drill-link"]').exists() ? 'link' : 'plain'
  }

  it('a PROVISIONAL shadow is listed but is NOT a door', () => {
    const w = mountDrillable(withShadow)
    // The row STAYS: `over.length + withinAllowance.teammates = rosterCount` is
    // an identity this card publishes, so dropping a subject to close a door
    // would break the arithmetic instead.
    expect(w.text()).toContain('victim@corp.example')
    expect(stateOf(w, 'victim@corp.example')).toBe('plain')
    // A confirmed, active subject still opens — this is not a blanket close.
    expect(stateOf(w, 'Ada Lovelace')).toBe('link')
  })

  it('a DEACTIVATED subject is not a door either — the fact comes off the ROW, not the roster filter', () => {
    // The row can only exist because the server said `isActive: false` on it.
    // Before the fix the card asserted `true` regardless and linked it.
    expect(stateOf(mountDrillable(withShadow), 'Gone Away')).toBe('plain')
  })

  it('with NO frame, nothing on the card is a door', () => {
    const w = mount(CcOverSoftCap, {
      props: { data: withShadow, drillGrants: GRANTED, drillFrame: { src: null } },
      global: {
        stubs: { NuxtLink: { props: ['to'], template: '<a><slot /></a>' }, ExportCsvButton: true },
      },
    })
    expect(w.findAll('[data-testid="drill-link"]').length).toBe(0)
  })
})

describe('CcOverSoftCap — the two states are EXCLUSIVE', () => {
  /*
   * Regression, found by adversarial review. Converting the "all within
   * allowance" sentence into a verdict-plus-figures replaced a `<p v-else>`
   * with a `<div>` and dropped the `v-else` with it — so any cost centre WITH
   * people over the cap rendered the over-cap list AND "✓ All within
   * allowance" underneath it. A governance surface stating the opposite of
   * what it had just listed.
   */
  it('never shows the green verdict while anyone is over the cap', () => {
    const w = mountCard(withOver)
    // The over-cap list is present...
    expect(w.find('[data-testid="cc-osc-over-list"]').exists()
      || norm(w.text()).length > 0).toBe(true)
    // ...so the green verdict must NOT be.
    expect(w.find('[data-testid="cc-osc-all-within"]').exists()).toBe(false)
    expect(norm(w.text())).not.toContain('All within allowance')
  })
})
