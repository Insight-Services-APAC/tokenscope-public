// @vitest-environment happy-dom
/*
 * ChartTrend — the faint daily line under a bold trailing mean (prototype fix 5).
 *
 * WHAT THESE ARE FOR. The mean is the whole point of the fix and it is invisible
 * to every other kind of test: `trailingMeanDays` is a prop, and a prop that is
 * quietly ignored renders a chart that looks exactly like the one before the fix
 * while three cards print a key line reading "bold = 7-day mean". That is the
 * claims-not-honoured defect in its purest form, so these assert the SERIES
 * ECharts is actually handed rather than the presence of the prop.
 *
 * They read the `option` the component passes to <VChart>, which is the only
 * place the two strokes exist — ECharts itself never runs under happy-dom.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ChartTrend from '../../../app/components/reporting/charts/ChartTrend.client.vue'

interface EchSeries {
  name?: string
  data?: Array<number | null>
  lineStyle?: { width?: number; opacity?: number; type?: string }
  connectNulls?: boolean
}

const VChartStub = {
  name: 'VChart',
  props: ['option'],
  template: '<div data-testid="vchart" />',
}

const global = {
  stubs: {
    ClientOnly: { template: '<div><slot /></div>' },
    VChart: VChartStub,
  },
}

/** 14 days of a working-week sawtooth: 100 on weekdays, 0 at the weekend. */
const days = Array.from({ length: 14 }, (_, i) => {
  const d = String(i + 1).padStart(2, '0')
  return { x: `2026-07-${d}`, y: i % 7 < 5 ? 100 : 0 }
})

function mountTrend(props: Record<string, unknown>) {
  return mount(ChartTrend, { props, global })
}

function optionOf(props: Record<string, unknown>): { series: EchSeries[] } {
  return mountTrend(props).findComponent(VChartStub).props('option') as { series: EchSeries[] }
}

const SERIES = [{ name: 'Claude Code', key: 'claude-code', data: days }]

