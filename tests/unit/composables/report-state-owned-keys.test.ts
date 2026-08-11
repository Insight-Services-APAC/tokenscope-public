// @vitest-environment happy-dom
/*
 * THE OWNED-KEY SET — the cross-slice seam W2 and W3 both flagged, closed in W4.
 *
 * `/usage`, `/projects` and `/projects/[code]` mount `DateRangeControl` for its
 * window presets, and that control self-wires to `useReportState` (zero props,
 * by design). `patch()` used to write its WHOLE owned key set on every call, so
 * one preset click stamped `?scope=region` onto a developer-page URL:
 *
 *   - no endpoint on those pages reads `scope`;
 *   - no control on those pages can clear it;
 *   - shared or bookmarked, the URL then carried a REPORTS claim the page never
 *     made — and `parseReportQuery` would happily parse it back.
 *
 * The fix is a declared ownership set per page, injected so the self-wiring
 * control resolves the SAME ownership the page declared. This file pins both
 * directions: the reporting shell still writes `scope`, and a window-scoped page
 * never mints it — nor any other shell key.
 *
 * MUTATIONS this pins:
 *  - drop the `ownedKeys` filter in patch()   → the developer-page tests go red;
 *  - default `ownedKeys` to WINDOW_STATE_KEYS → the reporting-shell test goes red;
 *  - add `scope` to WINDOW_STATE_KEYS         → the developer-page tests go red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import { mount } from '@vue/test-utils'
import {
  REPORT_STATE_KEYS,
  WINDOW_STATE_KEYS,
  provideReportStateKeys,
  useReportState,
} from '../../../app/composables/useReportState'

const route = reactive<{ query: Record<string, string> }>({ query: {} })
const router = {
  replace: ({ query }: { query: Record<string, string> }) => {
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) next[k] = v as string
    route.query = next
  },
}

beforeEach(() => {
  route.query = {}
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useRouter', () => router)
})
afterEach(() => vi.unstubAllGlobals())

/**
 * A page that declares an ownership set, with a CHILD that self-wires to the
 * state exactly as `DateRangeControl` does — the shape the seam actually took.
 */
function mountPageWithSelfWiringChild(keys: readonly (typeof REPORT_STATE_KEYS)[number][] | null) {
  const captured: { patch?: (p: Record<string, unknown>) => void } = {}
  const Child = defineComponent({
    setup() {
      const rs = useReportState()
      captured.patch = rs.patch as unknown as (p: Record<string, unknown>) => void
      return () => h('div')
    },
  })
  const Page = defineComponent({
    setup() {
      if (keys) provideReportStateKeys(keys)
      useReportState()
      return () => h(Child)
    },
  })
  mount(Page)
  return captured
}

describe('the developer pages own the WINDOW, never the reporting shell keys', () => {
  it('a window preset does NOT mint ?scope= on a developer page', () => {
    const c = mountPageWithSelfWiringChild([...WINDOW_STATE_KEYS])
    // Exactly what DateRangeControl's "Last month" preset does.
    c.patch!({ month: '2026-07', from: null, to: null })
    expect(route.query).toEqual({ month: '2026-07' })
    expect(route.query.scope).toBeUndefined()
  })

  it('no shell key is minted by any window patch — scope/lane/region/ou/cc all stay out', () => {
    const c = mountPageWithSelfWiringChild([...WINDOW_STATE_KEYS])
    c.patch!({ from: '2026-07-01', to: '2026-07-15', month: null })
    expect(Object.keys(route.query).sort()).toEqual(['from', 'to'])
  })

  it('a FOREIGN key already in the URL is preserved, never rewritten', () => {
    // `?lane=` belongs to usePersonalLens on `/usage`; patch must not touch it.
    route.query = { lane: 'chargeback', window: '30' }
    const c = mountPageWithSelfWiringChild([...WINDOW_STATE_KEYS])
    c.patch!({ month: '2026-07' })
    expect(route.query).toEqual({ lane: 'chargeback', window: '30', month: '2026-07' })
  })

  it('the drill FRAME is owned by a developer page — it is how a drill target keeps its scope', () => {
    const c = mountPageWithSelfWiringChild([...WINDOW_STATE_KEYS])
    c.patch!({ src: 'cc:c1', month: '2026-07' })
    expect(route.query).toEqual({ src: 'cc:c1', month: '2026-07' })
  })
})

describe('the reporting shell still owns everything — unchanged', () => {
  it('with no declaration, patch() writes the full key set (today’s behaviour)', () => {
    const c = mountPageWithSelfWiringChild(null)
    c.patch!({ month: '2026-07' })
    expect(route.query.scope).toBe('region')
    expect(route.query.month).toBe('2026-07')
  })

  it('a shell patch still drops the sub-scope keys it clears', () => {
    route.query = { scope: 'region', region: 'r1', ou: 'o1', month: '2026-07' }
    const c = mountPageWithSelfWiringChild(null)
    c.patch!({ scope: 'finance', region: null, ou: null, month: null })
    expect(route.query).toEqual({ scope: 'finance' })
  })

  it('WINDOW_STATE_KEYS is a strict SUBSET of the full set, and excludes `scope`', () => {
    for (const k of WINDOW_STATE_KEYS) expect(REPORT_STATE_KEYS).toContain(k)
    expect(WINDOW_STATE_KEYS).not.toContain('scope')
    expect(WINDOW_STATE_KEYS.length).toBeLessThan(REPORT_STATE_KEYS.length)
  })
})
