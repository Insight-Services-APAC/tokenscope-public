// @vitest-environment node
/*
 * Chart scale helpers — axis math + day padding for the SVG primitives.
 */
import { describe, it, expect } from 'vitest'
import { niceMax, padDays, seriesColor } from '../../../app/composables/useChartScale'

describe('niceMax', () => {
  it('snaps to 1/2/5 × 10ⁿ at or above the max', () => {
    expect(niceMax(0.7)).toBe(1)
    expect(niceMax(1.2)).toBe(2)
    expect(niceMax(3.4)).toBe(5)
    expect(niceMax(7)).toBe(10)
    expect(niceMax(42)).toBe(50)
    expect(niceMax(100)).toBe(100)
  })
  it('degenerate inputs → 1 (never a zero-height axis)', () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(-5)).toBe(1)
    expect(niceMax(Number.NaN)).toBe(1)
  })
})

describe('padDays', () => {
  it('produces a dense ordered run ending today (UTC), zero-filling gaps', () => {
    const today = new Date().toISOString().slice(0, 10)
    const out = padDays([{ day: today, v: 5 }], 7, (day) => ({ day, v: 0 }))
    expect(out).toHaveLength(7)
    expect(out[6]!.day).toBe(today)
    expect(out[6]!.v).toBe(5)
    expect(out[0]!.v).toBe(0)
    expect([...out].map((d) => d.day)).toEqual([...out].map((d) => d.day).sort())
  })
})

describe('seriesColor', () => {
  it('cycles the palette deterministically', () => {
    expect(seriesColor(0)).toBe(seriesColor(6)) // palette length 6
    expect(seriesColor(1)).not.toBe(seriesColor(2))
  })
})