describe('ChartTrend trailing mean', () => {
  it('draws NOTHING extra, and keeps the daily line at full weight, when off', () => {
    // The default must be byte-identical to the pre-fix chart: every other caller
    // of this kit (the chargeback trend, the tier-exposure areas) passes no mean.
    const { series } = optionOf({ series: SERIES })
    expect(series).toHaveLength(1)
    expect(series[0]!.lineStyle?.width).toBe(2)
    expect(series[0]!.lineStyle?.opacity).toBeUndefined()
  })

  it('adds a bold mean line and DEMOTES the daily one to a faint hairline', () => {
    /*
     * Both halves matter. Adding a bold line without demoting the daily one gives
     * two equally-weighted strokes and the eye still reads the sawtooth — the
     * defect would survive the fix.
     */
    const { series } = optionOf({ series: SERIES, trailingMeanDays: 7 })
    expect(series).toHaveLength(2)
    const [daily, mean] = series
    expect(daily!.lineStyle?.width).toBe(1)
    expect(daily!.lineStyle!.opacity!).toBeLessThan(0.5)
    expect(mean!.lineStyle!.width!).toBeGreaterThan(daily!.lineStyle!.width!)
    // Seven days of nulls, then the flat weekly mean — the cycle cancelled.
    expect(mean!.data!.slice(0, 6)).toEqual([null, null, null, null, null, null])
    expect(mean!.data![6]).toBeCloseTo(500 / 7, 10)
    expect(mean!.data![13]).toBeCloseTo(500 / 7, 10)
  })

  it('names the mean the SAME as its series, so neither legend nor tooltip doubles', () => {
    /*
     * A second legend entry per provider would say the chart has six series when
     * it has three, and a second tooltip row would print the smoothed number
     * beside the day's own. The tooltip dedupes by name and the daily line is
     * pushed FIRST, so the hovered value stays that day's actual.
     */
    const { series } = optionOf({ series: SERIES, trailingMeanDays: 7 })
    expect(series.map((s) => s.name)).toEqual(['Claude Code', 'Claude Code'])
  })

  it('stops the mean at the forecast boundary rather than averaging the projection', () => {
    /*
     * The run-rate tail is drawn dashed BECAUSE it is not a measurement. Feeding
     * it into a mean would launder a projection into the bold line the reader is
     * being told to trust.
     */
    const { series } = optionOf({
      series: SERIES,
      trailingMeanDays: 7,
      forecastFrom: '2026-07-11',
    })
    const mean = series[series.length - 1]!
    // 2026-07-11 is index 10; the last mean that has a full window of ACTUALS
    // behind it is index 9, and everything from the boundary on is null.
    expect(mean.data![9]).not.toBeNull()
    expect(mean.data!.slice(10)).toEqual([null, null, null, null])
  })

  it('is IGNORED in stacked mode, and does not demote the daily line there either', () => {
    /*
     * Stacked areas answer composition. A mean line over a stack belongs to no
     * band in it, so there would be nothing on screen saying which series it was
     * the mean OF — and the card's key line is hidden in that mode for the same
     * reason.
     */
    const { series } = optionOf({ series: SERIES, trailingMeanDays: 7, stacked: true })
    expect(series).toHaveLength(1)
    expect(series[0]!.lineStyle?.width).toBe(2)
  })

  it('leaves a TOO-SHORT window alone entirely — no bold line, no faded daily one', () => {
    /*
     * THE REGRESSION THIS PREVENTS, found by looking at the running app rather
     * than at a test: on the dev estate only a handful of days carry spend, so
     * `trailingMean` correctly returns all nulls — no point has a full week
     * behind it. The first version of this still demoted the daily line to a
     * hairline, which handed that reader a fainter chart and NOTHING in exchange.
     * Both strokes, and the key line naming them, ride on the same decision.
     */
    const short = days.slice(0, 5)
    const w = mountTrend({
      series: [{ name: 'Claude Code', key: 'claude-code', data: short }],
      trailingMeanDays: 7,
    })
    const { series } = w.findComponent(VChartStub).props('option') as { series: EchSeries[] }
    expect(series).toHaveLength(1)
    expect(series[0]!.lineStyle?.width).toBe(2)
    expect(series[0]!.lineStyle?.opacity).toBeUndefined()
    expect(w.find('[data-testid="chart-trend-mean-key"]').exists()).toBe(false)
  })

  it('prints the key for the two strokes ONLY when a mean is on screen', () => {
    /*
     * The key lived on the card until the short-window case above proved a card
     * cannot know. "faint = daily · bold = 7-day mean" over a chart with one
     * full-weight line and no mean is the claims-not-honoured defect written out
     * in the operator's own words.
     */
    const drawn = mountTrend({ series: SERIES, trailingMeanDays: 7 })
    expect(drawn.find('[data-testid="chart-trend-mean-key"]').text()).toContain(
      'bold = 7-day mean',
    )
    const off = mountTrend({ series: SERIES })
    expect(off.find('[data-testid="chart-trend-mean-key"]').exists()).toBe(false)
    const stacked = mountTrend({ series: SERIES, trailingMeanDays: 7, stacked: true })
    expect(stacked.find('[data-testid="chart-trend-mean-key"]').exists()).toBe(false)
  })

  it('prefers a caller-supplied mean over its own, for a ratio series', () => {
    /*
     * Spend per active developer's week average is Σspend ÷ Σactives, which only
     * the card holds both sides of. If the chart silently took the plain mean of
     * the drawn ratios instead, the bold line would disagree with the deltas
     * printed directly under it.
     */
    const supplied = days.map((d) => ({ x: d.x, y: 42 }))
    const { series } = optionOf({
      series: [{ ...SERIES[0]!, mean: supplied }],
      trailingMeanDays: 7,
    })
    const mean = series[series.length - 1]!
    expect(mean.data).toEqual(days.map(() => 42))
    // …and it bridges a day the daily line has no point for, because a week's
    // mean is defined there even when that day is not.
    expect(mean.connectNulls).toBe(true)
  })
})
