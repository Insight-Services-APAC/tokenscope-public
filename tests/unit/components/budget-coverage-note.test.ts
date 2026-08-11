// @vitest-environment happy-dom
/*
 * BudgetCoverageNote — the coverage denominator rendered beside a §A reporting
 * total ("Four — make reports honest about coverage").
 *
 * IT IS A BAR NOW, not a paragraph (prototype "who" note), so these also pin the
 * picture: four segments, always all four, drawn as shares of the SAME `totalUsd`
 * the claim names — never re-normalised onto Σsegments, which would hide a
 * producer that stopped footing rather than show it.
 *
 * The COPY is still the deliverable alongside the arithmetic. Under 5% of
 * enterprise consumption is on a budgeted project, so a share whose denominator
 * is unnamed is precisely the misreading this note exists to prevent: these pin
 * that the denominator is stated in dollars AND in words, that the scope named is
 * the caller's own (consistency contract C11), that the denominator's OWN limit
 * (§A attributed usage, not all consumption) is disclosed rather than glossed,
 * and that money which structurally cannot carry a project tag is never described
 * as untagged.
 *
 * WHAT THESE CAN AND CANNOT PROVE ABOUT C11. The scope name is CHOSEN on the server,
 * in resolveRegionalScope, because only the code that built the SQL clamp knows what
 * the clamp covers; that choice is pinned in tests/integration/reports/
 * usage-budget-coverage.test.ts against a real subtree-scoped caller. Everything here
 * is the other half — that this component renders the name it was given, adds no
 * opinion of its own, and has no prop through which a caller could supply a different
 * one. An earlier version of this file passed the label in as a prop and called that
 * a C11 test; it could not reach the arm where the label is decided, and the arm it
 * could not reach was the one that was wrong.
 *
 * The share itself is pinned at BOTH ends. `0%` and `100%` are absolute claims to
 * a reader — "none of it", "all of it" — so rounding may manufacture neither, and
 * both must still render when they are true. The high end is the one that bites:
 * a `100%` a reader trusts, next to a remainder the same note itemises.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BudgetCoverageNote from '../../../app/components/reporting/BudgetCoverageNote.vue'
import type { UsageBudgetCoverage } from '#shared/reports/types'
// Asserted through the CONSTANT — the claim is the point, not the noun.
import { BU_LABEL_LOWER } from '#shared/reports/vocabulary'

/** The shape the epic is about: a small covered slice of a large denominator. */
const lowAdoption: UsageBudgetCoverage = {
  scopeLabel: 'APAC',
  totalUsd: 100_000,
  budgetedUsd: 5_000,
  taggedNoBudgetUsd: 20_000,
  untaggedUsd: 65_000,
  untaggableUsd: 10_000,
}

/*
 * The note takes ONE prop. There is deliberately no label argument: the scope name
 * arrives inside `coverage`, from the server that built the clamp, so a test cannot
 * hand in a name the figures were not computed under — and neither can a caller.
 */
const mountNote = (coverage: UsageBudgetCoverage) =>
  mount(BudgetCoverageNote, { props: { coverage } })

