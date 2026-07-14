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

// padDays anchors the dense run on "today" (UTC); seed that day so a bar/point
// with a known value renders.
const today = new Date().toISOString().slice(0, 10)

describe('ChartsStackedBars format prop', () => {
  it('defaults to the original $X.XX tooltip (unchanged)', () => {
    const w = mount(ChartsStackedBars, {
      props: { rows: [{ day: today, key: 'opus', value: 12.34 }], windowDays: 7 },
    })
    expect(w.find('title').text()).toContain('— $12.34')
  })

  it('uses a custom formatter when provided', () => {
    const w = mount(ChartsStackedBars, {
      props: {
        rows: [{ day: today, key: 'opus', value: 12.34 }],
        windowDays: 7,
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
      props: { series: [{ day: today, cost_usd: '12.34' }], windowDays: 7 },
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
        format: (v: number) => `${v.toFixed(0)} cr`,
      },
    })
    expect(w.find('title').text()).toBe(`${today} — 12 cr`)
  })
})
