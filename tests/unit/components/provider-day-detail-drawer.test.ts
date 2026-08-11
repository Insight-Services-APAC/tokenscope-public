// @vitest-environment happy-dom
/*
 * ProviderDayDetailDrawer — the drill-down for a provider-recorded day, over
 * GET /api/v1/me/unaccounted/{id}.
 *
 * Contract under test (load-bearing behaviour, not layout):
 *  - closed (recordId=null) renders nothing and never fetches;
 *  - opening fetches the right endpoint and renders the model mix, the token
 *    lanes and the cost-by-model table from the ProviderDayDetail payload;
 *  - the three null-model buckets are labelled DIFFERENTLY, so a transient gap
 *    cannot read as a permanent one;
 *  - the provider total appears only when it differs from the residual;
 *  - sections a provider-recorded day genuinely has no data for are ABSENT, and
 *    nothing on the panel explains their absence in prose;
 *  - a fetch error surfaces inline; Close emits `close`.
 *
 * Each assertion was verified to FAIL with its fix reverted; mutations are noted
 * inline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ProviderDayDetailDrawer from '../../../app/components/provider-day/DetailDrawer.vue'
import type { ProviderDayDetail } from '../../../shared/schemas/provider-day'

const OBSERVED: ProviderDayDetail = {
  id: '11111111-1111-4111-8111-111111111111',
  day: '2026-07-15',
  tool: 'claude-code',
  project_id: null,
  project_code: null,
  project_display_name: null,
  activity: null,
  dismissed: false,
  unallocated_cost_usd: '20.00',
  unallocated_tokens: 5_000,
  provider_cost_usd: '50.00',
  tokens: 100_000,
  requests: 42,
  web_search_requests: 6,
  source_count: 2,
  detail_state: 'observed',
  by_model: [
    { model: 'claude-opus-4', cost_usd: '40.00', tokens: 10_000, requests: 30, null_model_reason: null },
    { model: 'claude-sonnet-4', cost_usd: '10.00', tokens: 90_000, requests: 12, null_model_reason: null },
  ],
  by_token_type: [
    { token_type: 'input', tokens: 20_000 },
    { token_type: 'output', tokens: 10_000 },
    { token_type: 'cache-read', tokens: 60_000 },
    { token_type: 'cache-write', tokens: 10_000 },
  ],
}

const AWAITING: ProviderDayDetail = {
  ...OBSERVED,
  unallocated_cost_usd: '42.50',
  provider_cost_usd: null,
  tokens: 0,
  requests: 0,
  web_search_requests: null,
  source_count: 0,
  detail_state: 'awaiting-provider-detail',
  by_model: [
    { model: null, cost_usd: '42.50', tokens: 1_234, requests: null, null_model_reason: 'awaiting-provider-detail' },
  ],
  by_token_type: [],
}

/*
 * A model observed with TOKENS but no cost row yet. Reachable because
 * provider_usage_fact's measure check keeps cost rows and token rows disjoint,
 * so the token row can land first. Copilot review caught the endpoint coercing
 * this to '0.00'.
 */
const COST_NOT_YET_DERIVED: ProviderDayDetail = {
  ...OBSERVED,
  provider_cost_usd: null,
  by_model: [
    { model: 'claude-opus-4', cost_usd: '40.00', tokens: 10_000, requests: 30, null_model_reason: null },
    { model: 'claude-sonnet-4', cost_usd: null, tokens: 90_000, requests: 12, null_model_reason: null },
  ],
}

/*
 * The endpoint's Copilot shape (provider-transform-github.ts): money and CLI
 * tokens at day grain in the bucket, MODEL rows carrying ONLY `requests` —
 * their tokens and cost are NULL because Copilot never measures either at
 * model grain. NULL, not 0: a zero would claim a measurement nobody made.
 */
