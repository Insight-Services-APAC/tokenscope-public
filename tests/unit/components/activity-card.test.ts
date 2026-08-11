// @vitest-environment happy-dom
/*
 * §F4 T21 — ActivityCard: rows of BOTH kinds, TWO drawers, the reused details
 * pane, and the grain rule.
 *
 * The card replaces RecentSessionsCard, which could only ever hold sessions.
 * What is pinned here is the behaviour the owner ruling turns on:
 *  - both kinds render in ONE table, each labelled with what it is;
 *  - a SESSION row opens the SESSION drawer and a PROVIDER-DAY row opens the
 *    PROVIDER-DAY drawer — two different intents, so the card can never route
 *    one kind into the other's pane, and it builds neither pane itself;
 *  - THE GRAIN RULE: a provider-day row renders a DATE and never a time. A
 *    synthesised 00:00 is the NULL-as-0 defect in a new costume;
 *  - the CSV link carries the ACTIVE filters (D20), and changing a filter
 *    restarts the list rather than appending across a stale cursor.
 *
 * Each assertion was checked against its mutation; they are noted inline.
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

/** Note what is NOT here: no ts_last, no instant of any kind. */
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
  // TAGGED — the record the old surfaces lost the moment it was decided.
  attributed: true,
  cursor: 'cur-day',
  dismissed: false,
}

const page = (rows: ActivityRow[], over: Partial<ActivityListResponse> = {}): ActivityListResponse => ({
  rows,
  next_cursor: null,
  has_more: false,
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
  // A real formatter of a real instant. If a provider-day row ever reached it,
  // this string would show up in that row's cell — which is the mutation.
  fmtTimeAgo: () => '2 hours ago',
}

function mountCard(rows: ActivityRow[], over: Partial<ActivityListResponse> = {}) {
  const fetchMock = vi.fn().mockResolvedValue(page(rows, over))
  vi.stubGlobal('$fetch', fetchMock)
  const wrapper = mount(ActivityCard, { props: {}, global: { stubs: STUBS, mocks: MOCKS } })
  return { fetchMock, wrapper }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('ActivityCard — one list, two kinds', () => {
  it('reads /me/activity and renders both kinds in ONE table', async () => {
    const { fetchMock, wrapper } = mountCard([SESSION, PROVIDER_DAY])
    await flushPromises()

    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/me/activity')
    expect(wrapper.find('[data-testid="activity-card"]').exists()).toBe(true)
    expect(wrapper.findAll('tbody tr')).toHaveLength(2)
    // Each row says which kind it is — the reader never has to know which
    // ingestion mechanism captured their work.
    expect(wrapper.find(`[data-testid="activity-kind-${SESSION.id}"]`).text()).toBe('session')
    expect(wrapper.find(`[data-testid="activity-kind-${PROVIDER_DAY.id}"]`).text()).toBe('provider day')
  })

  /*
   * MUTATION: make openDetail always emit 'open-session' — the second
   * expectation goes red, and the card would route a day into the session pane.
   */
  it('T21 — a session row opens the SESSION drawer, a provider-day row opens the PROVIDER-DAY drawer', async () => {
    const { wrapper } = mountCard([SESSION, PROVIDER_DAY])
    await flushPromises()

    await wrapper.find(`[data-testid="activity-open-${SESSION.id}"]`).trigger('click')
    expect(wrapper.emitted('open-session')![0]).toEqual([SESSION.id])
    expect(wrapper.emitted('open-provider-day')).toBeUndefined()

    await wrapper.find(`[data-testid="activity-open-${PROVIDER_DAY.id}"]`).trigger('click')
    expect(wrapper.emitted('open-provider-day')![0]).toEqual([PROVIDER_DAY.id])
    // Still ONE session intent — the day did not leak into the session pane.
    expect(wrapper.emitted('open-session')!).toHaveLength(1)

    // The Details affordance routes identically to the id affordance.
    await wrapper.find(`[data-testid="details-${PROVIDER_DAY.id}"]`).trigger('click')
    expect(wrapper.emitted('open-provider-day')!).toHaveLength(2)
  })

  /*
   * MUTATION: render `fmtTimeAgo(r.day)` (or a `${r.day}T00:00` literal) in the
   * provider-day branch of the When cell — this goes red immediately.
   */
  it('THE GRAIN RULE — a provider-day row renders a DATE and never a time', async () => {
    const { wrapper } = mountCard([SESSION, PROVIDER_DAY])
    await flushPromises()

    // A session is an instant: rendered in the viewer's zone.
    expect(wrapper.find(`[data-testid="activity-when-${SESSION.id}"]`).text()).toBe('2 hours ago')

    // A provider-recorded day is a bucket: the date, and nothing else.
    const dayCell = wrapper.find(`[data-testid="activity-when-${PROVIDER_DAY.id}"]`).text()
    expect(dayCell).toBe('2026-06-28')
    expect(dayCell).not.toContain(':') // no 00:00, no time of any kind
    expect(dayCell).not.toContain('ago')
  })

  it('a TAGGED provider-recorded day is on the list, showing its project', async () => {
    const { wrapper } = mountCard([PROVIDER_DAY])
    await flushPromises()
    const row = wrapper.find(`[data-testid="activity-row-${PROVIDER_DAY.id}"]`)
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('ACME-1')
    expect(row.text()).not.toContain('unallocated')
  })

  it('the tag intent carries the day route for a day, and no invented instant', async () => {
    const { wrapper } = mountCard([SESSION, PROVIDER_DAY])
    await flushPromises()

    await wrapper.find(`[data-testid="retag-${PROVIDER_DAY.id}"]`).trigger('click')
    expect(wrapper.emitted('retag')![0]![0]).toMatchObject({
      session_id: PROVIDER_DAY.id,
      assign_url: `/api/v1/me/unaccounted/${PROVIDER_DAY.id}/assign`,
      subject_kind: 'day',
      subject_label: '2026-06-28',
      last_event: '2026-06-28',
    })

    await wrapper.find(`[data-testid="retag-${SESSION.id}"]`).trigger('click')
    expect(wrapper.emitted('retag')![1]![0]).toMatchObject({
      session_id: SESSION.id,
      instance_id: 'inst-1',
      subject_kind: 'session',
      last_event: '2026-07-01T11:00:00.000Z',
    })
    expect((wrapper.emitted('retag')![1]![0] as { assign_url?: string }).assign_url).toBeUndefined()
  })

  it('flags a quarantined (session|instance) pair, and only session rows', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([SESSION, PROVIDER_DAY]))
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = mount(ActivityCard, {
      props: { quarantined: [{ session_id: SESSION.id, instance_id: 'inst-1', cost_usd: '9.12' }] },
      global: { stubs: STUBS, mocks: MOCKS },
    })
    await flushPromises()
    expect(wrapper.findAll('[data-testid="quarantined-badge"]')).toHaveLength(1)
  })
})

