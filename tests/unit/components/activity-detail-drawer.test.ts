// @vitest-environment happy-dom
/*
 * ActivityDetailDrawer — the tag/activity drill-down over
 * GET /api/v1/me/activity/{activity}. Contract: opening fetches the endpoint
 * and renders the totals + model mix + session list; a session row hands off
 * via `open-session`; closed = nothing rendered + no fetch; error surfaces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ActivityDetailDrawer from '../../../app/components/activity/DetailDrawer.vue'
import type { ActivityDetail } from '../../../shared/schemas/usage'

const DETAIL: ActivityDetail = {
  activity: 'research',
  window_days: 30,
  total_cost_usd: '0.55',
  total_tokens: 160_000,
  session_count: 2,
  by_model: [
    { model: 'claude-fable-5', tokens: 110_000, cost_usd: '0.45' },
    { model: 'claude-haiku-4-5', tokens: 50_000, cost_usd: '0.10' },
  ],
  by_token_type: [
    { token_type: 'input', tokens: 150_000, cost_usd: '0.40' },
    { token_type: 'output', tokens: 10_000, cost_usd: '0.15' },
  ],
  cache: { read_tokens: 0, write_tokens: 0, input_tokens: 150_000, hit_ratio: null, savings_usd: null },
  fidelity: { tier1_cost_usd: '0.55', tier2_cost_usd: '0.00' },
  sessions: [
    { session_id: 'conv-r1', project_code: 'ACME-1', project_display_name: 'Acme', cost_usd: '0.45', tokens: 110_000, ts_last: '2026-07-18T09:00:00.000Z' },
    { session_id: 'conv-r2', project_code: null, project_display_name: null, cost_usd: '0.10', tokens: 50_000, ts_last: '2026-07-18T08:00:00.000Z' },
  ],
}

const global = {
  stubs: {
    UiEyebrow: { template: '<div><slot /></div>' },
    UiButton: { template: '<button v-bind="$attrs"><slot /></button>' },
    UiPeriodSwitch: { props: ['modelValue', 'options'], template: '<div data-testid="stub-period" />' },
    ChartsDonutChart: { props: ['slices'], template: '<div data-testid="stub-donut" />' },
  },
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('ActivityDetailDrawer', () => {
  it('renders nothing and never fetches when closed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = mount(ActivityDetailDrawer, { props: { activity: null }, global })
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-detail-drawer"]').exists()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches and renders the activity breakdown + session list on open', async () => {
    const fetchMock = vi.fn().mockResolvedValue(DETAIL)
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = mount(ActivityDetailDrawer, { props: { activity: 'research' }, global })
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/me/activity/research', { query: { window: '30' } })
    expect(wrapper.find('[data-testid="activity-detail-summary"]').text()).toContain('$0.55')
    expect(wrapper.find('[data-testid="activity-detail-sessions"]').text()).toContain('conv-r1')
    expect(wrapper.find('[data-testid="activity-detail-lanes"]').exists()).toBe(true)
  })

  it('emits open-session when a session row is clicked', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(DETAIL))
    const wrapper = mount(ActivityDetailDrawer, { props: { activity: 'research' }, global })
    await flushPromises()
    await wrapper.find('[data-testid="activity-session-conv-r1"]').trigger('click')
    expect(wrapper.emitted('open-session')?.[0]).toEqual(['conv-r1'])
  })

  it('surfaces a fetch error inline', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ data: { detail: 'boom' } }))
    const wrapper = mount(ActivityDetailDrawer, { props: { activity: 'research' }, global })
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-detail-error"]').exists()).toBe(true)
  })
})