/** Collapse render whitespace, so these assert the WORDS rather than the wrapping. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('BudgetCoverageNote', () => {
  it('is never a bare percentage — the card carries BOTH amounts beside the share', () => {
    /*
     * The share moved to a headline and the two amounts to the line under it and
     * to the first segment's own label, so this asserts the CARD rather than one
     * element: what may never happen is a percentage with nothing priced beside
     * it, and that is a property of what the reader sees, not of a div.
     */
    const w = mountNote(lowAdoption)
    expect(norm(w.find('[data-testid="budget-coverage-claim"]').text())).toContain('5%')
    expect(norm(w.text())).toContain('$5,000.00') // what is covered
    expect(norm(w.text())).toContain('$100,000.00') // what it is covered OF
  })

  /*
   * THE SUBLINE IS SIX WORDS. It used to append a thirty-word definition of the §A
   * lane ("every dollar TokenScope attributed to a teammate in APAC, across all
   * providers, tagged or not. Not an invoice.") to every scope on every load. That
   * defines the LANE, not this card, and it lives in the header disclosure's lane
   * caption where the lens is chosen.
   *
   * MUTATION: put either clause back on `budget-coverage-denominator` — the
   * exact-match assertion goes red.
   */
  it('names the denominator and stops — no lane definition, no eyebrow', () => {
    const w = mountNote(lowAdoption)
    expect(norm(w.find('[data-testid="budget-coverage-claim"]').text())).toBe(
      '5% of usage in APAC is on a project with a budget',
    )
    expect(norm(w.find('[data-testid="budget-coverage-denominator"]').text())).toBe(
      'of $100,000.00 attributed usage this period',
    )
    const text = norm(w.text())
    expect(text).not.toContain('every dollar TokenScope attributed')
    expect(text).not.toContain('Not an invoice')
    // The eyebrow labelled a headline that already labels itself.
    expect(text).not.toContain('Budget coverage')
  })

  it('does NOT claim the denominator is all consumption — it names the money it cannot see', () => {
    /*
     * The denominator is §A ATTRIBUTED usage. Provider spend that has never matched
     * a teammate reaches no §A row (shared/reports/types.ts, UsageBudgetCoverage.
     * totalUsd), so it is in neither this figure nor the headline above it. A note
     * whose whole purpose is to stop a total being read as the whole must not do
     * exactly that to its own denominator.
     */
    const text = norm(mountNote(lowAdoption).text())
    expect(text).toContain('never matched to a teammate')
    expect(text).toContain('outside this total')
    // The unqualified form the earlier copy used: consumption "recorded in APAC",
    // full stop, with no statement of what is missing from it.
    expect(text).not.toContain('consumption TokenScope recorded in APAC')
  })

  it('names the scope the FIGURES came with, never one of its own (contract C11)', () => {
    /*
     * The same figures under two nodes must read as two different claims, and the
     * only input that may decide which is `coverage.scopeLabel` — set beside the SQL
     * clamp that produced the amounts. A hard-coded "the company" here would put an
     * enterprise denominator under a region leader's total.
     */
    const company = { ...lowAdoption, scopeLabel: 'the whole company' }
    expect(norm(mountNote(company).text())).toContain('the whole company')
    expect(norm(mountNote(company).text())).not.toContain('APAC')
  })

  it('renders a SUBTREE scope name as given — it does not widen it to a region', () => {
    /*
     * THE DEFECT THIS CLOSES. A manager and a developer both hold `regional:
     * 'own-region'` (shared/auth/report-visibility.ts) but their §A figures are
     * clamped to their `app.user_org_path` SUBTREE (server/auth/org-subtree-scope.ts),
     * so the server sends the unit's name here. The note previously took its label
     * from a parent computing `drill ?? region`, and printed "…attributed usage in
     * APAC…" over one org unit's numbers — an over-wide denominator on the one
     * surface whose entire purpose is honesty about coverage.
     *
     * Nothing about a subtree label is structurally different from a region one, so
     * this asserts the only thing that can go wrong: the component adds no opinion.
     */
    const subtree = { ...lowAdoption, scopeLabel: 'Platform Engineering' }
    const text = norm(mountNote(subtree).text())
    expect(text).toContain('of usage in Platform Engineering is on a project with a budget')
    expect(text).not.toContain('APAC')
    expect(text).not.toContain('this region')
  })

  it('with NO resolved scope, names no scope at all — it does not fall back to one', () => {
    /*
     * `scopeLabel: null` is the case where the caller's own placement is their
     * region's root or a holding node, so `placedBelowRegionRootPredicate`
     * deliberately degrades the subtree clamp to ZERO rows
     * (server/auth/org-subtree-scope.ts). The zeros are not a measurement of the
     * region — the region may be busy — so "No attributed usage recorded in APAC
     * this period" would be flatly false about it.
     */
    const unresolved: UsageBudgetCoverage = {
      scopeLabel: null,
      totalUsd: 0, budgetedUsd: 0, taggedNoBudgetUsd: 0, untaggedUsd: 0, untaggableUsd: 0,
    }
    const w = mountNote(unresolved)
    expect(w.find('[data-testid="budget-coverage-empty"]').exists()).toBe(false)
    const text = norm(w.find('[data-testid="budget-coverage-no-scope"]').text())
    expect(text).toContain('not placed in an org unit below your region')
    expect(text).toContain('no coverage to report')
    // No share, and no scope word standing in for one.
    expect(norm(w.text())).not.toContain('%')
    expect(norm(w.text())).not.toContain('No attributed usage recorded in')
  })

  it('an unresolved scope never renders a claim, even if the figures are non-zero', () => {
    /*
     * Defence in depth against the SHAPE of the bug rather than today's data path.
     * A zero-row clamp cannot produce money today, so the two conditions coincide —
     * which is exactly why a claim guarded only on `totalUsd > 0` would look correct
     * forever and then print "Of the $500.00 attributed usage in  this period" the
     * first time a producer forgets to name its scope. There is no honest sentence
     * to write about money whose scope is unknown, so none is written.
     */
    const nameless: UsageBudgetCoverage = {
      scopeLabel: null,
      totalUsd: 500, budgetedUsd: 100, taggedNoBudgetUsd: 400, untaggedUsd: 0, untaggableUsd: 0,
    }
    const w = mountNote(nameless)
    expect(w.find('[data-testid="budget-coverage-claim"]').exists()).toBe(false)
    expect(w.find('[data-testid="budget-coverage-no-scope"]').exists()).toBe(true)
    expect(norm(w.text())).not.toContain('$500.00')
  })

  it('prices every segment, including the covered one', () => {
    // A four-way split whose parts have no amounts is a shape, and the reader's
    // next question is always "how much is that?".
    const outside = norm(mountNote(lowAdoption).find('[data-testid="budget-coverage-outside"]').text())
    expect(outside).toContain('on a budget $5,000.00')
    expect(outside).toContain('on a project with no budget $20,000.00')
    expect(outside).toContain('not on a project $65,000.00')
    expect(outside).toContain('cannot carry a project tag $10,000.00')
  })

  it('does NOT call structurally untaggable money untagged', () => {
    /*
     * Arm 3 has no project axis at all (mig 0101). Describing it as untagged tells
     * a manager to go and close a bookkeeping gap that cannot be closed.
     */
    const untaggableOnly: UsageBudgetCoverage = {
      scopeLabel: 'APAC',
      totalUsd: 40, budgetedUsd: 0, taggedNoBudgetUsd: 0, untaggedUsd: 0, untaggableUsd: 40,
    }
    const outside = norm(mountNote(untaggableOnly).find('[data-testid="budget-coverage-outside"]').text())
    expect(outside).toContain('cannot carry a project tag $40.00')
    expect(outside).toContain('not on a project $0.00')
    expect(outside).not.toContain('untagged')
  })

  it('with no usage in scope, claims no share at all', () => {
    // 0 ÷ 0 is not "0% covered" — it is a measurement that was never made.
    const empty: UsageBudgetCoverage = {
      scopeLabel: 'APAC',
      totalUsd: 0, budgetedUsd: 0, taggedNoBudgetUsd: 0, untaggedUsd: 0, untaggableUsd: 0,
    }
    const w = mountNote(empty)
    expect(w.find('[data-testid="budget-coverage-claim"]').exists()).toBe(false)
    expect(norm(w.text())).not.toContain('%')
    expect(norm(w.find('[data-testid="budget-coverage-empty"]').text())).toContain(
      'no coverage to report',
    )
  })

  it('draws all four segments even when three are empty', () => {
    /*
     * The sentence this replaced ("Nothing recorded in this period sits outside
     * the budget view") is what the picture now says: one full segment and three
     * priced at $0.00. Keeping all four is the point — the partition is the same
     * four parts in every period, so a reader learns the shape once and reads the
     * WIDTHS thereafter. A card that drops empty parts changes shape under them.
     */
    const fullyCovered: UsageBudgetCoverage = {
      scopeLabel: 'APAC',
      totalUsd: 800, budgetedUsd: 800, taggedNoBudgetUsd: 0, untaggedUsd: 0, untaggableUsd: 0,
    }
    const w = mountNote(fullyCovered)
    // "100%" is EARNED here — budgeted IS the total — and must still reach the
    // screen. The guard below may not cost the note its one true totality claim.
    expect(norm(w.find('[data-testid="budget-coverage-claim"]').text())).toContain('100%')
    expect(w.findAll('[data-testid="budget-coverage-bar"] > i')).toHaveLength(4)
    const outside = norm(w.find('[data-testid="budget-coverage-outside"]').text())
    expect(outside).toContain('on a budget $800.00')
    expect(outside).toContain('on a project with no budget $0.00')
  })

  it('a share SHORT of the whole never rounds up into a claim of totality', () => {
    /*
     * The mirror of the "<1%" case below, and the more damaging half. A drilled
     * practice at 99.6% coverage rendered "$99,600.00 — 100% — is on a project
     * that had a budget for it" while $400 sat outside it. On the ONE surface
     * whose purpose is to be honest about coverage, that is the
     * claims-not-honoured defect stated in the copy the operator reads: it tells
     * them every dollar is budgeted when it is not.
     */
    const nearlyAll: UsageBudgetCoverage = {
      scopeLabel: 'APAC',
      totalUsd: 100_000, budgetedUsd: 99_600, taggedNoBudgetUsd: 400, untaggedUsd: 0, untaggableUsd: 0,
    }
    const w = mountNote(nearlyAll)
    const claim = norm(w.find('[data-testid="budget-coverage-claim"]').text())
    expect(claim).toContain('>99%')
    expect(claim).not.toContain('100%')
    // And the $400 it is short by is still named, in the same breath.
    expect(norm(w.find('[data-testid="budget-coverage-outside"]').text())).toContain(
      'on a project with no budget $400.00',
    )
  })

  /*
   * ── The BAR ────────────────────────────────────────────────────────────────
   * The prose became a picture, so the picture is what has to be pinned: four
   * segments in a fixed order, each priced, drawn as shares of the figure the
   * card names as its denominator.
   */
  const widthPct = (w: ReturnType<typeof mountNote>, key: string): number => {
    const style = w.find(`[data-testid="budget-coverage-seg-${key}"]`).attributes('style') ?? ''
    const m = /width:\s*([\d.]+)%/.exec(style)
    return m ? Number(m[1]) : Number.NaN
  }

  it('draws the four parts as shares of the total it names, footing to the whole', () => {
    /*
     * The widths are taken over `totalUsd` — the same figure the claim above the
     * bar names — never over Σsegments. They are equal by construction today
     * (the server computes all five from ONE scan, usage-coverage.ts), and if a
     * producer ever broke that the bar must visibly fail to fill rather than
     * re-normalise itself onto a denominator this card is not reporting.
     */
    const w = mountNote(lowAdoption)
    expect(widthPct(w, 'budgeted')).toBeCloseTo(5, 5)
    expect(widthPct(w, 'tagged-no-budget')).toBeCloseTo(20, 5)
    expect(widthPct(w, 'untagged')).toBeCloseTo(65, 5)
    expect(widthPct(w, 'untaggable')).toBeCloseTo(10, 5)
    const total = ['budgeted', 'tagged-no-budget', 'untagged', 'untaggable'].reduce(
      (a, k) => a + widthPct(w, k),
      0,
    )
    expect(total).toBeCloseTo(100, 5)
  })

  it('gives a non-zero part that rounds to nothing a visible hairline', () => {
    /*
     * $12 of $100,000 is 0.012% — one hundredth of a pixel at any real width. A
     * segment that exists and cannot be seen reads to the operator as a segment
     * that does not exist, which is the same misreading in miniature that the
     * whole card is here to prevent. It gets a floor, and the LABEL still carries
     * the exact amount so the floor cannot be mistaken for the measurement.
     */
    const sliver: UsageBudgetCoverage = {
      scopeLabel: 'APAC',
      totalUsd: 100_000, budgetedUsd: 99_988, taggedNoBudgetUsd: 12, untaggedUsd: 0, untaggableUsd: 0,
    }
    const w = mountNote(sliver)
    expect(widthPct(w, 'tagged-no-budget')).toBeGreaterThan(0.1)
    // …and an ACTUALLY empty part gets nothing, so the floor cannot invent one.
    expect(widthPct(w, 'untagged')).toBe(0)
    expect(norm(w.find('[data-testid="budget-coverage-outside"]').text())).toContain(
      'on a project with no budget $12.00',
    )
  })

  it('states the consequence of the money it CANNOT show, in one line', () => {
    /*
     * The prototype's "who" note: spend whose provider actor never matched a
     * teammate has no cost centre, so cost-centre totals cannot sum to this
     * page's total. That gap is real and belongs here rather than being
     * discovered on the Finance tab.
     *
     * It is NOT a fifth segment, and that is a data fact: every arm of the §A
     * lane this bar partitions is per-teammate by construction (v_complete_usage,
     * mig 0113) and the unmatched rows live only on the BILLED lane
     * (provider_usage_fact.teammate_id IS NULL, mig 0118). Drawing it here would
     * sum §A and §B and stop the four parts footing to the headline above them.
     */
    const line = norm(mountNote(lowAdoption).find('[data-testid="budget-coverage-unmatched"]').text())
    expect(line).toBe(
      `Provider spend never matched to a teammate is outside this total, so it reaches no ${BU_LABEL_LOWER}.`,
    )
  })

  it('draws no bar at all when there is nothing to take a share of', () => {
    // A four-segment bar of zeros is a picture of a measurement that was never
    // made — the same lie as "0% covered", drawn instead of written.
    const empty: UsageBudgetCoverage = {
      scopeLabel: 'APAC',
      totalUsd: 0, budgetedUsd: 0, taggedNoBudgetUsd: 0, untaggedUsd: 0, untaggableUsd: 0,
    }
    expect(mountNote(empty).find('[data-testid="budget-coverage-bar"]').exists()).toBe(false)
    const nameless: UsageBudgetCoverage = { ...lowAdoption, scopeLabel: null }
    expect(mountNote(nameless).find('[data-testid="budget-coverage-bar"]').exists()).toBe(false)
  })

  it('a tiny non-zero share reads "<1%", never a rounded-away 0%', () => {
    // The real adoption shape rounds to nothing at 0 decimal places, and "0%
    // covered" beside a non-zero covered amount reads as a contradiction.
    const sliver: UsageBudgetCoverage = {
      scopeLabel: 'APAC',
      totalUsd: 100_000, budgetedUsd: 400, taggedNoBudgetUsd: 0, untaggedUsd: 99_600, untaggableUsd: 0,
    }
    const claim = norm(mountNote(sliver).find('[data-testid="budget-coverage-claim"]').text())
    expect(claim).toContain('<1%')
    expect(claim).not.toContain(' 0%')
  })
})
