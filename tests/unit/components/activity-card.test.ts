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
import { stubActivityCardEnv } from '../../helpers/activity-card-env'
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
  ts_first: '2026-07-01T10:00:00.000Z',
  instance_id: 'inst-1',
  device_name: null,
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
  UiEmptyState: { props: ['headline', 'sub'], template: '<div data-stub="empty"><b>{{ headline }}</b><p>{{ sub }}</p><slot /></div>' },
  NuxtLink: { props: ['to'], template: '<a :href="to" v-bind="$attrs"><slot /></a>' },
  UiAuxFetchError: { props: ['error', 'label'], template: '<p v-if="error" data-testid="aux-error">Couldn\'t load {{ label }}</p>' },
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

function mountCard(
  rows: ActivityRow[],
  over: Partial<ActivityListResponse> = {},
  env: Parameters<typeof stubActivityCardEnv>[0] = {},
) {
  const fetchMock = vi.fn().mockResolvedValue(page(rows, over))
  vi.stubGlobal('$fetch', fetchMock)
  const routeEnv = stubActivityCardEnv(env)
  const wrapper = mount(ActivityCard, { props: {}, global: { stubs: STUBS, mocks: MOCKS } })
  return { fetchMock, wrapper, routeEnv }
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

    // A provider-recorded day is a bucket: the date, and nothing else ("28 Jun"
    // in the server's year, #617).
    const dayCell = wrapper.find(`[data-testid="activity-when-${PROVIDER_DAY.id}"]`).text()
    expect(dayCell).toBe('28 Jun')
    expect(dayCell).not.toContain(':') // no 00:00, no time of any kind
    expect(dayCell).not.toContain('ago')
  })

  it('a provider-recorded day reads "28 Jun" in the server\'s year, with the year otherwise (#617)', async () => {
    const same = mountCard([PROVIDER_DAY], {}, { today: '2026-11-11' })
    await flushPromises()
    expect(same.wrapper.find(`[data-testid="activity-when-${PROVIDER_DAY.id}"]`).text()).toBe('28 Jun')
    same.wrapper.unmount()

    const later = mountCard([PROVIDER_DAY], {}, { today: '2027-01-02' })
    await flushPromises()
    expect(later.wrapper.find(`[data-testid="activity-when-${PROVIDER_DAY.id}"]`).text()).toBe('28 Jun 2026')
    later.wrapper.unmount()

    const noClock = mountCard([PROVIDER_DAY], {}, { today: null })
    await flushPromises()
    expect(noClock.wrapper.find(`[data-testid="activity-when-${PROVIDER_DAY.id}"]`).text()).toBe('28 Jun 2026')
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

  it('until the first page arrives it says Loading, never bare column headers (#591)', async () => {
    let resolve!: (v: ActivityListResponse) => void
    const fetchMock = vi.fn().mockReturnValue(new Promise<ActivityListResponse>((r) => { resolve = r }))
    vi.stubGlobal('$fetch', fetchMock)
    stubActivityCardEnv({})
    const wrapper = mount(ActivityCard, { props: {}, global: { stubs: STUBS, mocks: MOCKS } })
    await flushPromises()
    expect(wrapper.get('[data-testid="activity-loading"]').text()).toBe('Loading…')
    expect(wrapper.find('table').exists()).toBe(false)
    expect(wrapper.find('[data-testid="activity-empty-none"]').exists()).toBe(false)
    resolve(page([SESSION]))
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-loading"]').exists()).toBe(false)
    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
  })

  it('a failed read says so — never an empty list that reads as "nothing happened"', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'))
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = mount(ActivityCard, { props: {}, global: { stubs: STUBS, mocks: MOCKS } })
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-error"]').exists()).toBe(true)
  })
})


/*
 * #578: Project and From/To days reach the list AND the CSV, live in the
 * address, refuse an impossible date with a field error, and Clear filters
 * returns to the default list.
 */
