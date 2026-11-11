// @vitest-environment happy-dom
/*
 * #584: the daily spend charts offer their numbers as a table.
 *
 * The table must list the SAME days as the chart (the settled run, then the
 * still-filling day when the chart admitted it), carry the same totals, label
 * the partial day in words, print days as the UTC dates they are, and the switch
 * must be real buttons with aria-pressed. Without `offerTable` nothing changes.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ChartsStackedBars from '../../../app/components/charts/StackedBars.vue'
import ChartsTrendArea from '../../../app/components/charts/TrendArea.vue'

const END = '2026-11-09'
const TODAY = '2026-11-10'

const stackedRows = [
  { day: '2026-11-07', key: 'opus', value: 2 },
  { day: '2026-11-07', key: 'sonnet', value: 1.5 },
  { day: '2026-11-09', key: 'opus', value: 4 },
  { day: TODAY, key: 'sonnet', value: 0.25 },
  // A key that never has a positive value in the window is not a column.
  { day: '2026-11-08', key: 'haiku', value: 0 },
]

async function showTable(w: ReturnType<typeof mount>) {
  await w.get('[data-testid="chart-view-table"]').trigger('click')
}
function rowDays(w: ReturnType<typeof mount>) {
  return w.findAll('[data-testid^="chart-day-row-"]').map((r) => r.attributes('data-testid')!.replace('chart-day-row-', ''))
}

describe('ChartsStackedBars: Chart / Table (#584)', () => {
  it('no switch unless offered', () => {
    const w = mount(ChartsStackedBars, { props: { rows: stackedRows, windowDays: 3, endDay: END, partialDay: TODAY } })
    expect(w.find('[data-testid="chart-view-switch"]').exists()).toBe(false)
  })

  it('the switch is two buttons with aria-pressed, Chart first', async () => {
    const w = mount(ChartsStackedBars, {
      props: { rows: stackedRows, windowDays: 3, endDay: END, partialDay: TODAY, offerTable: true },
    })
    const chart = w.get('[data-testid="chart-view-chart"]')
    const table = w.get('[data-testid="chart-view-table"]')
    expect(chart.element.tagName).toBe('BUTTON')
    expect(chart.attributes('aria-pressed')).toBe('true')
    expect(table.attributes('aria-pressed')).toBe('false')
    expect(w.find('svg').exists()).toBe(true)
    await showTable(w)
    expect(w.get('[data-testid="chart-view-table"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('svg').exists()).toBe(false)
    expect(w.find('[data-testid="chart-day-table"]').exists()).toBe(true)
  })

  it('lists the chart axis days in UTC, the partial day last and labelled in words', async () => {
    const w = mount(ChartsStackedBars, {
      props: { rows: stackedRows, windowDays: 3, endDay: END, partialDay: TODAY, offerTable: true },
    })
    await showTable(w)
    expect(rowDays(w)).toEqual(['2026-11-07', '2026-11-08', '2026-11-09', TODAY])
    const partial = w.get(`[data-testid="chart-day-row-${TODAY}"]`)
    expect(partial.text()).toContain('still filling')
    expect(w.findAll('[data-testid="chart-day-partial"]')).toHaveLength(1)
  })

  it('one column per band with a value, and each day total matches the bar', async () => {
    const w = mount(ChartsStackedBars, {
      props: { rows: stackedRows, windowDays: 3, endDay: END, partialDay: TODAY, offerTable: true },
    })
    await showTable(w)
    const heads = w.findAll('thead th').map((h) => h.text())
    expect(heads).toEqual(['Day (UTC)', 'opus', 'sonnet', 'Total'])
    expect(w.findAll('thead th').every((h) => h.attributes('scope') === 'col')).toBe(true)
    const cells = (day: string) => w.get(`[data-testid="chart-day-row-${day}"]`).findAll('td').map((c) => c.text())
    expect(cells('2026-11-07')).toEqual(['$2.00', '$1.50', '$3.50'])
    // A settled day with no rows is a measured zero, as on the chart.
    expect(cells('2026-11-08')).toEqual(['$0.00', '$0.00', '$0.00'])
    expect(cells(TODAY)).toEqual(['$0.00', '$0.25', '$0.25'])
  })

  it('does not list a still-filling day the chart did not admit', async () => {
    const w = mount(ChartsStackedBars, {
      props: { rows: stackedRows.filter((r) => r.day !== TODAY), windowDays: 3, endDay: END, partialDay: TODAY, offerTable: true },
    })
    await showTable(w)
    expect(rowDays(w)).toEqual(['2026-11-07', '2026-11-08', '2026-11-09'])
    expect(w.find('[data-testid="chart-day-partial"]').exists()).toBe(false)
  })
})

describe('ChartsTrendArea: Chart / Table (#584)', () => {
  const series = [
    { day: '2026-11-08', cost_usd: '3.10' },
    { day: END, cost_usd: '1.00' },
    { day: TODAY, cost_usd: '0.40' },
  ]

  it('lists the settled run then the partial day, one Spend column, same values', async () => {
    const w = mount(ChartsTrendArea, {
      props: { series, windowDays: 3, endDay: END, partialDay: TODAY, offerTable: true },
    })
    expect(w.get('[data-testid="chart-view-chart"]').attributes('aria-pressed')).toBe('true')
    await showTable(w)
    expect(w.find('svg').exists()).toBe(false)
    expect(w.findAll('thead th').map((h) => h.text())).toEqual(['Day (UTC)', 'Spend'])
    expect(rowDays(w)).toEqual(['2026-11-07', '2026-11-08', END, TODAY])
    const cell = (day: string) => w.get(`[data-testid="chart-day-row-${day}"]`).get('td').text()
    expect(cell('2026-11-07')).toBe('$0.00')
    expect(cell('2026-11-08')).toBe('$3.10')
    expect(cell(TODAY)).toBe('$0.40')
    expect(w.get(`[data-testid="chart-day-row-${TODAY}"]`).text()).toContain('still filling')
  })

  it('back to Chart redraws the chart', async () => {
    const w = mount(ChartsTrendArea, {
      props: { series, windowDays: 3, endDay: END, partialDay: TODAY, offerTable: true },
    })
    await showTable(w)
    await w.get('[data-testid="chart-view-chart"]').trigger('click')
    expect(w.find('svg').exists()).toBe(true)
    expect(w.find('[data-testid="chart-day-table"]').exists()).toBe(false)
  })

  it('an empty window shows the empty sentence and no switch', () => {
    const w = mount(ChartsTrendArea, { props: { series: [], windowDays: 3, endDay: END, offerTable: true } })
    expect(w.find('[data-testid="chart-view-switch"]').exists()).toBe(false)
    expect(w.find('[data-testid="trend-area-empty"]').exists()).toBe(true)
  })
})
