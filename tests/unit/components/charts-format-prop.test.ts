// @vitest-environment happy-dom
/*
 * Additive `format` prop on ChartsStackedBars / ChartsTrendArea. The contract:
 * WITHOUT `format` the original `$X.XX` output is byte-identical (no existing
 * call site changes); WITH `format` the `$`-hardwire is retired.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ChartsStackedBars from '../../../app/components/charts/StackedBars.vue'
import ChartsTrendArea from '../../../app/components/charts/TrendArea.vue'

/*
 * MIGRATED (clock-rot-audit.md §F-a). This was the only `StackedBars` tooltip
 * test and it seeded its rows on `new Date()` so they would land inside the
 * component's browser-anchored dense axis — a clock-derived fixture certifying a
 * clock-derived axis, and it failed SILENTLY ("no <title> found") rather than as
 * a date mismatch. Both charts now take an explicit `endDay`, so the fixture is
 * a fixed day and the test can no longer pass or fail for calendar reasons.
 */
const today = '2026-08-04'

describe('ChartsStackedBars format prop', () => {
  it('defaults to the original $X.XX tooltip (unchanged)', () => {
    const w = mount(ChartsStackedBars, {
      props: { rows: [{ day: today, key: 'opus', value: 12.34 }], windowDays: 7, endDay: today },
    })
    expect(w.find('title').text()).toContain('— $12.34')
  })

  it('uses a custom formatter when provided', () => {
    const w = mount(ChartsStackedBars, {
      props: {
        rows: [{ day: today, key: 'opus', value: 12.34 }],
        windowDays: 7,
        endDay: today,
        format: (v: number) => `${v.toFixed(0)} cr`,
      },
    })
    const t = w.find('title').text()
    expect(t).toContain('12 cr')
    expect(t).not.toContain('$12.34')
  })
})

describe('ChartsTrendArea format prop', () => {
  it('defaults to the original $-prefixed output (axis + tooltip unchanged)', () => {
    const w = mount(ChartsTrendArea, {
      props: { series: [{ day: today, cost_usd: '12.34' }], windowDays: 7, endDay: today },
    })
    expect(w.find('title').text()).toBe(`${today} — $12.34`)
    // Axis ticks keep the `$` prefix by default.
    expect(w.findAll('text').some((t) => t.text().includes('$'))).toBe(true)
  })

  it('uses a custom formatter when provided', () => {
    const w = mount(ChartsTrendArea, {
      props: {
        series: [{ day: today, cost_usd: '12.34' }],
        windowDays: 7,
        endDay: today,
        format: (v: number) => `${v.toFixed(0)} cr`,
      },
    })
    expect(w.find('title').text()).toBe(`${today} — 12 cr`)
  })
})
