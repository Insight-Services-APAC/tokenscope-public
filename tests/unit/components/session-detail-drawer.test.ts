// @vitest-environment happy-dom
/*
 * SessionDetailDrawer — the developer's "how was THIS conversation's spend
 * attributed" drill-down over GET /api/v1/me/sessions/{sid}.
 *
 * Contract under test (the load-bearing behaviour, not layout):
 *  - closed (sessionId=null) renders nothing and never fetches;
 *  - opening fetches the right endpoint and renders the summary + matrix +
 *    lanes + cache + aux split from the SessionDetail payload;
 *  - the model×lane matrix places each cell's cost and blanks unused lanes;
 *  - a CREDIT-PRICED session (priced_per_lane: false) never renders a per-lane
 *    price — T16 of the fix sprint;
 *  - a fetch error surfaces inline (no crash, no stale content);
 *  - Close emits `close`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SessionDetailDrawer from '../../../app/components/session/DetailDrawer.vue'
import type { SessionDetail } from '../../../shared/schemas/usage'

const DETAIL: SessionDetail = {
  session_id: 'conv-abc-123',
  instance_id: 'inst-1',
  tool: 'claude-code',
  project_id: 'proj-1',
  project_code: 'ACME-1',
  project_display_name: 'Acme Platform',
  activity: 'Research',
  ts_start: '2026-07-18T09:00:00.000Z',
  ts_last: '2026-07-18T09:42:00.000Z',
  record_count: 37,
  span_count: 12,
  tokens: 1_250_000,
  cost_usd: '4.20',
  priced_per_lane: true,
  matrix: [
    { model: 'claude-opus-4', token_type: 'input', tokens: 200_000, cost_usd: '1.50' },
    { model: 'claude-opus-4', token_type: 'output', tokens: 50_000, cost_usd: '1.20' },
    { model: 'claude-opus-4', token_type: 'cache-read', tokens: 900_000, cost_usd: '0.90' },
    { model: 'claude-sonnet-4', token_type: 'input', tokens: 80_000, cost_usd: '0.40' },
    { model: 'claude-sonnet-4', token_type: 'output', tokens: 20_000, cost_usd: '0.20' },
  ],
  by_model: [
    { model: 'claude-opus-4', tokens: 1_150_000, cost_usd: '3.60' },
    { model: 'claude-sonnet-4', tokens: 100_000, cost_usd: '0.60' },
  ],
  by_token_type: [
    { token_type: 'input', tokens: 280_000, cost_usd: '1.90' },
    { token_type: 'output', tokens: 70_000, cost_usd: '1.40' },
    { token_type: 'cache-read', tokens: 900_000, cost_usd: '0.90' },
  ],
  by_query_source: [
    { query_source: 'main', tokens: 1_100_000, cost_usd: '3.80' },
    { query_source: 'aux', tokens: 150_000, cost_usd: '0.40' },
  ],
  cache: { read_tokens: 900_000, write_tokens: 100_000, input_tokens: 280_000, hit_ratio: 0.76, savings_usd: '2.10' },
  fidelity: { tier1_cost_usd: '4.00', tier2_cost_usd: '0.20' },
}

// Auto-imported globals the drawer renders — stubbed to keep the test on the
// drawer's own logic (they have their own tests).
const global = {
  stubs: {
    Icon: true,
    UsageModelBadge: true,
    UiEyebrow: { template: '<div><slot /></div>' },
    UiButton: { template: '<button v-bind="$attrs"><slot /></button>' },
    ChartsDonutChart: { props: ['slices'], template: '<div data-testid="stub-donut" />' },
  },
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('SessionDetailDrawer', () => {
  it('renders nothing and never fetches when closed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = mount(SessionDetailDrawer, { props: { sessionId: null }, global })
    await flushPromises()
    expect(wrapper.find('[data-testid="session-detail-drawer"]').exists()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches the session endpoint and renders the breakdown when opened', async () => {
    const fetchMock = vi.fn().mockResolvedValue(DETAIL)
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = mount(SessionDetailDrawer, { props: { sessionId: 'conv-abc-123' }, global })
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/me/sessions/conv-abc-123')
    expect(wrapper.find('[data-testid="session-detail-summary"]').exists()).toBe(true)
    // Cost + records tiles from the payload.
    expect(wrapper.find('[data-testid="session-detail-summary"]').text()).toContain('$4.20')
    // Context chips: project + activity.
    expect(wrapper.text()).toContain('ACME-1')
    expect(wrapper.text()).toContain('Research')
    // Lanes, matrix, cache, aux all present.
    expect(wrapper.find('[data-testid="session-detail-lanes"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="session-detail-matrix"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="session-detail-cache"]').text()).toContain('$2.10')
    expect(wrapper.find('[data-testid="session-detail-aux"]').text()).toContain('Your conversation')
  })

  it('places matrix cell costs and blanks unused lanes', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(DETAIL))
    const wrapper = mount(SessionDetailDrawer, { props: { sessionId: 'conv-abc-123' }, global })
    await flushPromises()

    const matrix = wrapper.find('[data-testid="session-detail-matrix"]')
    const rows = matrix.findAll('tbody tr')
    expect(rows).toHaveLength(2) // two models
    // Sonnet row has no cache-read lane → that cell is blanked ('—'), and its
    // row total is the by_model figure.
    const sonnetRow = rows.find((r) => r.text().includes('0.60'))!
    expect(sonnetRow).toBeTruthy()
    expect(sonnetRow.text()).toContain('—')
  })

  /*
   * T16 — a credit-priced session renders honestly.
   *
   * The ledger is already right: span-costing conserves the whole span total on
   * ONE carrier lane because the provider prices in credits, not per token. What
   * was wrong was drawing the other three lanes as $0.00, which reads as "cache
   * reads were free". The tokens per lane are real and must survive.
   */
  const CREDIT_DETAIL: SessionDetail = {
    ...DETAIL,
    session_id: 'conv-copilot-1',
    tool: 'copilot-cli',
    cost_usd: '53.54',
    priced_per_lane: false,
    matrix: [
      { model: 'gpt-5-codex', token_type: 'input', tokens: 120_000, cost_usd: null },
      { model: 'gpt-5-codex', token_type: 'output', tokens: 8_000, cost_usd: null },
      { model: 'gpt-5-codex', token_type: 'cache-read', tokens: 900_000, cost_usd: null },
    ],
    by_model: [{ model: 'gpt-5-codex', tokens: 1_028_000, cost_usd: '53.54' }],
    by_token_type: [
      { token_type: 'input', tokens: 120_000, cost_usd: null },
      { token_type: 'output', tokens: 8_000, cost_usd: null },
      { token_type: 'cache-read', tokens: 900_000, cost_usd: null },
    ],
    cache: { read_tokens: 900_000, write_tokens: 0, input_tokens: 120_000, hit_ratio: 0.88, savings_usd: null },
  }

  it('T16: a credit-priced session renders no per-lane price — and no $0.00', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(CREDIT_DETAIL))
    const wrapper = mount(SessionDetailDrawer, { props: { sessionId: 'conv-copilot-1' }, global })
    await flushPromises()

    const lanes = wrapper.find('[data-testid="session-detail-lanes"]')
    expect(lanes.exists()).toBe(true)
    // The defect itself: not one lane may show a price, and above all not $0.00.
    expect(lanes.text()).not.toContain('$0.00')
    expect(lanes.text()).not.toMatch(/\$\d/)
    // …and the money is still stated ONCE, on the summary tile.
    expect(wrapper.find('[data-testid="session-detail-summary"]').text()).toContain('$53.54')
    // The reason is said out loud rather than left to be inferred from a zero.
    expect(wrapper.find('[data-testid="session-detail-lanes-unpriced"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="session-detail-lanes-unpriced"]').text()).toContain('Not priced per lane')
  })

  it('T16: the token bars still render, sized by TOKENS', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(CREDIT_DETAIL))
    const wrapper = mount(SessionDetailDrawer, { props: { sessionId: 'conv-copilot-1' }, global })
    await flushPromises()

    // Every lane with tokens is present, labelled, and shows its token count.
    const read = wrapper.find('[data-testid="session-detail-lane-cache-read"]')
    expect(read.exists()).toBe(true)
    expect(read.text()).toContain('Cache read')
    // The widest bar is the biggest TOKEN lane (cache-read), not the carrier
    // lane that happens to hold the money (input) — which is the whole point.
    expect(read.find('div.bg-brand-harmony').attributes('style')).toContain('width: 100%')
    const input = wrapper.find('[data-testid="session-detail-lane-input"]')
    const inputWidth = input.find('div.bg-brand-harmony').attributes('style')!
    expect(inputWidth).not.toContain('width: 100%')
    expect(inputWidth).not.toContain('width: 0%')
  })

  it('T16: a token-priced session still shows money per lane (no over-correction)', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(DETAIL))
    const wrapper = mount(SessionDetailDrawer, { props: { sessionId: 'conv-abc-123' }, global })
    await flushPromises()
    const lanes = wrapper.find('[data-testid="session-detail-lanes"]')
    expect(lanes.text()).toContain('$1.90')
    expect(wrapper.find('[data-testid="session-detail-lanes-unpriced"]').exists()).toBe(false)
  })

  it('surfaces a fetch error inline without crashing', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ data: { detail: 'Conversation not found' } }))
    const wrapper = mount(SessionDetailDrawer, { props: { sessionId: 'nope' }, global })
    await flushPromises()
    const err = wrapper.find('[data-testid="session-detail-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('Conversation not found')
    expect(wrapper.find('[data-testid="session-detail-summary"]').exists()).toBe(false)
  })

  it('emits close when the Close button is clicked', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(DETAIL))
    const wrapper = mount(SessionDetailDrawer, { props: { sessionId: 'conv-abc-123' }, global })
    await flushPromises()
    await wrapper.find('[data-testid="session-detail-close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
