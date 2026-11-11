// @vitest-environment happy-dom
/*
 * The inbox page's bulk actions and older pages (#574, #569), from the external
 * review of round 2 sprint 1:
 *   - a selection past the route's 200-id limit goes in chunks, not a 400;
 *   - a "Load more" answer that arrives after the list was reloaded is dropped,
 *     never appended as duplicates;
 *   - "Mark all N read" names the server's unread count and posts the filters.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import InboxPage from '../../../app/pages/inbox.vue'
import type { InboxItem } from '../../../app/components/inbox/types'

const PASS = { template: '<div><slot /><slot name="actions" /></div>' }
const STUBS = {
  UiPageHead: { template: '<header><slot name="actions" /></header>' },
  UiCard: PASS,
  UiEmptyState: { props: ['headline'], template: '<div>{{ headline }}<slot /></div>' },
  UiBadge: { template: '<span><slot /></span>' },
  UiButton: { template: '<button><slot /></button>' },
  InboxFilterBar: true,
  InboxDrawer: true,
  NuxtLink: { template: '<a><slot /></a>' },
}

const item = (n: number): InboxItem => ({
  id: `9a1e0000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  category: 'went-silent',
  severity: 'attention',
  subject: `Item ${n}`,
  body: {},
  related_entity_kind: null,
  related_entity_id: null,
  ack_state: 'unread',
  ack_at: null,
  created_at: '2026-11-10T00:00:00Z',
  target_allocation_id: null,
  target_project_code: null,
})

function stubPage(first: { items: InboxItem[]; total: number; next_cursor?: string | null }, unreadTotal: number) {
  const refresh = vi.fn(async () => {})
  vi.stubGlobal('useFetch', (url: unknown) => {
    const u = typeof url === 'string' ? url : (url as { value: string }).value
    const data = u.includes('ack_state=unread&limit=1') ? { total: unreadTotal } : first
    return { data: ref(data), error: ref(null), pending: ref(false), refresh }
  })
  vi.stubGlobal('refreshNuxtData', vi.fn())
  vi.stubGlobal('fmtTimeAgo', () => 'just now')
  return refresh
}
async function mountPage() {
  const Parent = defineComponent({ components: { Page: InboxPage as never }, template: '<Suspense><Page /></Suspense>' })
  const w = mount(Parent, { global: { stubs: STUBS, mocks: { fmtTimeAgo: () => 'just now' } } })
  await flushPromises()
  return w
}

enableAutoUnmount(afterEach)
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('inbox bulk actions', () => {
  it('a selection of 250 goes to the bulk route in chunks of 200 and 50', async () => {
    const items = Array.from({ length: 250 }, (_, i) => item(i + 1))
    stubPage({ items, total: 250 }, 250)
    const calls: { ids: string[]; ack_state: string }[] = []
    vi.stubGlobal('$fetch', vi.fn(async (_url: string, opts: { body: { ids: string[]; ack_state: string } }) => {
      calls.push(opts.body)
      return { changed: opts.body.ids.length, not_changed: [] }
    }))
    const w = await mountPage()
    await w.find('[data-testid="inbox-select-all"]').setValue(true)
    expect(w.find('[data-testid="inbox-selected-count"]').text()).toBe('250 selected')
    await w.find('[data-testid="inbox-bulk-resolve"]').trigger('click')
    await flushPromises()
    expect(calls.map((c) => c.ids.length)).toEqual([200, 50])
    expect(calls.every((c) => c.ack_state === 'resolved')).toBe(true)
    expect(new Set(calls.flatMap((c) => c.ids)).size).toBe(250)
    expect(w.find('[data-testid="inbox-selected-count"]').text()).toBe('Select all shown')
  })

  it('focus returns to Select all shown after a bulk action', async () => {
    stubPage({ items: [item(1), item(2)], total: 2 }, 2)
    vi.stubGlobal('$fetch', vi.fn(async () => ({ changed: 1, not_changed: [] })))
    const Parent = defineComponent({ components: { Page: InboxPage as never }, template: '<Suspense><Page /></Suspense>' })
    const w = mount(Parent, { global: { stubs: STUBS, mocks: { fmtTimeAgo: () => 'just now' } }, attachTo: document.body })
    await flushPromises()
    await w.findAll('[data-testid="inbox-row-select"]')[0]!.setValue(true)
    await w.find('[data-testid="inbox-bulk-dismiss"]').trigger('click')
    await flushPromises()
    expect(document.activeElement?.getAttribute('data-testid')).toBe('inbox-select-all')
    w.unmount()
  })

  it('a Load more and a reload never append the same page twice', async () => {
    const first = Array.from({ length: 50 }, (_, i) => item(i + 1))
    stubPage({ items: first, total: 60, next_cursor: 'c1' }, 60)
    const older = { items: Array.from({ length: 10 }, (_, i) => item(51 + i)), total: 60, next_cursor: null }
    let releaseOlder: (v: unknown) => void = () => {}
    let olderCalls = 0
    vi.stubGlobal('$fetch', vi.fn((url: string) => {
      if (url.includes('cursor=')) {
        olderCalls += 1
        // The first older page is slow; the reload's replay of it is not.
        return olderCalls === 1 ? new Promise((r) => { releaseOlder = r }) : Promise.resolve(older)
      }
      return Promise.resolve({ changed: 1, not_changed: [] })
    }))
    const w = await mountPage()
    await w.find('[data-testid="inbox-load-more"]').trigger('click')
    // An action reloads the list while the older page is still in flight.
    await w.findAll('[data-testid="inbox-row-select"]')[0]!.setValue(true)
    await w.find('[data-testid="inbox-bulk-read"]').trigger('click')
    await flushPromises()
    releaseOlder(older)
    await flushPromises()
    await flushPromises()
    const subjects = w.findAll('[data-testid="inbox-row-select"]').map((r) => r.attributes('aria-label'))
    expect(subjects).toHaveLength(60)
    expect(new Set(subjects).size).toBe(60)
  })

  it('an item on an older page stays listed while the list reloads after an action', async () => {
    const first = Array.from({ length: 50 }, (_, i) => item(i + 1))
    stubPage({ items: first, total: 60, next_cursor: 'c1' }, 60)
    const older = { items: Array.from({ length: 10 }, (_, i) => item(51 + i)), total: 60, next_cursor: null }
    let replayRelease: (v: unknown) => void = () => {}
    let olderCalls = 0
    vi.stubGlobal('$fetch', vi.fn((url: string) => {
      if (url.includes('cursor=')) {
        olderCalls += 1
        return olderCalls === 1 ? Promise.resolve(older) : new Promise((r) => { replayRelease = r })
      }
      return Promise.resolve({ changed: 1, not_changed: [] })
    }))
    const w = await mountPage()
    await w.find('[data-testid="inbox-load-more"]').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-testid="inbox-row-select"]')).toHaveLength(60)
    // Act on row 55 (an older page); while the replay is in flight it stays.
    await w.findAll('[data-testid="inbox-row-select"]')[54]!.setValue(true)
    await w.find('[data-testid="inbox-bulk-read"]').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-testid="inbox-row-select"]')).toHaveLength(60)
    replayRelease(older)
    await flushPromises()
    expect(w.findAll('[data-testid="inbox-row-select"]')).toHaveLength(60)
  })

  it('a failed replay drops the older pages and says so, instead of keeping stale rows', async () => {
    const first = Array.from({ length: 50 }, (_, i) => item(i + 1))
    stubPage({ items: first, total: 60, next_cursor: 'c1' }, 60)
    const older = { items: Array.from({ length: 10 }, (_, i) => item(51 + i)), total: 60, next_cursor: null }
    let olderCalls = 0
    vi.stubGlobal('$fetch', vi.fn((url: string) => {
      if (url.includes('cursor=')) {
        olderCalls += 1
        return olderCalls === 1 ? Promise.resolve(older) : Promise.reject(new TypeError('Failed to fetch'))
      }
      return Promise.resolve({ changed: 1, not_changed: [] })
    }))
    const w = await mountPage()
    await w.find('[data-testid="inbox-load-more"]').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-testid="inbox-row-select"]')).toHaveLength(60)
    await w.findAll('[data-testid="inbox-row-select"]')[0]!.setValue(true)
    await w.find('[data-testid="inbox-bulk-read"]').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-testid="inbox-row-select"]')).toHaveLength(50)
    expect(w.find('[data-testid="inbox-toast-err"]').text()).toContain('Older items did not reload')
    expect(w.find('[data-testid="inbox-load-more"]').exists()).toBe(true)
  })

  it('"Mark all N read" names the server count and posts the filters, not ids', async () => {
    stubPage({ items: [item(1)], total: 1 }, 12)
    const post = vi.fn(async () => ({ changed: 12, not_changed: [] }))
    vi.stubGlobal('$fetch', post)
    const w = await mountPage()
    const btn = w.find('[data-testid="inbox-mark-all-read"]')
    expect(btn.text()).toBe('Mark all 12 read')
    await btn.trigger('click')
    await flushPromises()
    expect(post).toHaveBeenCalledWith('/api/v1/me/inbox/bulk', { method: 'POST', body: { ack_state: 'read', all_unread: {} } })
  })

  it('there is no Mark all read when nothing matching is unread', async () => {
    stubPage({ items: [item(1)], total: 1 }, 0)
    vi.stubGlobal('$fetch', vi.fn())
    const w = await mountPage()
    expect(w.find('[data-testid="inbox-mark-all-read"]').exists()).toBe(false)
  })
})