const DAY_GRAIN: ProviderDayDetail = {
  ...OBSERVED,
  tool: 'copilot-cli',
  unallocated_cost_usd: '9.00',
  provider_cost_usd: '9.00',
  tokens: 0,
  requests: 12,
  web_search_requests: null,
  source_count: 1,
  detail_state: 'observed',
  by_model: [
    { model: null, cost_usd: '9.00', tokens: 0, requests: null, null_model_reason: 'provider-reports-day-grain' },
    { model: 'gpt-5', cost_usd: null, tokens: null, requests: 12, null_model_reason: null },
  ],
  by_token_type: [],
}

// Auto-imported globals the drawer renders — stubbed to keep the test on the
// drawer's own logic (they have their own tests).
const global = {
  stubs: {
    Icon: true,
    UiEyebrow: { template: '<div><slot /></div>' },
    UiButton: { template: '<button v-bind="$attrs"><slot /></button>' },
    ChartsDonutChart: { props: ['slices'], template: '<div data-testid="stub-donut" />' },
  },
}

const ID = OBSERVED.id

function open(payload: ProviderDayDetail) {
  const fetchMock = vi.fn().mockResolvedValue(payload)
  vi.stubGlobal('$fetch', fetchMock)
  return { fetchMock, wrapper: mount(ProviderDayDetailDrawer, { props: { recordId: ID }, global }) }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('ProviderDayDetailDrawer', () => {
  it('renders nothing and never fetches when closed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = mount(ProviderDayDetailDrawer, { props: { recordId: null }, global })
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-day-detail-drawer"]').exists()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /*
   * MUTATION: point `load()` at /api/v1/me/sessions/... — the endpoint
   * assertion goes red. Change the model table to render `cost_usd` from the
   * wrong field and the per-model figures go red.
   */
  it('fetches the day endpoint and renders the observed breakdown', async () => {
    const { fetchMock, wrapper } = open(OBSERVED)
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/me/unaccounted/${ID}`)
    expect(wrapper.find('[data-testid="provider-day-detail-drawer"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('2026-07-15')

    // The taggable amount — the number the worklist row showed.
    expect(wrapper.find('[data-testid="provider-day-unallocated"]').text()).toContain('$20.00')
    // Requests, and the dimension only the API lane carries.
    expect(wrapper.find('[data-testid="provider-day-requests"]').text()).toContain('42')
    expect(wrapper.find('[data-testid="provider-day-web-searches"]').text()).toContain('6')

    // Lanes, cache included — observed tokens, and no dollar figure on them.
    const lanes = wrapper.find('[data-testid="provider-day-detail-lanes"]')
    expect(lanes.exists()).toBe(true)
    expect(lanes.text()).toContain('Cache read')
    expect(lanes.text()).toContain('Cache write')
    expect(lanes.text()).not.toContain('$')

    // Cost by model, with each model's own token count beside its own cost.
    const table = wrapper.find('[data-testid="provider-day-detail-model-table"]')
    expect(table.text()).toContain('$40.00')
    expect(table.text()).toContain('$10.00')
    expect(table.text()).toContain('Opus')
    expect(table.text()).toContain('Sonnet')
  })

  /*
   * The residual and the provider total are different quantities and are shown
   * as two figures only when they actually differ.
   *
   * MUTATION: drop the `!==` from `showProviderTotal` so it renders whenever
   * non-null — the "not shown when equal" assertion goes red.
   */
  it('shows the provider total only when it differs from the residual', async () => {
    const { wrapper } = open(OBSERVED)
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-day-provider-total"]').text()).toContain('$50.00')

    vi.restoreAllMocks()
    const same = { ...OBSERVED, unallocated_cost_usd: '50.00' }
    const { wrapper: w2 } = open(same)
    await flushPromises()
    expect(w2.find('[data-testid="provider-day-provider-total"]').exists()).toBe(false)
    expect(w2.find('[data-testid="provider-day-unallocated"]').text()).toContain('$50.00')
  })

  /*
   * DECISION 3 — a transient gap must not read like a permanent one.
   *
   * MUTATION: map both reasons to the same string in NULL_MODEL_LABELS — the
   * inequality assertion goes red.
   */
  it('labels the transient bucket differently from the structural one', async () => {
    const { wrapper } = open(AWAITING)
    await flushPromises()
    const transientText = wrapper.find('[data-testid="provider-day-detail-model-table"]').text()
    expect(transientText).toContain('Awaiting provider detail')
    // The whole residual is rendered — not null, not $0.
    expect(transientText).toContain('$42.50')
    expect(transientText).not.toContain('$0.00')

    vi.restoreAllMocks()
    const { wrapper: w2 } = open(DAY_GRAIN)
    await flushPromises()
    const structuralText = w2.find('[data-testid="provider-day-detail-model-table"]').text()
    expect(structuralText).toContain('Reported at day grain')
    expect(structuralText).not.toContain('Awaiting provider detail')
  })

  /*
   * Copilot's day-grain money stays in its bucket; its model row carries
   * activity and no money.
   *
   * THE DEV 2026-08-04 DEFECT, drawer side: a Copilot MODEL row's whole reason
   * to exist is its `requests`, and its cost/tokens are null by nature — so the
   * requests cell must render from its own value, never collapse into em-dash
   * because the row's OTHER cells are unknown.
   *
   * MUTATION: gate the requests cell on the row's cost or tokens (or drop the
   * cell's own render branch) — the '12' assertion goes red.
   */
  it('keeps Copilot day-grain money out of its model row', async () => {
    const { wrapper } = open(DAY_GRAIN)
    await flushPromises()
    const table = wrapper.find('[data-testid="provider-day-detail-model-table"]')
    expect(table.text()).toContain('Reported at day grain')
    expect(table.text()).toContain('$9.00')
    // The model row is present (modelDisplay humanises 'gpt-5' → 'GPT-5'),
    // carrying its 12 interactions and no money.
    expect(table.text()).toContain('GPT-5')
    expect(table.text()).toContain('12')
    // No money claim appears on the model row: Copilot reported its dollars at
    // day grain, so the model's share is UNKNOWN — an em-dash, never "$0.00".
    expect(table.text()).not.toContain('$0.00')

    // Cell-level, on the model row itself: requests render, unknown tokens and
    // unknown cost are em-dashes. (Cells are model | tokens | requests | cost.)
    const cells = wrapper.find('[data-testid="provider-day-model-gpt-5"]').findAll('td')
    expect(cells[2]!.text()).toBe('12')
    expect(cells[1]!.text()).toBe('—')
    expect(cells[3]!.text()).toBe('—')
    // And the bucket row, whose requests were never measured, keeps an em-dash
    // in the requests cell rather than inventing a 0.
    const bucket = wrapper
      .find('[data-testid="provider-day-model-bucket:provider-reports-day-grain"]')
      .findAll('td')
    expect(bucket[2]!.text()).toBe('—')
  })

  /*
   * Unknown-stays-unknown, but ZERO IS A MEASUREMENT. A provider that reported
   * `requests: 0` (or a token sum of 0) made a claim, and folding it into the
   * same em-dash as "never measured" erases the distinction the nullable
   * contract exists to carry.
   *
   * MUTATION: restore the `> 0` guards on the tokens/requests cells in
   * DetailDrawer.vue — the '0' assertions below render em-dashes and go red.
   */
  it('renders a measured zero as 0, and only a genuinely absent value as em-dash', async () => {
    const payload: ProviderDayDetail = {
      ...OBSERVED,
      by_model: [
        { model: 'claude-opus-4', cost_usd: '40.00', tokens: 0, requests: 0, null_model_reason: null },
        { model: 'claude-sonnet-4', cost_usd: null, tokens: null, requests: null, null_model_reason: null },
      ],
    }
    const { wrapper } = open(payload)
    await flushPromises()

    const measured = wrapper.find('[data-testid="provider-day-model-claude-opus-4"]').findAll('td')
    expect(measured[1]!.text()).toBe('0')
    expect(measured[2]!.text()).toBe('0')

    const absent = wrapper.find('[data-testid="provider-day-model-claude-sonnet-4"]').findAll('td')
    expect(absent[1]!.text()).toBe('—')
    expect(absent[2]!.text()).toBe('—')
    expect(absent[3]!.text()).toBe('—')
  })

  /*
   * Multi-org disclosure: one taggable record can stand against two orgs' rows.
   *
   * MUTATION: delete the `source_count > 1` chip — this goes red.
   */
  it('discloses a multi-org teammate-day, and stays silent on a single-org one', async () => {
    const { wrapper } = open(OBSERVED)
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-day-source-count"]').text()).toContain('2')

    vi.restoreAllMocks()
    const { wrapper: w2 } = open({ ...OBSERVED, source_count: 1 })
    await flushPromises()
    expect(w2.find('[data-testid="provider-day-source-count"]').exists()).toBe(false)
  })

  /*
   * ABSENT BY NATURE, AND NOT EXPLAINED. A provider-recorded day has no session,
   * no duration and no conversation-vs-harness split, and cache SAVINGS cannot be
   * produced without a ratio across disjoint rows. The panel omits those sections
   * rather than printing a paragraph about them — this codebase's standing defect
   * is cards that editorialise about what they cannot show.
   *
   * MUTATION: add a "no session id is available for a provider-recorded day"
   * explainer to the template — every assertion below goes red.
   */
  it('omits the sections it has no data for, without explaining them', async () => {
    const { wrapper } = open(OBSERVED)
    await flushPromises()
    const text = wrapper.text()

    expect(wrapper.find('[data-testid="session-detail-aux"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="provider-day-detail-cache"]').exists()).toBe(false)
    expect(text).not.toContain('Duration')
    expect(text).not.toContain('Conversation vs harness')
    expect(text).not.toContain('Cache economics')
    expect(text).not.toContain('Caching saved')
    // No prose about absence, in any of its usual shapes.
    expect(text).not.toMatch(/not available|isn’t available|is not available|no session id|unavailable for/i)
  })

  it('surfaces a fetch error inline and emits close', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const wrapper = mount(ProviderDayDetailDrawer, { props: { recordId: ID }, global })
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-day-detail-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-day-detail-model-table"]').exists()).toBe(false)

    await wrapper.find('[data-testid="provider-day-detail-close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  /*
   * Copilot review (PR #231): the endpoint coerced an underived per-model cost
   * to '0.00', asserting a measurement nobody made — beside a provider total
   * that was correctly blank. Two answers to one question on one card.
   *
   * MUTATION: restore `usd(g.cost_usd ?? 0)` in provider-day-detail.ts, or drop
   * the `v-if="m.cost != null"` guard in the table — this goes red both ways.
   */
  it('shows an underived per-model cost as unknown, never as $0.00', async () => {
    const { wrapper } = open(COST_NOT_YET_DERIVED)
    await flushPromises()

    const table = wrapper.find('[data-testid="provider-day-detail-model-table"]')
    expect(table.exists()).toBe(true)
    // The model with a cost row still reports it.
    expect(table.text()).toContain('$40.00')
    // The one without does NOT read as zero dollars.
    expect(table.text()).not.toContain('$0.00')
    // Its observed dimensions still show — tokens and requests ARE measured
    // even when its dollars are not yet derived.
    expect(table.text()).toContain('90.0K')

    // And it is not drawn as a slice: an unknown has no share of a total. The
    // donut is fed a prop, not per-slice DOM, so the prop IS the contract.
    const donut = wrapper.findComponent('[data-testid="stub-donut"]')
    expect(donut.props('slices')).toHaveLength(1)
    expect((donut.props('slices') as { label: string }[])[0]!.label).toContain('Opus 4')
  })
})