describe('ActivityCard — filters and the CSV that respects them (D20)', () => {
  /*
   * MUTATION: build exportHref from a constant — the second assertion goes red.
   */
  it('the CSV link carries the ACTIVE filters', async () => {
    const { wrapper } = mountCard([SESSION])
    await flushPromises()
    const vm = wrapper.vm as unknown as { exportHref: string }
    expect(vm.exportHref).toBe('/api/v1/me/activity/export')

    await wrapper.find('[data-testid="activity-filter-kind"]').setValue('provider-day')
    await wrapper.find('[data-testid="activity-filter-tagged"]').setValue('untagged')
    await flushPromises()
    expect(vm.exportHref).toBe('/api/v1/me/activity/export?kind=provider-day&tagged=untagged')
  })

  /*
   * MUTATION: make the filter watcher append instead of restarting — the row
   * count doubles and this goes red.
   */
  it('a filter change RESTARTS the list; it never appends across a stale cursor', async () => {
    const { fetchMock, wrapper } = mountCard([SESSION, PROVIDER_DAY])
    await flushPromises()
    expect(wrapper.findAll('tbody tr')).toHaveLength(2)

    fetchMock.mockResolvedValue(page([PROVIDER_DAY]))
    await wrapper.find('[data-testid="activity-filter-kind"]').setValue('provider-day')
    await flushPromises()

    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
    const lastCall = fetchMock.mock.calls.at(-1)![1] as { query: Record<string, unknown> }
    expect(lastCall.query.kind).toBe('provider-day')
    expect(lastCall.query.cursor).toBeUndefined()
  })

  it('Load more APPENDS on the server cursor, and only when there is more', async () => {
    const { fetchMock, wrapper } = mountCard([SESSION], { has_more: true, next_cursor: 'cur-1' })
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-load-more"]').exists()).toBe(true)

    fetchMock.mockResolvedValue(page([PROVIDER_DAY]))
    await wrapper.find('[data-testid="activity-load-more"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('tbody tr')).toHaveLength(2)
    const lastCall = fetchMock.mock.calls.at(-1)![1] as { query: Record<string, unknown> }
    expect(lastCall.query.cursor).toBe('cur-1')
    expect(wrapper.find('[data-testid="activity-load-more"]').exists()).toBe(false)
  })

  it('a failed read says so — never an empty list that reads as "nothing happened"', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'))
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = mount(ActivityCard, { props: {}, global: { stubs: STUBS, mocks: MOCKS } })
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-error"]').exists()).toBe(true)
  })
})
