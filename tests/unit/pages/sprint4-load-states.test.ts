// @vitest-environment happy-dom
/*
 * Two pages that used to read a failure as an answer (#547, #548).
 *
 *   /allocations/{id}: not found only for a real 404 (which the route also
 *     answers for an id outside your scope), "no access" for a 403, the
 *     server's reason for another refusal, and an error with Retry when there
 *     was no answer. Before, all four read "Allocation not found".
 *   /usage/playbook: a status line while the 30-day check runs; on failure an
 *     error line whose Retry re-runs the check and NO "observed" badge; on
 *     success, the badges as before. The levers always show.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import AllocationPage from '../../../app/pages/allocations/[id].vue'
import PlaybookPage from '../../../app/pages/usage/playbook.vue'

const ALLOC_ID = '9a1e0000-0000-4000-8000-0000000000d1'
const NOT_FOUND = { statusCode: 404, data: { statusMessage: 'Allocation not found' }, message: '[GET] 404' }
const FORBIDDEN = { statusCode: 403, data: { statusMessage: 'Forbidden' }, message: '[GET] 403 Forbidden' }
const BAD_REQUEST = { statusCode: 400, data: { data: { detail: 'The id is not a budget.' } } }
const SERVER_ERROR = { statusCode: 500, data: null, message: '[GET] 500 Internal Server Error' }
const NETWORK = new TypeError('Failed to fetch')

const PASS = { template: '<div><slot /><slot name="actions" /></div>' }
const STUBS = {
  UiPageHead: PASS,
  UiCard: PASS,
  UiEyebrow: PASS,
  UiBreadcrumb: true,
  UiBadge: { template: '<span><slot /></span>' },
  UiButton: { template: '<button type="button"><slot /></button>' },
  AllocatorModeToggle: true,
  DevChipPicker: true,
  TopupLog: true,
  ConsumptionCard: true,
  NuxtLink: { props: ['to'], template: '<a><slot /></a>' },
}

function stubCommon() {
  vi.stubGlobal('useRoute', () => ({ params: { id: ALLOC_ID }, query: {} }))
  vi.stubGlobal('useSession', () => ({
    session: ref({ teammateId: '9a1e0000-0000-4000-8000-0000000000c1', role: 'developer', regionId: 'r' }),
    ensure: async () => {},
  }))
  vi.stubGlobal('definePageMeta', () => {})
  vi.stubGlobal('useDebouncedSearch', () => ({ query: ref(''), results: ref([]), loading: ref(false), error: ref(null), run: vi.fn(), clear: vi.fn() }))
}

/** The first useFetch a page makes gets `answer`; the rest answer nothing. */
/*
 * The first useFetch a page makes gets `answer`; the rest answer nothing.
 * Its refresh behaves like Nuxt's on a retry: pending goes true while the
 * PREVIOUS error is still set, so a test can see what the reader sees then.
 */
function stubFetch(answer: { data?: unknown; error?: unknown; pending?: boolean }) {
  const refresh = vi.fn()
  let first = true
  vi.stubGlobal('useFetch', (_url: unknown, opts?: { default?: () => unknown }) => {
    const mine = first
    first = false
    const fallback = opts?.default ? opts.default() : null
    const pending = ref(mine ? (answer.pending ?? false) : false)
    if (mine) refresh.mockImplementation(() => { pending.value = true })
    return {
      data: ref(mine ? (answer.data ?? fallback) : fallback),
      error: ref(mine ? (answer.error ?? null) : null),
      pending,
      refresh: mine ? refresh : vi.fn(),
    }
  })
  return refresh
}

async function mountPage(page: unknown) {
  const Parent = defineComponent({ components: { Page: page as never }, template: '<Suspense><Page /></Suspense>' })
  const w = mount(Parent, { global: { stubs: STUBS } })
  await flushPromises()
  return w
}

enableAutoUnmount(afterEach)
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/allocations/{id}: not found, refused and failed are different answers', () => {
  it('a 404 is "Allocation not found"', async () => {
    stubCommon()
    stubFetch({ error: NOT_FOUND })
    const w = await mountPage(AllocationPage)
    expect(w.find('[data-testid="alloc-not-found"]').text()).toContain('Allocation not found.')
    expect(w.find('[data-testid="alloc-refused"]').exists()).toBe(false)
    expect(w.find('[data-testid="alloc-failed"]').exists()).toBe(false)
  })

  it('a 403 says the reader has no access, never "not found"', async () => {
    stubCommon()
    stubFetch({ error: FORBIDDEN })
    const w = await mountPage(AllocationPage)
    expect(w.find('[data-testid="alloc-refused"]').text()).toContain("You don't have access to this budget.")
    expect(w.text()).not.toContain('Allocation not found')
  })

  it('another refusal quotes the server\'s reason', async () => {
    stubCommon()
    stubFetch({ error: BAD_REQUEST })
    const w = await mountPage(AllocationPage)
    expect(w.find('[data-testid="alloc-refused"]').text()).toContain('Reason given: The id is not a budget.')
    expect(w.text()).not.toContain('Allocation not found')
  })

  it.each([['a 5xx', SERVER_ERROR], ['no answer', NETWORK]])('%s is an error with a working Retry', async (_name, err) => {
    stubCommon()
    const refresh = stubFetch({ error: err })
    const w = await mountPage(AllocationPage)
    expect(w.find('[data-testid="alloc-failed"]').text()).toContain("This budget didn't load.")
    expect(w.text()).not.toContain('Allocation not found')
    await w.find('[data-testid="alloc-retry"]').trigger('click')
    expect(refresh).toHaveBeenCalled()
    // While the retry runs the page says it is loading, not the old failure.
    expect(w.text()).toContain('Loading allocation')
    expect(w.find('[data-testid="alloc-failed"]').exists()).toBe(false)
  })
})