describe('ActivityCard — project and day filters (#578)', () => {
  const lastQuery = (m: ReturnType<typeof vi.fn>) => m.mock.calls.at(-1)![1].query as Record<string, unknown>

  it('the project and the two UTC days reach the request and the CSV link', async () => {
    const { fetchMock, wrapper } = mountCard([SESSION])
    await flushPromises()
    await wrapper.find('[data-testid="activity-filter-project"]').setValue('FALCON')
    await wrapper.find('[data-testid="activity-filter-from"]').setValue('2026-10-01')
    await wrapper.find('[data-testid="activity-filter-to"]').setValue('2026-10-31')
    await flushPromises()
    expect(lastQuery(fetchMock)).toMatchObject({ project: 'FALCON', from: '2026-10-01', to: '2026-10-31' })
    // A filter change restarts the list: no cursor rides along.
    expect(lastQuery(fetchMock).cursor).toBeUndefined()

    // The CSV is built from the same filters (D20).
    const vm = wrapper.vm as unknown as { exportHref: string }
    expect(vm.exportHref).toBe('/api/v1/me/activity/export?project=FALCON&from=2026-10-01&to=2026-10-31')
  })

  it('lists your projects and says the days are UTC days', async () => {
    const { wrapper } = mountCard([SESSION])
    await flushPromises()
    const opts = wrapper.findAll('[data-testid="activity-filter-project"] option').map((o) => o.text())
    expect(opts).toEqual(['Any project', 'ACME-1 · Acme', 'FALCON · Project Falcon'])
    expect(wrapper.text()).toContain('UTC days')
  })

  it('keeps the filters in the address, and reads them back from it', async () => {
    const { fetchMock, wrapper, routeEnv } = mountCard([SESSION], {}, {
      query: { activity_project: 'ACME-1', activity_from: '2026-07-01' },
    })
    await flushPromises()
    // Read from the address on mount: the first request already carries them.
    expect(fetchMock.mock.calls[0]![1].query).toMatchObject({ project: 'ACME-1', from: '2026-07-01' })
    await wrapper.find('[data-testid="activity-filter-to"]').setValue('2026-07-31')
    await flushPromises()
    expect(routeEnv.replace).toHaveBeenLastCalledWith({
      query: { activity_project: 'ACME-1', activity_from: '2026-07-01', activity_to: '2026-07-31' },
    })
  })

  it('an address that changes under the card (Back, Forward, a link) sets the controls and the list', async () => {
    const { fetchMock, wrapper, routeEnv } = mountCard([SESSION])
    await flushPromises()
    routeEnv.route.query = { activity_project: 'FALCON', activity_to: '2026-10-31' }
    await flushPromises()
    expect((wrapper.find('[data-testid="activity-filter-project"]').element as HTMLSelectElement).value).toBe('FALCON')
    expect((wrapper.find('[data-testid="activity-filter-to"]').element as HTMLInputElement).value).toBe('2026-10-31')
    expect(lastQuery(fetchMock)).toMatchObject({ project: 'FALCON', to: '2026-10-31' })
    // Applying the address does not write it back again.
    expect(routeEnv.replace).not.toHaveBeenCalled()
  })

  it('an impossible or reversed range shows a field error and is not sent (no 400 page)', async () => {
    const { fetchMock, wrapper } = mountCard([SESSION], {}, { query: { activity_from: '2026-02-31' } })
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-day-error"]').text()).toContain('From is not a real date.')
    expect(fetchMock.mock.calls[0]![1].query.from).toBeUndefined()

    await wrapper.find('[data-testid="activity-filter-from"]').setValue('2026-10-31')
    await wrapper.find('[data-testid="activity-filter-to"]').setValue('2026-10-01')
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-day-error"]').text()).toContain('From is after To.')
    expect(lastQuery(fetchMock).from).toBeUndefined()
    expect(lastQuery(fetchMock).to).toBeUndefined()
  })

  it('the date picker stops at the SERVER clock\'s today, not the browser\'s', async () => {
    const { wrapper } = mountCard([SESSION], {}, { today: '2026-11-11' })
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-filter-to"]').attributes('max')).toBe('2026-11-11')
  })

  it('Clear filters returns to the default list and clears the address', async () => {
    const { fetchMock, wrapper, routeEnv } = mountCard([SESSION], {}, {
      query: { activity_project: 'ACME-1', activity_to: '2026-07-31' },
    })
    await flushPromises()
    await wrapper.find('[data-testid="activity-filter-kind"]').setValue('session')
    await flushPromises()
    await wrapper.find('[data-testid="activity-clear-filters"]').trigger('click')
    await flushPromises()
    expect(lastQuery(fetchMock)).toEqual({ limit: 25 })
    expect(routeEnv.replace).toHaveBeenLastCalledWith({ query: {} })
    expect(wrapper.find('[data-testid="activity-clear-filters"]').exists()).toBe(false)
  })

  it('says what a project filter holds, including that a multi-project session can show another project', async () => {
    const { wrapper } = mountCard([SESSION], {}, { query: { activity_project: 'FALCON' } })
    await flushPromises()
    const note = wrapper.find('[data-testid="activity-filter-summary"]').text()
    expect(note).toContain('touched FALCON')
    expect(note).toContain('can show another one')
    // The CSV promise names its cap rather than claiming the same rows.
    expect(note).toContain('up to the newest 1,000 rows')
  })

  it('a failed projects read says so under the picker instead of an empty list', async () => {
    const { wrapper } = mountCard([SESSION], {}, { projectsError: new Error('boom') })
    await flushPromises()
    expect(wrapper.find('[data-testid="aux-error"]').text()).toContain('your projects')
  })
})

