// @vitest-environment node
/*
 * Spend per active developer — the division and the three deltas.
 *
 * The card's whole claim is that ONE window with THREE numerators lets a reader
 * see which of headcount or behaviour moved. These tests pin the two ways that
 * claim breaks: halves computed over different lengths, and a per-head figure
 * taken as the mean of daily ratios (which weights a quiet two-person day the
 * same as a busy sixty-person one).
 */
import { describe, it, expect } from 'vitest'
import {
  buildPerDeveloperSeries,
  PER_DEVELOPER_DELTA_DAYS,
  type DailyMetricLike,
} from '../../../shared/reports/per-developer'

const WINDOW = { from: '2026-06-01', to: '2026-07-30' }

/** `n` days, each with the given spend + actives. */
function days(n: number, genuineUsd: number, activeUsers: number, startDay = 1): DailyMetricLike[] {
  return Array.from({ length: n }, (_, i) => ({
    day: `2026-06-${String(startDay + i).padStart(2, '0')}`,
    genuineUsd,
    activeUsers,
  }))
}

describe('buildPerDeveloperSeries — the daily division', () => {
  it('divides spend by that day’s distinct actives', () => {
    const out = buildPerDeveloperSeries(
      [{ day: '2026-06-01', genuineUsd: 300, activeUsers: 12 }],
      WINDOW,
    )
    expect(out.points[0]).toEqual({
      day: '2026-06-01',
      spendUsd: 300,
      activeDevelopers: 12,
      perDeveloperUsd: 25,
    })
  })

  it('leaves a GAP, not a zero, on a day with no active developer', () => {
    // Nobody spent nothing per head that day — there was nobody. A 0 would draw a
    // line touching the axis and read as a collapse in per-head spend.
    const out = buildPerDeveloperSeries(
      [{ day: '2026-06-01', genuineUsd: 0, activeUsers: 0 }],
      WINDOW,
    )
    expect(out.points[0]!.perDeveloperUsd).toBeNull()
  })
})

describe('buildPerDeveloperSeries — the three deltas', () => {
  it('withholds them when the series is shorter than two full halves', () => {
    // A half computed over four days beside a half computed over thirty is not a
    // delta, and stating one anyway is the defect this guard exists to prevent.
    const out = buildPerDeveloperSeries(days(PER_DEVELOPER_DELTA_DAYS * 2 - 1, 100, 10), WINDOW)
    expect(out.deltas).toBeNull()
    expect(out.deltaDays).toBe(PER_DEVELOPER_DELTA_DAYS)
  })

  it('states all three off ONE 60-day window, halves taken from the END', () => {
    const n = PER_DEVELOPER_DELTA_DAYS
    // Prior half: $100/day over 10 devs → $10/head. Recent half: $300/day over
    // 20 devs → $15/head. Headcount doubled AND per-head moved 50%.
    const series = [...days(n, 100, 10, 1), ...days(n, 300, 20, 1)]
    const out = buildPerDeveloperSeries(series, WINDOW)
    const d = out.deltas!

    expect(d.totalSpendUsd).toEqual({ recent: 300 * n, prior: 100 * n, deltaPct: 2 })
    expect(d.activeDevelopers).toEqual({ recent: 20, prior: 10, deltaPct: 1 })
    expect(d.perDeveloperUsd.prior).toBeCloseTo(10, 9)
    expect(d.perDeveloperUsd.recent).toBeCloseTo(15, 9)
    expect(d.perDeveloperUsd.deltaPct).toBeCloseTo(0.5, 9)
  })

  it('takes the halves from the END of a longer series', () => {
    const n = PER_DEVELOPER_DELTA_DAYS
    // 20 leading days that must NOT enter either half.
    const series = [...days(20, 9999, 1, 1), ...days(n, 100, 10, 1), ...days(n, 300, 20, 1)]
    const out = buildPerDeveloperSeries(series, WINDOW)
    expect(out.deltas!.totalSpendUsd.prior).toBe(100 * n)
    expect(out.deltas!.totalSpendUsd.recent).toBe(300 * n)
  })

  it('weights per-head by VOLUME, not by day — Σ spend ÷ Σ actives', () => {
    const n = PER_DEVELOPER_DELTA_DAYS
    // Recent half: one busy day ($1000 over 100 devs = $10/head) and 29 quiet
    // days ($10 over 1 dev = $10/head)… identical ratios, so this fixture makes
    // the two methods agree. Skew it instead: a quiet day at $100/head.
    const recent = [
      { day: '2026-07-01', genuineUsd: 1000, activeUsers: 100 },
      ...Array.from({ length: n - 1 }, (_, i) => ({
        day: `2026-07-${String(i + 2).padStart(2, '0')}`,
        genuineUsd: 100,
        activeUsers: 1,
      })),
    ]
    const out = buildPerDeveloperSeries([...days(n, 100, 10, 1), ...recent], WINDOW)

    const sumSpend = 1000 + 100 * (n - 1)
    const sumActive = 100 + (n - 1)
    // Volume-weighted: Σ$3900 ÷ Σ129 actives ≈ $30.23.
    expect(out.deltas!.perDeveloperUsd.recent).toBeCloseTo(sumSpend / sumActive, 9)
    // The mean of the daily ratios would be (10 + 29×100)/30 ≈ $96.99 — more
    // than triple, because it lets 29 one-person days outvote the day 100 people
    // actually worked.
    const meanOfRatios = (10 + 100 * (n - 1)) / n
    expect(out.deltas!.perDeveloperUsd.recent).not.toBeCloseTo(meanOfRatios, 2)
  })

  it('reports deltaPct null — never ∞ or 0% — when the prior half is zero', () => {
    const n = PER_DEVELOPER_DELTA_DAYS
    const out = buildPerDeveloperSeries([...days(n, 0, 0, 1), ...days(n, 500, 10, 1)], WINDOW)
    expect(out.deltas!.totalSpendUsd.prior).toBe(0)
    expect(out.deltas!.totalSpendUsd.deltaPct).toBeNull()
    expect(out.deltas!.activeDevelopers.deltaPct).toBeNull()
    expect(out.deltas!.perDeveloperUsd.deltaPct).toBeNull()
    // The operands are still published, so the card can render "0 → 500" without
    // asserting a percentage that does not exist.
    expect(out.deltas!.totalSpendUsd.recent).toBe(500 * n)
  })

  it('separates HEADCOUNT from BEHAVIOUR — flat per-head under a spend rise', () => {
    const n = PER_DEVELOPER_DELTA_DAYS
    // Spend doubles; so does headcount. The card's whole reason to exist: the
    // total-spend delta alone would read as a problem, and it is not one.
    const out = buildPerDeveloperSeries([...days(n, 100, 10, 1), ...days(n, 200, 20, 1)], WINDOW)
    expect(out.deltas!.totalSpendUsd.deltaPct).toBeCloseTo(1, 9)
    expect(out.deltas!.activeDevelopers.deltaPct).toBeCloseTo(1, 9)
    expect(out.deltas!.perDeveloperUsd.deltaPct).toBeCloseTo(0, 9)
  })
})
