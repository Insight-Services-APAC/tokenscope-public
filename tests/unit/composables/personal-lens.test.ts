// @vitest-environment happy-dom
/*
 * The lens plumbing the personal surfaces sit on (ADR 0012):
 *
 *   - `parseSpendLens` — one validator for an untrusted lane, in the URL and in
 *     the request query alike;
 *   - `usePersonalLens` — the personal surfaces' owner of `?lane=`, which must
 *     NOT be `useReportState` (that composable writes the whole reporting query
 *     and would stamp `scope=region` onto a dashboard URL);
 *   - `useRefreshOnVisible` — the month-boundary staleness fix, extracted from
 *     UiBuildStamp so there is one mechanism rather than two.
 */
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, ref, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { parseSpendLens, SPEND_LENSES, PERSONAL_LENS_COPY } from '../../../shared/usage/lens'
import { usePersonalLens } from '../../../app/composables/usePersonalLens'
import { useRefreshOnVisible } from '../../../app/composables/useRefreshOnVisible'

describe('parseSpendLens', () => {
  it('accepts the two lenses and nothing else', () => {
    expect(parseSpendLens('usage')).toBe('usage')
    expect(parseSpendLens('chargeback')).toBe('chargeback')
    expect(SPEND_LENSES).toEqual(['usage', 'chargeback'])
  })

  it('falls back rather than throwing — a hand-typed ?lane must not 500 a dashboard', () => {
    expect(parseSpendLens('showback')).toBe('usage')
    expect(parseSpendLens(undefined)).toBe('usage')
    expect(parseSpendLens(null)).toBe('usage')
    expect(parseSpendLens(42)).toBe('usage')
    expect(parseSpendLens({ lane: 'chargeback' })).toBe('usage')
  })

  it('takes the first value of a repeated query key', () => {
    expect(parseSpendLens(['chargeback', 'usage'])).toBe('chargeback')
    expect(parseSpendLens([])).toBe('usage')
  })

  it('honours an explicit fallback', () => {
    expect(parseSpendLens('nonsense', 'chargeback')).toBe('chargeback')
  })

  it('every lens has copy that NAMES it — decision 3 is copy, not a tooltip', () => {
    for (const lens of SPEND_LENSES) {
      const copy = PERSONAL_LENS_COPY[lens]
      expect(copy.basis.length).toBeGreaterThan(0)
      expect(copy.caption.length).toBeGreaterThan(0)
      // The basis clause under the figure says which quantity it is.
      expect(copy.basis).toContain(lens === 'usage' ? 'attributed usage' : 'chargeback')
    }
  })
})

/** Mounts a component that reads the lens, with a stubbed router/route. */
function mountWithLens(initialQuery: Record<string, string> = {}) {
  const query = ref<Record<string, string>>({ ...initialQuery })
  const replace = vi.fn((to: { query: Record<string, string> }) => {
    query.value = { ...to.query }
  })
  vi.stubGlobal('useRoute', () => ({
    get query() {
      return query.value
    },
  }))
  vi.stubGlobal('useRouter', () => ({ replace }))
  let lens!: ReturnType<typeof usePersonalLens>
  const C = defineComponent({
    setup() {
      lens = usePersonalLens()
      return () => h('div', lens.value)
    },
  })
  const w = mount(C)
  return { w, query, replace, lens: () => lens }
}

describe('usePersonalLens — owns ?lane= and nothing else', () => {
  it('reads the lane from the URL, defaulting to usage', () => {
    expect(mountWithLens().lens().value).toBe('usage')
    expect(mountWithLens({ lane: 'chargeback' }).lens().value).toBe('chargeback')
    expect(mountWithLens({ lane: 'garbage' }).lens().value).toBe('usage')
    vi.unstubAllGlobals()
  })

  it('persists only chargeback — usage is the default and stays out of the URL', () => {
    const { lens, query } = mountWithLens()
    lens().value = 'chargeback'
    expect(query.value.lane).toBe('chargeback')
    lens().value = 'usage'
    expect('lane' in query.value).toBe(false)
    vi.unstubAllGlobals()
  })

  it('never writes a report scope onto a personal URL', () => {
    /*
     * The reason this is not useReportState: that composable's patch() always
     * writes `scope`, which defaults to 'across'. Flipping the lens on the
     * dashboard must not leave `?scope=region` behind.
     */
    const { lens, replace } = mountWithLens()
    lens().value = 'chargeback'
    const written = replace.mock.calls[0]![0].query
    expect(Object.keys(written)).toEqual(['lane'])
    vi.unstubAllGlobals()
  })

  it('preserves unrelated query keys', () => {
    const { lens, query } = mountWithLens({ window: '90' })
    lens().value = 'chargeback'
    expect(query.value.window).toBe('90')
    expect(query.value.lane).toBe('chargeback')
    vi.unstubAllGlobals()
  })
})

describe('useRefreshOnVisible — the month-boundary staleness fix', () => {
  const mountWatcher = () => {
    const refresh = vi.fn()
    const C = defineComponent({
      setup() {
        useRefreshOnVisible(refresh)
        return () => h('div')
      },
    })
    return { refresh, w: mount(C) }
  }

  function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  it('re-reads when the tab becomes visible again', async () => {
    /*
     * The bug: both personal screens showed "July 2026 · day 31 of 31" at 06:27
     * on 1 August. The month is resolved from the SERVER clock at fetch time
     * and useFetch then caches, so a tab left open across the boundary keeps a
     * month that has ended — and every figure under it.
     */
    const { refresh } = mountWatcher()
    expect(refresh).not.toHaveBeenCalled()
    setVisibility('visible')
    await nextTick()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does NOT re-read when the tab is being hidden', async () => {
    const { refresh } = mountWatcher()
    setVisibility('hidden')
    await nextTick()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('detaches on unmount — no listener outliving the page', async () => {
    const { refresh, w } = mountWatcher()
    w.unmount()
    setVisibility('visible')
    await nextTick()
    expect(refresh).not.toHaveBeenCalled()
  })
})
