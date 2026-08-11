// @vitest-environment happy-dom
/*
 * SpendPerDeveloperCard — the card the owner cited when he asked why a chart
 * needed a paragraph.
 *
 * It shipped as: the chart, three deltas each with a `($4.75 → $8.45)`
 * parenthetical, a VERDICT sentence ("Both headcount and per-head spend moved"),
 * and a four-line methodology paragraph explaining what a point is, what a
 * half-window mean is, and what an empty day does to the trailing mean.
 *
 * The prototype's whole card is:
 *
 *   +2%        +38%                 +41%
 *   per head   active developers    total spend
 *                                             bold = 7-day mean
 *
 * THE RULE THIS FILE PINS, and it is the one the sweep applied everywhere:
 *   - a sentence that states a FACT a reader is misled without → keep, one line.
 *   - a sentence that explains HOW we computed it, defends a choice, or
 *     INTERPRETS numbers already on screen → delete. The reasoning survives in
 *     the code comments, which is where it belonged.
 *   - a LEGEND naming which series is which → keep. "bold = 7-day mean" is not
 *     commentary; a reader cannot deduce it.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SpendPerDeveloperCard from '../../../app/components/reporting/SpendPerDeveloperCard.vue'
import type { PerDeveloperSeries } from '../../../shared/reports/per-developer'

const global = {
  stubs: { ClientOnly: { template: '<div><slot /></div>' }, VChart: true },
}

const points = Array.from({ length: 60 }, (_, i) => ({
  day: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
  spendUsd: 100 + i,
  activeDevelopers: 10,
  perDeveloperUsd: (100 + i) / 10,
}))

const series: PerDeveloperSeries = {
  window: { from: '2026-06-01', to: '2026-07-30' },
  points,
  deltaDays: 30,
  deltas: {
    // Both moved — the case whose verdict sentence read "Both headcount and
    // per-head spend moved", which is the deleted interpretation.
    perDeveloperUsd: { recent: 8.45, prior: 4.75, deltaPct: 0.78 },
    activeDevelopers: { recent: 165.1, prior: 121.9, deltaPct: 0.35 },
    totalSpendUsd: { recent: 41_840.67, prior: 17_377.06, deltaPct: 1.41 },
  },
}

const mountCard = (over: Partial<PerDeveloperSeries> = {}) =>
  mount(SpendPerDeveloperCard, {
    props: { series: { ...series, ...over }, windowLabel: 'Last 60 days' },
    global,
  })

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/*
 * MUTATION: re-add `<p data-testid="per-developer-verdict">{{ verdict }}</p>` and
 * the methodology paragraph under the deltas — these go red.
 */
describe('SpendPerDeveloperCard — the deltas are the answer, not narrated', () => {
  it('states no verdict about numbers the reader can see', () => {
    const text = norm(mountCard().text())
    expect(text).not.toContain('Both headcount and per-head spend moved')
    expect(text).not.toContain('the change is headcount, not behaviour')
    expect(text).not.toContain('this is the conversation to have')
    expect(mountCard().find('[data-testid="per-developer-verdict"]').exists()).toBe(false)
  })

  it('carries no methodology paragraph', () => {
    const text = norm(mountCard().text())
    expect(text).not.toContain('Each point is that day')
    expect(text).not.toContain('a period figure is the mean of daily counts')
    expect(text).not.toContain('the same basis as the deltas above')
    expect(text).not.toContain('a gap in the line, not a zero')
  })

  /*
   * MUTATION: restore the `({{ d.format(d.delta.prior) }} → {{ … recent }})`
   * span — the "no parentheticals" assertion goes red. The prototype states the
   * percentage and the label, and nothing else.
   */
  it('shows percentage + label per delta, with no before→after parenthetical', () => {
    const row = norm(mountCard().find('[data-testid="per-developer-deltas"]').text())
    expect(row).toContain('per head')
    expect(row).toContain('active developers')
    expect(row).toContain('total spend')
    expect(row).not.toContain('→')
    expect(row).not.toContain('$4.75')
    expect(row).not.toContain('121.9')
    expect(row).not.toContain('$17,377.06')
  })
})

/*
 * The two sentence kinds the sweep PRESERVES. A card that deleted these would
 * have over-corrected, so they are pinned as deliberately as the deletions.
 */
describe('SpendPerDeveloperCard — what survives the sweep', () => {
  it('keeps the insufficient-data state, which is honest rather than commentary', () => {
    const w = mountCard({ deltas: null })
    expect(norm(w.find('[data-testid="per-developer-no-deltas"]').text())).toBe(
      'Needs two full 30-day halves to compare.',
    )
  })

  it('keeps the card naming what it measures, once, at the top', () => {
    // A metric whose definition is not on screen is unreadable; this is the
    // prototype's own lede, not an explanation bolted underneath a visual.
    expect(norm(mountCard().text())).toContain(
      'Daily attributed usage divided by developers active that day',
    )
  })
})