/*
 * #579: two empty states. Nothing ever recorded offers Connect; a filter
 * matching nothing says so and offers Clear filters, and never suggests
 * connecting. The old jargon is gone.
 */
describe('ActivityCard — empty states (#579)', () => {
  it('with no filter, an empty list is "No activity yet" with Connect a tool', async () => {
    const { wrapper } = mountCard([])
    await flushPromises()
    const empty = wrapper.find('[data-testid="activity-empty-none"]')
    expect(empty.text()).toContain('No activity yet')
    expect(empty.text()).toContain('Connect Claude Code or Copilot on this computer')
    expect(wrapper.find('[data-testid="activity-empty-connect"]').attributes('href')).toBe('/account#connect-a-tool')
    expect(wrapper.text()).not.toContain('MCP prompt')
    expect(wrapper.text()).not.toContain('reconciliation')
  })

  it('with a filter, an empty list is "Nothing matches these filters" and never suggests connecting', async () => {
    const { wrapper } = mountCard([], {}, { query: { activity_project: 'FALCON' } })
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-empty-filtered"]').text()).toContain('Nothing matches these filters')
    expect(wrapper.find('[data-testid="activity-empty-none"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Connect')
    await wrapper.find('[data-testid="activity-empty-clear"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-empty-none"]').exists()).toBe(true)
  })
})

describe('ActivityCard — device names (#576)', () => {
  it('a named device shows its name; an unnamed one its tool and short id', async () => {
    const named = { ...SESSION, id: 'conv-named', instance_id: '9a1e0000-0000-4000-8000-000000000001', device_name: 'Work laptop' } as ActivityRow
    const plain = { ...SESSION, id: 'conv-plain', instance_id: '9e8d7c6b-0000-4000-8000-000000000002', device_name: null } as ActivityRow
    const { wrapper } = mountCard([named, plain])
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-device-conv-named"]').text()).toBe('Work laptop')
    expect(wrapper.find('[data-testid="activity-device-conv-plain"]').text()).toBe('Claude Code · 9e8d7c6b')
    expect(wrapper.find(`[data-testid="activity-device-${PROVIDER_DAY.id}"]`).exists()).toBe(false)
  })
})

describe('ActivityCard: rows you can recognise (#597)', () => {
  it('a session leads with when it ran; the id stays in the tooltip', async () => {
    const { wrapper } = mountCard([SESSION])
    await flushPromises()
    const open = wrapper.find(`[data-testid="activity-open-${SESSION.id}"]`)
    expect(open.text()).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}/)
    expect(open.text()).not.toContain(SESSION.id.slice(0, 12))
    expect(open.attributes('title')).toContain(SESSION.id)
  })

  it('a provider day has no time', async () => {
    const { wrapper } = mountCard([PROVIDER_DAY])
    await flushPromises()
    expect(wrapper.find(`[data-testid="activity-open-${PROVIDER_DAY.id}"]`).text()).toBe('Provider-recorded day')
  })

  it('the Project cell leads with the name and keeps the code', async () => {
    const { wrapper } = mountCard([{ ...SESSION, project_code: 'ACME-1', project_display_name: 'Acme Platform', attributed: true }])
    await flushPromises()
    expect(wrapper.find(`[data-testid="activity-project-name-${SESSION.id}"]`).text()).toBe('Acme Platform')
    expect(wrapper.text()).toContain('ACME-1')
  })
})
