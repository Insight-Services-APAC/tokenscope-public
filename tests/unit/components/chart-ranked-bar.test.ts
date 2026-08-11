// @vitest-environment happy-dom
/*
 * ChartRankedBar — optional STACKED SEGMENT mode (requirement 3: "stacked
 * teammate bars ... in the shared DriversTable/ChartRankedBar path where
 * feasible, with accessible legend/tooltips"). Pins:
 *  - single-hue mode is UNCHANGED when no row carries `segments` (backward
 *    compatible with every existing caller — ONE bar series, magnitude hue);
 *  - stacked mode activates when ANY row carries `segments`: one ECharts
 *    series PER registry lane, `stack: 'total'`, so the bars visually compose;
 *  - the aria-label names the stacked mode explicitly (accessible — ECharts'
 *    canvas has no inspectable text; the DriversTable's data table plus this
 *    label are the accessible channels, never colour-alone);
 *  - a row WITHOUT segments in an otherwise-segmented chart still renders (the
 *    topN-folded "Other" row) as ONE magnitude-hue segment — never a silent gap.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ChartRankedBar from '../../../app/components/reporting/charts/ChartRankedBar.client.vue'

// A minimal VChart stub that declares `option` as a real prop (rather than
// letting it fall through as a stringified DOM attribute), so the test can
// inspect the ACTUAL built ECharts option object VTU-side.
const VChartStub = {
  name: 'VChart',
  props: ['option'],
  template: '<div />',
}

function mountChart(props: Record<string, unknown>) {
  return mount(ChartRankedBar, {
    props,
    global: { stubs: { VChart: VChartStub, ClientOnly: { template: '<div><slot /></div>' } } },
  })
}

function optionOf(wrapper: ReturnType<typeof mountChart>): {
  series: Array<{ type: string; stack?: string; name?: string; data: number[] }>
} {
  return wrapper.findComponent(VChartStub).props('option') as never
}

describe('ChartRankedBar', () => {
  it('single-hue mode (no segments): ONE bar series, magnitude hue, unchanged aria-label', async () => {
    const w = mountChart({ rows: [{ label: 'Ada', value: 60 }, { label: 'Grace', value: 40 }] })
    await w.vm.$nextTick()
    const chart = w.find('[data-testid="chart-ranked-bar"]')
    expect(chart.exists()).toBe(true)
    expect(chart.attributes('aria-label')).toBe('Ranked bars — 2 rows, top: Ada')
    const option = optionOf(w)
    expect(option.series).toHaveLength(1)
    expect(option.series[0]!.data).toEqual([60, 40])
  })

  it('stacked mode: one series PER lane, stack: "total"; aria-label names it', async () => {
    const w = mountChart({
      rows: [
        {
          label: 'Ada',
          value: 60,
          segments: [
            { key: 'claude', label: 'Claude Code', value: 40, color: '#111' },
            { key: 'copilot', label: 'Copilot', value: 20, color: '#222' },
          ],
        },
        { label: 'Grace', value: 40 }, // no segments — must still render (topN-fold shape)
      ],
    })
    await w.vm.$nextTick()
    const chart = w.find('[data-testid="chart-ranked-bar"]')
    expect(chart.exists()).toBe(true)
    expect(chart.attributes('aria-label')).toBe('Ranked bars, stacked by surface — 2 rows, top: Ada')
    const option = optionOf(w)
    // 3 series: 'claude', 'copilot' (Ada's real segments) + '__unsegmented' (Grace's fallback).
    expect(option.series).toHaveLength(3)
    for (const s of option.series) expect(s.stack).toBe('total')
    const claudeSeries = option.series.find((s) => s.name === 'Claude Code')!
    expect(claudeSeries.data).toEqual([40, 0]) // Ada 40, Grace 0 (no claude segment)
    const copilotSeries = option.series.find((s) => s.name === 'Copilot')!
    expect(copilotSeries.data).toEqual([20, 0])
    // Grace's fallback series carries her FULL value as one magnitude-hue segment.
    const graceFallback = option.series.find((s) => s.name === 'Grace')!
    expect(graceFallback.data).toEqual([0, 40])
    expect(w.find('[data-testid="chart-ranked-bar-empty"]').exists()).toBe(false)
  })

  it('empty state renders when every row is zero', () => {
    const w = mountChart({ rows: [{ label: 'Ada', value: 0 }] })
    expect(w.find('[data-testid="chart-ranked-bar-empty"]').exists()).toBe(true)
  })
})
