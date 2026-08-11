// @vitest-environment happy-dom
/*
 * ActivityCard — the external-review fix pass. Three findings, one card:
 *
 *   - NO STALE-RESPONSE PROTECTION. Three things call `load` (the filter watcher,
 *     "Load more", the page's post-tag `refresh()`) and nothing sequenced their
 *     responses, so a slow request could land last and replace the list with rows
 *     that do not match the controls above them.
 *   - A NULL TOKEN COUNT RENDERED AS `0`. GitHub's AI-credit usage API reports
 *     credits, not tokens, so a Copilot provider-day has no token quantity at
 *     all — and a "0" beside a real cost asserts a measurement nobody made.
 *   - THE PAGE READ THE LIST TWICE. `/` ran its own `/me/activity?limit=1` probe
 *     for the onboarding CTA, beside the card rendering the same list; the card
 *     now publishes the answer and the probe is gone.
 *
 * Fixture idiom is `activity-card.test.ts`'s, kept separate so that file stays
 * about the §F4 contract and this one about the fixes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ActivityCard from '../../../app/components/me/ActivityCard.vue'
import type { ActivityListResponse, ActivityRow } from '../../../shared/schemas/activity'

const SESSION: ActivityRow = {
  kind: 'session',
  id: 'conv-1234567890ab',
  day: '2026-07-01',
  tool: 'claude-code',
  project_id: 'p1',
  project_code: 'ACME-1',
  project_display_name: 'Acme',
  activity: null,
  tokens: 1000,
  cost_usd: '9.12',
  attributed: true,
  cursor: 'cur-session',
  ts_last: '2026-07-01T11:00:00.000Z',
  instance_id: 'inst-1',
  partly_ended: false,
  ended_project_code: null,
}

const PROVIDER_DAY: ActivityRow = {
  kind: 'provider-day',
  id: '22222222-2222-4222-8222-222222222222',
  day: '2026-06-28',
  tool: 'copilot-cli',
  project_id: 'p1',
  project_code: 'ACME-1',
  project_display_name: 'Acme',
  activity: null,
  tokens: 4000,
  cost_usd: '7.00',
  attributed: true,
  cursor: 'cur-day',
  dismissed: false,
}

const page = (rows: ActivityRow[], over: Partial<ActivityListResponse> = {}): ActivityListResponse => ({
  rows,
  next_cursor: null,
  has_more: false,
  filters: { kind: 'all', tagged: 'all' },
  ...over,
})

const STUBS = {
  UiCard: { template: '<div data-stub="card"><slot /></div>' },
  UiButton: { template: '<button v-bind="$attrs"><slot /></button>' },
  UiEmptyState: { template: '<div data-stub="empty" />' },
  UiToolPill: true,
  UsageModelBadge: true,
  Icon: true,
}
const MOCKS = {
  fmtUsd: (n: number | string) => `$${Number(n).toFixed(2)}`,
  fmtTokens: (n: number) => String(n),
  fmtTimeAgo: () => '2 hours ago',
}

const mountWith = () => mount(ActivityCard, { props: {}, global: { stubs: STUBS, mocks: MOCKS } })

function mountCard(rows: ActivityRow[], over: Partial<ActivityListResponse> = {}) {
  const fetchMock = vi.fn().mockResolvedValue(page(rows, over))
  vi.stubGlobal('$fetch', fetchMock)
  return { fetchMock, wrapper: mountWith() }
}

beforeEach(() => vi.unstubAllGlobals())

describe('only the NEWEST request may write to the list', () => {
  /*
   * RED ON REVERT: delete the `seq !== requestSeq` guards in `load` and the
   * stale page below wins, because it resolves last.
   */
  it('a slow response from a SUPERSEDED filter cannot overwrite the current one', async () => {
    let releaseStale: (v: ActivityListResponse) => void = () => {}
    const stale = new Promise<ActivityListResponse>((r) => {
      releaseStale = r
    })
    const fetchMock = vi.fn()
    // Mount → the first (default-filter) request, deliberately left in flight.
    fetchMock.mockReturnValueOnce(stale)
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = mountWith()

    // The reader changes a filter before the first request has answered.
    fetchMock.mockResolvedValue(page([PROVIDER_DAY]))
    await wrapper.find('[data-testid="activity-filter-kind"]').setValue('provider-day')
    await flushPromises()
    expect(wrapper.findAll('tbody tr')).toHaveLength(1)

    // NOW the obsolete request answers, carrying rows from the OLD filter.
    releaseStale(page([SESSION, PROVIDER_DAY]))
    await flushPromises()

    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
    expect(wrapper.find(`[data-testid="activity-row-${SESSION.id}"]`).exists()).toBe(false)
  })

  /*
   * RED ON REVERT: remove the guard in the `catch` and a superseded request's
   * failure raises the error banner over a list that loaded perfectly well.
   */
  it('a superseded request FAILING does not raise an error over a good list', async () => {
    let rejectStale: (e: unknown) => void = () => {}
    const stale = new Promise<ActivityListResponse>((_, rej) => {
      rejectStale = rej
    })
    stale.catch(() => {}) // the component owns the real handling; keep node quiet
    const fetchMock = vi.fn()
    fetchMock.mockReturnValueOnce(stale)
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = mountWith()

    fetchMock.mockResolvedValue(page([PROVIDER_DAY]))
    await wrapper.find('[data-testid="activity-filter-kind"]').setValue('provider-day')
    await flushPromises()

    rejectStale(new Error('boom, from a request nobody is waiting for'))
    await flushPromises()

    expect(wrapper.find('[data-testid="activity-error"]').exists()).toBe(false)
    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
  })
})

