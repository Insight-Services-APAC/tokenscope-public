/*
 * chart-utils — the reporting chart kit's pure helpers. Focus: isoWeekLabel, the
 * ISO-week → Monday-date relabel shared by both seasonality heatmaps (review F9/L6).
 * The date math is non-trivial (ISO week 1 = the week containing Jan 4) and the
 * label must be year-unambiguous (a bare "W27" collides across years).
 */
import { describe, it, expect } from 'vitest'
import {
  isoWeekLabel,
  shortDay,
  categoryUnion,
  trailingMean,
  trailingRatioMean,
} from '../../../app/components/reporting/charts/chart-utils'

describe('isoWeekLabel', () => {
  it('relabels an ISO week to its Monday date (UTC, en-US MMM DD)', () => {
    // ISO week 1 of 2026 contains Jan 4 2026 (a Sunday) → its Monday is 2025-12-29.
    expect(isoWeekLabel('2026-W01')).toBe('Dec 29')
  })

  it('returns a MMM DD shape for any valid ISO week', () => {
    expect(isoWeekLabel('2026-W27')).toMatch(/^[A-Z][a-z]{2} \d{2}$/)
    expect(isoWeekLabel('2026-W52')).toMatch(/^[A-Z][a-z]{2} \d{2}$/)
  })

  it('is year-unambiguous — the same week number in different years maps to different Mondays', () => {
    expect(isoWeekLabel('2025-W27')).not.toBe(isoWeekLabel('2026-W27'))
  })

  it('passes non-ISO-week input through unchanged (defensive)', () => {
    expect(isoWeekLabel('not-a-week')).toBe('not-a-week')
    expect(isoWeekLabel('2026-07')).toBe('2026-07')
    expect(isoWeekLabel('')).toBe('')
  })
})

describe('shortDay + categoryUnion (sanity)', () => {
  it('shortDay trims YYYY- from an ISO day, leaves other strings alone', () => {
    expect(shortDay('2026-07-03')).toBe('07-03')
    expect(shortDay('W27')).toBe('W27')
  })

  it('categoryUnion returns the sorted union of x-values', () => {
    expect(categoryUnion([[{ x: '2026-07-02' }, { x: '2026-07-01' }], [{ x: '2026-07-03' }, { x: '2026-07-01' }]])).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
    ])
  })
})

/*
 * ── The 7-day trailing mean (prototype fix 5) ────────────────────────────────
 *
 * Daily spend and daily headcount are working-week signals: the raw line is a
 * sawtooth and the eye reads the weekend dips rather than the direction. Seven
 * days is exactly one week, so the mean CANCELS the cycle instead of blurring it
 * — which is the property these tests exist to hold, because a 5- or 10-day
 * window would still carry part of the cycle through and nothing on screen would
 * say so.
 */
describe('trailingMean', () => {
  it('holds back until a FULL window sits behind the point', () => {
    /*
     * A mean drawn from four points is inventing a trend out of fewer
     * observations than the label ("7-day mean") claims, and the start of every
     * series is exactly where a spurious ramp would appear.
     */
    const out = trailingMean([1, 2, 3, 4, 5, 6, 7, 8], 7)
    expect(out.slice(0, 6)).toEqual([null, null, null, null, null, null])
    expect(out[6]).toBeCloseTo(4, 10) // mean of 1..7
    expect(out[7]).toBeCloseTo(5, 10) // mean of 2..8
  })

  it('CANCELS a weekly cycle rather than smoothing it — the whole point of seven', () => {
    // Five working days at 100, two weekend days at 0, repeated. Every 7-day
    // mean is the same number, so the line is flat: the cycle is gone, not damped.
    const week = [100, 100, 100, 100, 100, 0, 0]
    const out = trailingMean([...week, ...week, ...week], 7)
    const drawn = out.filter((v): v is number => v !== null)
    expect(drawn).toHaveLength(15)
    for (const v of drawn) expect(v).toBeCloseTo(500 / 7, 10)
  })

  it('a five-day window does NOT cancel it — proving seven is load-bearing', () => {
    const week = [100, 100, 100, 100, 100, 0, 0]
    const five = trailingMean([...week, ...week, ...week], 5).filter((v): v is number => v !== null)
    expect(Math.max(...five)).toBeGreaterThan(Math.min(...five))
  })

  it('yields null for any window containing a hole, never a partial-window mean', () => {
    // This is what stops the mean running into a PROJECTED tail: the chart nulls
    // the forecast days before handing the array over, so the bold line stops at
    // the boundary instead of averaging a run-rate.
    const out = trailingMean([1, 2, 3, 4, 5, 6, 7, null, 9, 10, 11, 12, 13, 14], 7)
    expect(out[6]).toBeCloseTo(4, 10)
    expect(out.slice(7, 14)).toEqual([null, null, null, null, null, null, null])
  })

  it('returns all nulls for a nonsense window rather than throwing', () => {
    // A chart may not fail to render over a bad prop.
    expect(trailingMean([1, 2, 3], 0)).toEqual([null, null, null])
  })
})

describe('trailingRatioMean', () => {
  it('is Σnumerator ÷ Σdenominator, not the mean of the daily ratios', () => {
    /*
     * The two differ whenever the denominator moves, and the difference is not
     * academic: the ratio of sums weights each day by how much activity it had,
     * which is the same basis the card's own deltas use (Σ spend ÷ Σ daily
     * actives, shared/reports/per-developer.ts). Two figures on one card computed
     * two ways is the defect this project calls "one number, one home".
     */
    const devs = [1, 1, 1, 1, 1, 1, 9]
    expect(trailingRatioMean([100, 100, 100, 100, 100, 100, 900], devs, 7)[6]).toBeCloseTo(
      1500 / 15,
      10,
    )
    // A mean of the DAILY RATIOS over this second series would be 128.57…; the
    // ratio of sums is 160, because the heavy day carries nine of the fifteen
    // developers behind it.
    expect(trailingRatioMean([100, 100, 100, 100, 100, 100, 1800], devs, 7)[6]).toBeCloseTo(
      2400 / 15,
      10,
    )
  })

  it('keeps the window seven CALENDAR days across a day with no denominator', () => {
    /*
     * The reason this exists at all. Spend per active developer holds no value on
     * a day nobody worked, so the daily series has genuine holes. Averaging the
     * daily ratios would have to drop those days — making a "7-day" window span
     * more than seven days — or treat them as zero, which is the claimed-zero the
     * series deliberately refuses.
     */
    const out = trailingRatioMean([50, 0, 50, 50, 50, 50, 50], [1, 0, 1, 1, 1, 1, 1], 7)
    expect(out[6]).toBeCloseTo(300 / 6, 10) // the empty day changes neither sum
  })

  it('yields null for a week with no denominator at all, never 0', () => {
    // A week with nobody active has no per-head figure, and 0 would assert one.
    expect(trailingRatioMean([0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], 7)[6]).toBeNull()
  })

  it('holds back until a full window sits behind the point', () => {
    expect(trailingRatioMean([1, 1, 1], [1, 1, 1], 7)).toEqual([null, null, null])
  })
})
