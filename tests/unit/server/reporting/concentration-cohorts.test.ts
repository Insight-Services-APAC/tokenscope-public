/*
 * The Concentration card's decile partition (Top 1% / Next 9% / Next 40% /
 * Bottom 50%) — `computeConcentration().cohorts`.
 *
 * WHAT THESE ARE FOR. The card renders a sentence ("21 of 207 active developers
 * — the top 10% — account for 63% of attributed spend") beside the
 * Median-per-person KPI, which independently publishes top1/top5/top10. An
 * earlier draft of that card derived its own cohorts and disagreed with the tile
 * by seven points: two contradictory answers to one question, on one screen.
 *
 * So the property under test is not "the numbers look right" — it is that the
 * cohorts and the percentiles are ARITHMETICALLY THE SAME CUT. That is what
 * makes the card safe to render next to the tile.
 */
import { describe, it, expect } from 'vitest'
import { computeConcentration } from '../../../../server/reporting/across-regions'

/** N descending per-teammate costs with a deliberately heavy head. */
function skewed(n: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.round(10_000 / (i + 1) * 100) / 100)
}

describe('computeConcentration — the decile cohorts', () => {
  it('cohort[0] IS top1, and cohort[0]+cohort[1] IS top10 — exactly, not approximately', () => {
    /*
     * The invariant the card leans on. Cut at the same indices as the
     * percentiles, so the card's "the top 10% account for X%" and the tile's
     * "X% top 10%" are one number rather than two that happen to round alike.
     */
    const c = computeConcentration(skewed(207))
    const [top1, next9] = c.cohorts
    expect(top1!.label).toBe('Top 1%')
    expect(next9!.label).toBe('Next 9%')
    expect(top1!.sharePct).toBeCloseTo(c.top1, 12)
    expect(top1!.sharePct + next9!.sharePct).toBeCloseTo(c.top10, 12)
  })

  it('the four cohorts PARTITION the population and the money exactly', () => {
    /*
     * Independently rounding each band's width (round(n×.01) + round(n×.09) +
     * round(n×.40) + round(n×.50)) overshoots to 208 people at n=207 — one more
     * than exist — which is why the bands are cumulative cut points. A card
     * saying "21 of 207" while its own legend sums to 208 contradicts itself.
     */
    for (const n of [207, 100, 63, 31, 30]) {
      const c = computeConcentration(skewed(n))
      const people = c.cohorts.reduce((a, x) => a + x.count, 0)
      const money = c.cohorts.reduce((a, x) => a + x.totalUsd, 0)
      const share = c.cohorts.reduce((a, x) => a + x.sharePct, 0)
      expect(people, `n=${n} people partition`).toBe(c.activeUsers)
      expect(money, `n=${n} money partition`).toBeCloseTo(c.totalUsd, 6)
      expect(share, `n=${n} shares sum to 1`).toBeCloseTo(1, 12)
    }
  })

  it('at n=207 the cut points are 2 / 19 / 83 / 103', () => {
    // Pins the actual arithmetic, so a change to the cut convention has to be
    // deliberate: k1=round(2.07)=2, k10=round(20.7)=21, k50=round(103.5)=104.
    const c = computeConcentration(skewed(207))
    expect(c.cohorts.map((x) => x.count)).toEqual([2, 19, 83, 103])
    expect(c.cohorts.map((x) => x.label)).toEqual(['Top 1%', 'Next 9%', 'Next 40%', 'Bottom 50%'])
  })

  it('drops a band that rounds to zero width rather than printing "0 people · 0%"', () => {
    /*
     * At small n the 1% and 10% cuts collide (both clamp to 1), leaving "Next
     * 9%" empty. An empty legend entry is noise, not information — and the card
     * has its own ≥30 gate above this anyway.
     */
    const c = computeConcentration(skewed(5))
    expect(c.cohorts.every((x) => x.count > 0)).toBe(true)
    expect(c.cohorts.map((x) => x.label)).not.toContain('Next 9%')
    // Still a partition of everyone.
    expect(c.cohorts.reduce((a, x) => a + x.count, 0)).toBe(5)
  })

  it('an empty or zero-cost cohort yields no cohorts at all — never a fabricated split', () => {
    expect(computeConcentration([]).cohorts).toEqual([])
    expect(computeConcentration([0, 0, 0]).cohorts).toEqual([])
  })

  it('leaves the AEUF segments untouched — they answer a different question', () => {
    /*
     * `segments` (top 5% power / next 15% heavy / middle 55% typical / bottom
     * 25% light) is a different cut for a different card, and the Regional width
     * still renders it. Adding `cohorts` must not have moved it.
     */
    const c = computeConcentration(skewed(207))
    expect(c.segments.map((s) => s.key)).toEqual(['power', 'heavy', 'typical', 'light'])
    expect(c.segments.map((s) => s.count)).toEqual([10, 31, 114, 52])
  })
})