describe('a token count that was never measured is not a zero', () => {
  /*
   * RED ON REVERT: put `{{ fmtTokens(r.tokens) }}` back on the cell and the null
   * renders as the formatter's output for null rather than "not reported".
   *
   * PAIRED CHANGE: the server currently coerces this NULL to 0
   * (`server/reports/activity-list.ts`) and the sibling agent's change stops it.
   * This renderer is correct before and after, so the two can land in any order.
   */
  it('renders "not reported" when the wire sends no token quantity', async () => {
    const nullTokens = { ...PROVIDER_DAY, tokens: null } as unknown as ActivityRow
    const { wrapper } = mountCard([nullTokens])
    await flushPromises()
    const cell = wrapper.find(`[data-testid="activity-tokens-${PROVIDER_DAY.id}"]`)
    expect(cell.text()).toBe('not reported')
    expect(cell.text()).not.toContain('0')
    expect(cell.attributes('title')).toContain('never measured')
  })

  it('still renders a real count as a number — the fix silences nothing real', async () => {
    const { wrapper } = mountCard([PROVIDER_DAY])
    await flushPromises()
    expect(wrapper.find(`[data-testid="activity-tokens-${PROVIDER_DAY.id}"]`).text()).toBe('4000')
  })
})

describe('the card publishes ONLY `refresh` — it answers no onboarding question', () => {
  /*
   * RED ON REVERT: re-expose `loaded`/`hasRows` and this goes red. They were
   * published so `/` could decide its new-user CTA from this list; both are facts
   * about the CURRENT page of the CURRENT filter (a filter matching nothing, or a
   * failed refresh, reads as "never emitted"), and the list is a UNION of OTel
   * sessions and API-reported provider days, so it cannot speak for the OTel lane
   * the CTA asks about. The page reads `/me/home.has_ever_emitted` instead.
   */
  it('exposes refresh, and neither `loaded` nor `hasRows`', async () => {
    const { wrapper } = mountCard([SESSION])
    await flushPromises()
    const vm = wrapper.vm as unknown as Record<string, unknown>
    expect(typeof vm.refresh).toBe('function')
    expect(vm.loaded).toBeUndefined()
    expect(vm.hasRows).toBeUndefined()
  })
})
