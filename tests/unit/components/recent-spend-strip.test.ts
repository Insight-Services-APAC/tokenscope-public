// @vitest-environment happy-dom
/*
 * RecentSpendStrip — the My-usage rolling-window "recent spend" snapshot.
 *
 * Contract under test: renders the windowed totals + intensity from the
 * /me/home/recent payload, lists top models, and shows the empty-state line
 * when there is no spend. (The window→refetch wiring is useFetch's reactive
 * query — framework behaviour, exercised by the endpoint integration test.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref, defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import RecentSpendStrip from '../../../app/components/home/RecentSpendStrip.vue'
import type { RecentUsage } from '../../../shared/schemas/usage'
import { stubServerClock } from '../../helpers/server-clock'

const SPENT: RecentUsage = {
  window_days: 30,
  total_cost_usd: '42.50',
  total_tokens: 1_250_000,
  active_days: 5,
  cost_per_active_day: '8.50',
  series: [
    { day: '2026-07-10', cost_usd: '10.00', tokens: 300_000 },
    { day: '2026-07-14', cost_usd: '32.50', tokens: 950_000 },
  ],
  by_model: [
    { model: 'claude-opus-4', tokens: 900_000, cost_usd: '35.00' },
    { model: 'claude-sonnet-4', tokens: 350_000, cost_usd: '7.50' },
  ],
}
const EMPTY: RecentUsage = {
  window_days: 30,
  total_cost_usd: '0.00',
  total_tokens: 0,
  active_days: 0,
  cost_per_active_day: null,
  series: [],
  by_model: [],
}

const STUBS = {
  UiCard: { template: '<div><slot /></div>' },
  UiEyebrow: { template: '<div><slot /></div>' },
  UiFetchErrorBanner: true,
  UiPeriodSwitch: { props: ['modelValue', 'options'], template: '<div data-testid="stub-period" />' },
  ChartsTrendArea: {
    props: ['series', 'windowDays', 'endDay', 'partialDay'],
    template: '<div data-testid="stub-trend" :data-end-day="endDay" :data-partial-day="partialDay" />',
  },
}

async function mountStrip(data: RecentUsage) {
  // The chart's axis edge is the SERVER's settled day (F1/D3), so the clock is
  // stubbed rather than read.
  stubServerClock('2026-08-15T12:00:00Z')
  vi.stubGlobal('useFetch', () => ({
    data: ref(data),
    refresh: vi.fn(),
    pending: ref(false),
    error: ref(null),
  }))
  const Parent = defineComponent({
    components: { RecentSpendStrip },
    template: '<Suspense><RecentSpendStrip /></Suspense>',
  })
  const w = mount(Parent, { global: { stubs: STUBS } })
  await flushPromises()
  return w
}

afterEach(() => vi.unstubAllGlobals())

describe('RecentSpendStrip', () => {
  it('renders windowed totals, intensity and top models', async () => {
    const w = await mountStrip(SPENT)
    const stats = w.find('[data-testid="recent-spend-stats"]')
    expect(stats.text()).toContain('$42.50')
    expect(stats.text()).toContain('5') // active days
    expect(stats.text()).toContain('$8.50') // per active day
    const models = w.find('[data-testid="recent-spend-models"]')
    expect(models.exists()).toBe(true)
    expect(models.text()).toContain('$35.00')
    expect(w.find('[data-testid="recent-spend-empty"]').exists()).toBe(false)
  })

  it('shows the empty-state line and a dash intensity when there is no spend', async () => {
    const w = await mountStrip(EMPTY)
    expect(w.find('[data-testid="recent-spend-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="recent-spend-stats"]').text()).toContain('—')
    expect(w.find('[data-testid="recent-spend-models"]').exists()).toBe(false)
  })
})

describe('the trend axis edge is the SERVER\'s settled day (F1/D3)', () => {
  it('the chart runs to settledThrough, with today carried as the partial marker', async () => {
    const w = await mountStrip(SPENT)
    const chart = w.find('[data-testid="stub-trend"]')
    expect(chart.attributes('data-end-day')).toBe('2026-08-14')
    expect(chart.attributes('data-partial-day')).toBe('2026-08-15')
    // The two are different quantities; collapsing them is the morning dip.
    expect(chart.attributes('data-end-day')).not.toBe(chart.attributes('data-partial-day'))
  })
})
