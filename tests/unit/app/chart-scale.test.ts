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
  /*
   * MIGRATED, not deleted (clock-rot-audit.md §F-a). This was the ONLY test of
   * `padDays`, and it asserted the run ended at `new Date()` — i.e. it certified
   * the very defect F1 removes: a dense run anchored on the BROWSER's today,
   * zero-filling a day the server refuses to claim. It now pins the injected
   * edge, which is what the function actually takes.
   */
  const END = '2026-08-04' // a settled edge, fixed: nothing here expires

  it('produces a dense ordered run ending at the INJECTED edge, zero-filling gaps', () => {
    const out = padDays([{ day: END, v: 5 }], 7, END, (day) => ({ day, v: 0 }))
    expect(out).toHaveLength(7)
    expect(out[6]!.day).toBe(END)
    expect(out[6]!.v).toBe(5)
    expect(out[0]!.day).toBe('2026-07-29')
    expect(out[0]!.v).toBe(0)
    expect([...out].map((d) => d.day)).toEqual([...out].map((d) => d.day).sort())
  })

  it('never pads BEYOND the edge — a day the caller did not claim is absent', () => {
    // The morning dip in one assertion: the day after the settled edge is not
    // in the run, so it cannot be drawn as a zero.
    const out = padDays([{ day: END, v: 5 }], 7, END, (day) => ({ day, v: 0 }))
    expect(out.some((d) => d.day > END)).toBe(false)
  })

  it('reads the edge from its ARGUMENT, not from the clock', () => {
    const out = padDays([], 3, '2019-03-04', (day) => ({ day, v: 0 }))
    expect(out.map((d) => d.day)).toEqual(['2019-03-02', '2019-03-03', '2019-03-04'])
  })
})

describe('seriesColor', () => {
  it('cycles the palette deterministically', () => {
    expect(seriesColor(0)).toBe(seriesColor(6)) // palette length 6
    expect(seriesColor(1)).not.toBe(seriesColor(2))
  })
})
