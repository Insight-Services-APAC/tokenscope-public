// @vitest-environment happy-dom
/*
 * HomeNeedsTaggingPanel — the needs-tagging worklist as a decision queue.
 * Contract: both item kinds carry their own subtotal, one selection spans them,
 * the quick-selectors only BUILD a selection (they never decide), dismiss +
 * restore post the bulk endpoint, and tagging is handed up to the page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import NeedsTaggingPanel from '../../../app/components/home/NeedsTaggingPanel.vue'
import type { WorklistDay, WorklistSession } from '../../../shared/schemas/worklist'

const session = (id: string, cost: string): WorklistSession => ({
  session_id: id,
  instance_id: null,
  first_event: '2026-07-20T09:00:00.000Z',
  last_event: '2026-07-20T10:00:00.000Z',
  tokens: 25_000,
  cost_usd: cost,
  activity: null,
  tool: 'claude-code',
})
const day = (id: string, d: string, cost: string): WorklistDay => ({
  id,
  day: d,
  tool: 'copilot-cli',
  cost_usd: cost,
  tokens: 0,
})

const SESSIONS = [session('conv-big', '0.40'), session('conv-tiny', '0.01')]
const DAYS = [day('day-1', '2026-07-24', '38.84'), day('day-2', '2026-07-23', '0.69')]
const SUMMARY = {
  untagged_cost_usd: '39.94',
  needs_tagging_count: 4,
  needs_tagging_sessions: 2,
  needs_tagging_days: 2,
}

const global = {
  stubs: {
    UiCard: { template: '<div><slot /></div>' },
    UiEyebrow: { template: '<div><slot /></div>' },
    UiButton: { template: '<button v-bind="$attrs"><slot /></button>' },
    UsageModelBadge: { props: ['byModel'], template: '<span />' },
    Icon: { props: ['name'], template: '<i />' },
  },
}

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(NeedsTaggingPanel, {
    props: {
      sessions: SESSIONS,
      unaccounted: DAYS,
      dismissed: { sessions: [], unaccounted: [] },
      summary: SUMMARY,
      ...overrides,
    },
    global,
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ action: 'dismiss', total: 1 }))
})

describe('NeedsTaggingPanel — where the money actually is', () => {
  it('subtotals each group separately, so a $0.41 session list cannot outrank $39.53 of days', () => {
    const w = mountPanel()
    expect(w.find('[data-testid="sessions-subtotal"]').text()).toContain('$0.41')
    expect(w.find('[data-testid="days-subtotal"]').text()).toContain('$39.53')
  })

  it('counts items (not "sessions") and never claims a hidden tail that does not exist', () => {
    const w = mountPanel()
    // The header is now figures, not a sentence: the queue total and its count.
    expect(w.find('[data-testid="undecided-total"]').exists()).toBe(true)
    expect(w.text()).toContain('4 items')
    expect(w.text()).not.toContain('more this month not shown')
  })

  it('reports a genuine hidden tail per kind', () => {
    const w = mountPanel({ summary: { ...SUMMARY, needs_tagging_count: 9, needs_tagging_sessions: 7 } })
    expect(w.find('[data-testid="sessions-subtotal"]').element.parentElement?.textContent).toContain(
      '5 more this month not shown',
    )
  })
})

describe('NeedsTaggingPanel — selection', () => {
  it('select-all spans both kinds and totals the selection', async () => {
    const w = mountPanel()
    await w.find('[data-testid="worklist-select-all"]').setValue(true)
    expect(w.find('[data-testid="worklist-action-bar"]').text()).toContain('4 selected')
    expect(w.find('[data-testid="worklist-action-bar"]').text()).toContain('$39.94')
  })

  it('shows the header checkbox as indeterminate on a partial selection', async () => {
    // The dash state is a DOM PROPERTY, not an attribute — asserting it here is
    // what stops a binding regression from rendering a plain unchecked box that
    // silently claims "nothing selected" while the action bar says otherwise.
    const w = mountPanel()
    const all = w.find<HTMLInputElement>('[data-testid="worklist-select-all"]')
    expect(all.element.indeterminate).toBe(false)

    await w.find('[data-testid="select-conv-tiny"]').setValue(true)
    expect(all.element.indeterminate).toBe(true)
    expect(all.element.checked).toBe(false)

    await w.find('[data-testid="worklist-select-all"]').setValue(true)
    expect(all.element.indeterminate).toBe(false)
    expect(all.element.checked).toBe(true)
  })

  it('the de-minimis quick-selector only selects the small ones — it decides nothing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)
    const w = mountPanel()
    await w.find('[data-testid="worklist-select-small"]').trigger('click')
    // Only the $0.01 session is under the $0.10 line — the $0.69 day is not
    // swept up just because it is the smallest of its kind.
    expect(w.find('[data-testid="worklist-action-bar"]').text()).toContain('1 selected')
    expect(w.find('[data-testid="worklist-select-small"]').text()).toContain('Select the 1 under $0.10')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prunes selected items that a refresh retired, so the count never counts ghosts', async () => {
    const w = mountPanel()
    await w.find('[data-testid="worklist-select-all"]').setValue(true)
    await w.setProps({ sessions: [SESSIONS[0]], unaccounted: [] })
    await flushPromises()
    expect(w.find('[data-testid="worklist-action-bar"]').text()).toContain('1 selected')
  })
})

describe('NeedsTaggingPanel — decisions', () => {
  it('dismisses one session through the bulk endpoint and tells the page to refetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ action: 'dismiss', total: 1 })
    vi.stubGlobal('$fetch', fetchMock)
    const w = mountPanel()
    await w.find('[data-testid="dismiss-conv-tiny"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/me/worklist/bulk', {
      method: 'POST',
      body: { action: 'dismiss', sessions: ['conv-tiny'], unaccounted: [] },
    })
    expect(w.emitted('changed')).toHaveLength(1)
  })

  it('dismisses a whole selection in one call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ action: 'dismiss', total: 4 })
    vi.stubGlobal('$fetch', fetchMock)
    const w = mountPanel()
    await w.find('[data-testid="worklist-select-all"]').setValue(true)
    await w.find('[data-testid="worklist-dismiss-selected"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/me/worklist/bulk', {
      method: 'POST',
      body: { action: 'dismiss', sessions: ['conv-big', 'conv-tiny'], unaccounted: ['day-1', 'day-2'] },
    })
  })

  it('hands a bulk tag up to the page rather than saving it here', async () => {
    const w = mountPanel()
    await w.find('[data-testid="worklist-select-all"]').setValue(true)
    await w.find('[data-testid="worklist-tag-selected"]').trigger('click')
    expect(w.emitted('tagBulk')?.[0]?.[0]).toMatchObject({
      sessions: ['conv-big', 'conv-tiny'],
      unaccounted: ['day-1', 'day-2'],
      count: 4,
    })
  })

  it('surfaces a failed decision AND asks for a refetch, so a stale item cannot be retried forever', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ data: { detail: 'not yours' } }))
    const w = mountPanel()
    await w.find('[data-testid="dismiss-conv-tiny"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="worklist-error"]').text()).toContain('not yours')
    // A rejection usually means the card is stale (someone else tagged it). The
    // refetch is what removes the now-invalid item; without it the developer can
    // only click the same failing button again.
    expect(w.emitted('changed')).toHaveLength(1)
  })

  it('emits the single-item tag targets for the page dialog', async () => {
    const w = mountPanel()
    await w.find('[data-testid="tag-conv-big"]').trigger('click')
    await w.find('[data-testid="unaccounted-tag-day-1"]').trigger('click')
    expect(w.emitted('tagSession')?.[0]?.[0]).toMatchObject({ session_id: 'conv-big' })
    expect(w.emitted('tagDay')?.[0]?.[0]).toMatchObject({ id: 'day-1' })
  })
})

describe('NeedsTaggingPanel — an empty list is not automatically good news', () => {
  const empty = { sessions: [], unaccounted: [], dismissed: { sessions: [], unaccounted: [] } }

  it('congratulates only when the data actually arrived', () => {
    const w = mountPanel({ ...empty, summary: { ...SUMMARY, needs_tagging_count: 0 } })
    expect(w.find('[data-testid="worklist-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="worklist-unknown"]').exists()).toBe(false)
  })

  it('says it does not know when the worklist failed to load', () => {
    const w = mountPanel({ ...empty, summary: { ...SUMMARY, needs_tagging_count: 0 }, loadFailed: true })
    expect(w.find('[data-testid="worklist-empty"]').exists()).toBe(false)
    expect(w.find('[data-testid="worklist-unknown"]').text()).toContain('may be incomplete')
    expect(w.find('[data-testid="worklist-stale"]').exists()).toBe(false)
  })

  it('does not celebrate an empty queue while a rejected decision is on screen', async () => {
    // The shape reported from dev: a deploy invalidated the session, the dismiss
    // came back 401, the refetch returned nothing — and the card cheerfully said
    // everything was tagged.
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ data: { detail: 'Sign in to access this resource.' } }))
    const w = mountPanel()
    await w.find('[data-testid="dismiss-conv-tiny"]').trigger('click')
    await flushPromises()
    await w.setProps({ ...empty, summary: { ...SUMMARY, needs_tagging_count: 0 } })

    expect(w.find('[data-testid="worklist-error"]').text()).toContain('Sign in')
    expect(w.find('[data-testid="worklist-empty"]').exists()).toBe(false)
    // And it says the RIGHT thing. Suppressing the 🎉 was only half the job: the
    // fetch here SUCCEEDED, so blaming the load is a second false statement
    // replacing the first. Asserting only the absence of the celebration is what
    // let that through.
    expect(w.find('[data-testid="worklist-unknown"]').exists()).toBe(false)
    expect(w.find('[data-testid="worklist-stale"]').text()).toContain('may be out of date')
  })

  it('blames the load, not the last action, when BOTH have failed', async () => {
    // A load failure is the bigger unknown: if the list never arrived, "your
    // change didn't go through" understates it. Precedence is asserted so the
    // two branches cannot silently swap order.
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ data: { detail: 'nope' } }))
    const w = mountPanel()
    await w.find('[data-testid="dismiss-conv-tiny"]').trigger('click')
    await flushPromises()
    await w.setProps({ ...empty, summary: { ...SUMMARY, needs_tagging_count: 0 }, loadFailed: true })

    expect(w.find('[data-testid="worklist-unknown"]').exists()).toBe(true)
    expect(w.find('[data-testid="worklist-stale"]').exists()).toBe(false)
  })
})

describe('NeedsTaggingPanel — dismissed drawer', () => {
  const dismissed = { sessions: [session('conv-old', '0.02')], unaccounted: [day('day-9', '2026-07-01', '1.50')] }
  const dismissedSummary = SUMMARY

  it('keeps dismissals visible (and honest about the money) without putting them in the queue', async () => {
    const w = mountPanel({ dismissed, summary: dismissedSummary })
    expect(w.find('[data-testid="dismissed-section"]').exists()).toBe(false)
    // The pill describes the RESTORABLE set it opens — count and cost of the
    // items in the drawer, not a month figure the drawer doesn't contain.
    const toggle = w.find('[data-testid="dismissed-toggle"]')
    expect(toggle.text()).toContain('2 dismissed')
    expect(toggle.text()).toContain('$1.52')

    await toggle.trigger('click')
    expect(w.find('[data-testid="dismissed-section"]').text()).toContain('still unallocated')
    expect(w.find('[data-testid="dismissed-conv-old"]').exists()).toBe(true)
  })

  it('restores one item, and all of them', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ action: 'restore', total: 1 })
    vi.stubGlobal('$fetch', fetchMock)
    const w = mountPanel({ dismissed, summary: dismissedSummary })
    await w.find('[data-testid="dismissed-toggle"]').trigger('click')

    await w.find('[data-testid="restore-conv-old"]').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/me/worklist/bulk', {
      method: 'POST',
      body: { action: 'restore', sessions: ['conv-old'], unaccounted: [] },
    })

    await w.find('[data-testid="restore-all"]').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/me/worklist/bulk', {
      method: 'POST',
      body: { action: 'restore', sessions: ['conv-old'], unaccounted: ['day-9'] },
    })
  })
})

describe('NeedsTaggingPanel — the queue is shown, not described', () => {
  /*
   * This header used to be a month-scoped figure plus a 32-word byline carrying
   * four numbers, so "how much is undecided" and "how much of it is old" both
   * had to be assembled out of prose. It is now the queue total and a two-part
   * split. These assert the SHAPE, which is what changed.
   */
  it('leads with the whole queue, not the month', () => {
    const w = mountPanel()
    // $39.94 listed across 4 items — the queue, not summary.untagged_cost_usd.
    expect(w.find('[data-testid="undecided-total"]').text()).toBe('$39.94')
    expect(w.text()).toContain('4 items')
  })

  it('splits this month from the backlog, as figures', () => {
    const w = mountPanel({
      summary: {
        ...SUMMARY,
        untagged_cost_usd: '2.00',
        needs_tagging_count: 1,
        needs_tagging_sessions: 1,
        needs_tagging_days: 0,
      },
    })
    const split = w.find('[data-testid="undecided-split"]').text()
    expect(split).toContain('This month')
    expect(split).toContain('$2.00')
    expect(split).toContain('Earlier months')
    expect(split).toContain('$37.94')   // 39.94 listed - 2.00 this month
    expect(split).toContain('3')        // 4 listed - 1 this month
  })

  it('says nothing about a backlog when the list holds only this month', () => {
    const w = mountPanel()
    expect(w.find('[data-testid="undecided-older"]').exists()).toBe(false)
  })

  it('drops the instruction that the row buttons already carry', () => {
    const w = mountPanel()
    expect(w.text()).not.toContain('Tag to a budget or an activity')
    expect(w.text()).not.toContain('dismissed spend stays unallocated')
  })
})