describe('/allocations/{id}: a Retry that succeeds loads the consumption too', () => {
  it('starts the consumption read once the project id arrives', async () => {
    stubCommon()
    vi.stubGlobal('$fetch', vi.fn(async () => ({})))
    const PROJECT = '9a1e0000-0000-4000-8000-0000000000e1'
    const detail = {
      focused: {
        id: ALLOC_ID, scope_type: 'project', scope_id: PROJECT, budget_usd: '100.00',
        effective: '[2026-11-01,)', effective_from: '2026-11-01T00:00:00Z', effective_to: null,
        allocation_kind: 'baseline', allocation_mode: 'shared_pool', source: 'manual', is_pinned: false,
        project_id: PROJECT, project_code: 'FALCON', project_display_name: 'Project Falcon',
        region_code: 'apac', cou_code: 'cto', cou_display_name: 'CTO Office',
      },
      siblings: [], devs: [], topups: [], per_dev_caps: [], audit: [],
    }
    // First read: the allocation fails. Second: consumption, idle (no project id yet).
    const alloc = { data: ref<unknown>(null), error: ref<unknown>(SERVER_ERROR), pending: ref(false) }
    const consumptionExecute = vi.fn(async () => {})
    let call = 0
    vi.stubGlobal('useFetch', (_url: unknown, opts?: { default?: () => unknown }) => {
      call++
      if (call === 1) {
        return {
          ...alloc,
          refresh: vi.fn(async () => {
            alloc.data.value = detail
            alloc.error.value = null
          }),
        }
      }
      return {
        data: ref(opts?.default ? opts.default() : null),
        error: ref(null),
        pending: ref(false),
        refresh: vi.fn(),
        execute: call === 2 ? consumptionExecute : vi.fn(),
      }
    })
    const w = await mountPage(AllocationPage)
    expect(w.find('[data-testid="alloc-failed"]').exists()).toBe(true)
    expect(consumptionExecute).not.toHaveBeenCalled()
    await w.find('[data-testid="alloc-retry"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="alloc-failed"]').exists()).toBe(false)
    expect(consumptionExecute).toHaveBeenCalledTimes(1)
  })
})

