// @vitest-environment happy-dom
/*
 * SurfaceHeroCard — "Where the AI spend goes".
 *
 * THE DEFECT THESE PIN. The card used to stack TWO panels of one dataset: the
 * absolute-$ weekly bars, and beneath them the same series again as a 100%-share
 * band. That doubled the card's height and halved the read — the reader met the
 * same weeks twice before reaching the next question. The prototype has ONE
 * panel plus a totals legend bar underneath.
 *
 * So there are two things to hold: the second PANEL is gone, and the composition
 * story it carried did not go with it — it moved into a one-row totals bar that
 * also states each lane's dollars, which the share panel never did.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SurfaceHeroCard from '../../../app/components/reporting/SurfaceHeroCard.vue'
import { buildSurfaceHero } from '../../../app/components/reporting/build-surface-hero'
import type { UsageSurfaceWeeklyCell } from '../../../shared/reports/types'

const FROM = '2026-05-04'
const TO = '2026-06-28'
const TODAY = '2026-06-28'

const cells: UsageSurfaceWeeklyCell[] = [
  { weekStart: '2026-05-04', lane: 'claude', usd: 100 },
  { weekStart: '2026-05-04', lane: 'claude-ai', usd: 40 },
  { weekStart: '2026-05-11', lane: 'claude', usd: 120 },
  { weekStart: '2026-05-11', lane: 'claude-ai', usd: 30 },
  { weekStart: '2026-05-18', lane: 'claude', usd: 90 },
  { weekStart: '2026-06-01', lane: 'copilot', usd: 60 },
]

const built = () => buildSurfaceHero(cells, { from: FROM, to: TO, today: TODAY })

// ChartWeeklyLanes is a .client.vue ECharts wrapper — stub it and record the
// props, because the thing under test is WHICH PANELS the card asks for.
const chartStub = {
  name: 'ChartWeeklyLanes',
  props: ['weeks', 'series', 'shareSeries', 'mode', 'inProgressWeek', 'remainderItems', 'valueFormat'],
  template: '<div data-testid="weekly-lanes-stub" :data-mode="mode" :data-has-share="shareSeries ? \'yes\' : \'no\'" />',
}
const global = { stubs: { ChartWeeklyLanes: chartStub, UiCard: { template: '<div><slot /></div>' } } }

describe('SurfaceHeroCard — one panel, not two', () => {
  it('asks the chart for the $ panel ONLY, and hands it no share series', () => {
    /*
     * `mode="dual"` was the second panel. Asserting the mode (not just "a chart
     * renders") is what makes this catch a regression: the card would still
     * mount and still show bars with the share panel back.
     */
    const w = mount(SurfaceHeroCard, { props: { built: built() }, global })
    const chart = w.find('[data-testid="weekly-lanes-stub"]')
    expect(chart.exists()).toBe(true)
    expect(chart.attributes('data-mode')).toBe('usd')
    expect(chart.attributes('data-has-share')).toBe('no')
  })

  it('carries its OWN totals legend — every lane in the bars, with its dollars', () => {
    /*
     * This legend is why the page-level LaneLegend could be dropped in the usage
     * lens. It has to be at least as informative as the thing it replaced: the
     * same lanes, named (not colour-alone), each with a money figure.
     */
    const w = mount(SurfaceHeroCard, { props: { built: built() }, global })
    const legend = w.find('[data-testid="surface-hero-totals-legend"]')
    expect(legend.exists()).toBe(true)
    expect(w.find('[data-testid="surface-hero-totals-bar"]').exists()).toBe(true)

    // Σ of the rendered lanes IS the window total — the legend is a partition of
    // the bars above it, not a separate measure.
    const b = built()
    expect(b.donut.slices.reduce((a, s) => a + s.value, 0)).toBeCloseTo(b.donut.totalUsd, 6)

    const text = legend.text()
    expect(text).toContain('Claude Code')
    expect(text).toContain('$310.00') // 100 + 120 + 90
    expect(text).toContain('Claude Chat')
    expect(text).toContain('$70.00') // 40 + 30
    expect(text).toContain('$60.00') // copilot
  })

  it('renders no totals bar when there is nothing to compose', () => {
    const empty = buildSurfaceHero([], { from: FROM, to: TO, today: TODAY })
    const w = mount(SurfaceHeroCard, { props: { built: empty }, global })
    expect(w.find('[data-testid="surface-hero-totals-bar"]').exists()).toBe(false)
    expect(w.find('[data-testid="surface-hero-empty"]').exists()).toBe(true)
  })

  /*
   * BOTH TRAILING SENTENCES ARE GONE.
   *
   * "The current week is in progress — rendered lighter and excluded from the
   * ranking and the delta" described the card's OWN ENCODING. A sentence cannot
   * rescue a treatment that does not read, and if it does read the sentence is
   * noise. That is distinct from a LEGEND ("bold = 7-day mean"), which names which
   * series is which — something a reader cannot deduce.
   *
   * "Attributed usage across every surface — the same lane as the KPIs above, over
   * the window named in this band's header" was methodology, and its second half
   * pointed at the band header, which exists so cards stop restating their window.
   *
   * MUTATION: restore either `<p>` — the matching assertion goes red.
   */
  it('renders no trailing caveat and no encoding commentary', () => {
    const w = mount(SurfaceHeroCard, { props: { built: built() }, global })
    expect(w.find('[data-testid="surface-hero-caveat"]').exists()).toBe(false)
    expect(w.find('[data-testid="surface-hero-partial-note"]').exists()).toBe(false)
    const text = w.text()
    expect(text).not.toContain('rendered lighter')
    expect(text).not.toContain("named in this band's header")
    expect(text).not.toContain('the same lane as the KPIs above')
    // The card still states its own basis, once, at the top.
    expect(w.find('[data-testid="surface-hero-basis"]').text()).toContain('attributed usage')
  })
})