describe('/allocations/{id}: the spend card never shows $0.00 for an unknown figure', () => {
  const PROJECT = '9a1e0000-0000-4000-8000-0000000000e2'
  const detail = {
    focused: {
      id: ALLOC_ID, scope_type: 'project', scope_id: PROJECT, budget_usd: '100.00',
      effective: '[2026-11-01,)', effective_from: '2026-11-01T00:00:00Z', effective_to: null,
      allocation_kind: 'baseline', allocation_mode: 'shared_pool', source: 'manual', is_pinned: false,
      project_id: PROJECT, project_code: 'FALCON', project_display_name: 'Project Falcon',
      region_code: 'apac', cou_code: 'cto', cou_display_name: 'CTO Office',
    },
    siblings: [], devs: [], topups: [], per_dev_caps: [], audit: [],
  }

  /** The allocation loads; the consumption read answers with `spend`. */
  function stubSpend(spend: { error?: unknown; pending?: boolean }) {
    const execute = vi.fn(async () => {})
    let call = 0
    vi.stubGlobal('useFetch', (_url: unknown, opts?: { default?: () => unknown }) => {
      call++
      if (call === 1) {
        return { data: ref(detail), error: ref(null), pending: ref(false), refresh: vi.fn(), execute: vi.fn() }
      }
      return {
        data: ref(opts?.default ? opts.default() : null),
        error: ref(call === 2 ? spend.error ?? null : null),
        pending: ref(call === 2 ? spend.pending ?? false : false),
        refresh: vi.fn(),
        execute: call === 2 ? execute : vi.fn(),
      }
    })
    return execute
  }

  it.each([
    ['a 5xx', SERVER_ERROR],
    ['no answer', NETWORK],
  ])('%s: says the spend did not load, with Try again, and no figure', async (_label, err) => {
    stubCommon()
    vi.stubGlobal('$fetch', vi.fn(async () => ({})))
    const execute = stubSpend({ error: err })
    const w = await mountPage(AllocationPage)
    const failed = w.find('[data-testid="consumption-failed"]')
    expect(failed.text()).toContain("This project's spend didn't load.")
    expect(failed.attributes('role')).toBe('alert')
    expect(w.findComponent({ name: 'ConsumptionCard' }).exists()).toBe(false)
    await w.find('[data-testid="consumption-retry"]').trigger('click')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('while loading: a status line, and no figure', async () => {
    stubCommon()
    vi.stubGlobal('$fetch', vi.fn(async () => ({})))
    stubSpend({ pending: true })
    const w = await mountPage(AllocationPage)
    expect(w.find('[data-testid="consumption-loading"] [role="status"]').text()).toContain("Loading this project's spend")
    expect(w.findComponent({ name: 'ConsumptionCard' }).exists()).toBe(false)
  })

  // Nuxt keeps the previous error while Try again runs: the card shows the retry, not the old failure.
  it('a retry in flight reads as loading, even with the last error still set', async () => {
    stubCommon()
    vi.stubGlobal('$fetch', vi.fn(async () => ({})))
    stubSpend({ error: SERVER_ERROR, pending: true })
    const w = await mountPage(AllocationPage)
    expect(w.find('[data-testid="consumption-loading"]').exists()).toBe(true)
    expect(w.find('[data-testid="consumption-failed"]').exists()).toBe(false)
  })

  it('a refusal says the server refused, with its reason, not that it did not answer', async () => {
    stubCommon()
    vi.stubGlobal('$fetch', vi.fn(async () => ({})))
    stubSpend({ error: BAD_REQUEST })
    const w = await mountPage(AllocationPage)
    const refused = w.find('[data-testid="consumption-refused"]')
    expect(refused.text()).toContain("The server refused to show this project's spend.")
    expect(refused.text()).toContain('Reason given: The id is not a budget.')
    expect(w.find('[data-testid="consumption-failed"]').exists()).toBe(false)
    expect(w.findComponent({ name: 'ConsumptionCard' }).exists()).toBe(false)
  })

  it('once loaded: the figure, and neither line', async () => {
    stubCommon()
    vi.stubGlobal('$fetch', vi.fn(async () => ({})))
    stubSpend({})
    const w = await mountPage(AllocationPage)
    expect(w.findComponent({ name: 'ConsumptionCard' }).exists()).toBe(true)
    expect(w.find('[data-testid="consumption-failed"]').exists()).toBe(false)
    expect(w.find('[data-testid="consumption-loading"]').exists()).toBe(false)
  })
})

describe('/usage/playbook: the 30-day check has three answers', () => {
  const INSIGHTS = { insights: [{ related_levers: ['R1'] }] }

  it('while checking: one status line and no badge', async () => {
    stubCommon()
    stubFetch({ data: null, pending: true })
    const w = await mountPage(PlaybookPage)
    expect(w.findAll('[data-testid="playbook-checking"]')).toHaveLength(1)
    expect(w.find('[data-testid="playbook-checking"]').attributes('role')).toBe('status')
    expect(w.find('[data-testid="observed-R1"]').exists()).toBe(false)
    expect(w.find('[data-testid="lever-R1"]').exists()).toBe(true)
  })

  it('failed: an error line with a working Retry, and no "observed" badge even with stale data', async () => {
    stubCommon()
    const refresh = stubFetch({ data: INSIGHTS, error: SERVER_ERROR })
    const w = await mountPage(PlaybookPage)
    expect(w.find('[data-testid="playbook-check-error"]').text()).toContain("We couldn't check your last 30 days")
    expect(w.find('[data-testid="playbook-check-error"]').attributes('role')).toBe('alert')
    expect(w.find('[data-testid^="observed-"]').exists()).toBe(false)
    expect(w.find('[data-testid="lever-R1"]').exists()).toBe(true)
    await w.find('[data-testid="playbook-check-retry"]').trigger('click')
    expect(refresh).toHaveBeenCalled()
    // Nuxt keeps the old error during the retry: the reader sees the check running.
    expect(w.find('[data-testid="playbook-checking"]').exists()).toBe(true)
    expect(w.find('[data-testid="playbook-check-error"]').exists()).toBe(false)
  })

  it('landed: the badges, and neither the status line nor the error', async () => {
    stubCommon()
    stubFetch({ data: INSIGHTS })
    const w = await mountPage(PlaybookPage)
    expect(w.find('[data-testid="observed-R1"]').text()).toBe('observed in your usage')
    expect(w.find('[data-testid="playbook-checking"]').exists()).toBe(false)
    expect(w.find('[data-testid="playbook-check-error"]').exists()).toBe(false)
  })
})
