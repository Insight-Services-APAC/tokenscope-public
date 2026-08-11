// @vitest-environment happy-dom
/*
 * `?src=` — the drill scope token (developer pages build D16/D30, T13).
 *
 * The brief's illustrative `?from={scope}&window={win}` is NOT taken: `from`
 * is already a date key, and the window rides the existing vocabulary
 * (`month` XOR `from`/`to`). Scope rides the NEW `src` key — a token naming
 * which of the caller's own grants frames a drill view (`cc:{id}` /
 * `region:{id}` / `across` / `finance`). It selects a frame; it NEVER
 * authorises (D33 — the server 403s a scope the caller does not hold).
 *
 * Key-ownership stays disjoint on me pages: `?lane=` belongs to
 * usePersonalLens there; useReportState merely round-trips a foreign
 * `lane=chargeback` through patch() and never invents one.
 *
 * MUTATIONS these pin:
 *  - drop `src` from parse/build/patch → the round-trip + patch tests go red;
 *  - accept any garbage as a token → the vocabulary test goes red;
 *  - emit `src` unconditionally → the clean-URL tests go red;
 *  - patch() clobbering `lane`/`month` → the coexistence test goes red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive } from 'vue'
import {
  parseReportQuery,
  buildReportQuery,
  isScopeSrcToken,
  useReportState,
  type ReportState,
} from '../../../app/composables/useReportState'
import { usePersonalLens } from '../../../app/composables/usePersonalLens'

describe('parseReportQuery — the src token vocabulary (D16)', () => {
  it('accepts the four token shapes', () => {
    for (const src of ['across', 'finance', 'cc:ai-apps-data', 'region:apac']) {
      expect(parseReportQuery({ src }).src).toBe(src)
      expect(isScopeSrcToken(src)).toBe(true)
    }
  })

  it('drops garbage — an unknown frame must not survive into state', () => {
    for (const src of ['bogus', 'cc:', 'region:', 'teammate:t1', 'cc:a b']) {
      expect(parseReportQuery({ src }).src).toBeUndefined()
      expect(isScopeSrcToken(src)).toBe(false)
    }
  })

  it('takes the first value when the key repeats (array)', () => {
    expect(parseReportQuery({ src: ['cc:c1', 'across'] }).src).toBe('cc:c1')
  })

  it('absent src stays ABSENT — a frameless URL parses clean', () => {
    expect(parseReportQuery({ scope: 'region' }).src).toBeUndefined()
  })
})

describe('buildReportQuery — src rides like every other report key', () => {
  it('emits src when set, drops it when absent (byte-stable clean URL)', () => {
    const withSrc: ReportState = {
      scope: 'cost-centre', month: '2026-07', src: 'cc:c1', region: null, ou: null, cc: 'c1',
    }
    expect(buildReportQuery(withSrc)).toEqual({
      scope: 'cost-centre', month: '2026-07', src: 'cc:c1', cc: 'c1',
    })
    const without: ReportState = { scope: 'region', month: null, region: null, ou: null, cc: null }
    expect(buildReportQuery(without)).toEqual({ scope: 'region' })
  })

  it('round-trips src beside BOTH window vocabularies (month XOR from/to — T13)', () => {
    // Month mode.
    const monthState = parseReportQuery({ scope: 'region', month: '2026-07', src: 'region:apac' })
    expect(parseReportQuery(buildReportQuery(monthState))).toEqual(monthState)
    expect(monthState.month).toBe('2026-07')
    expect(monthState.src).toBe('region:apac')
    // Range mode.
    const rangeState = parseReportQuery({
      scope: 'region', from: '2026-07-01', to: '2026-07-15', src: 'cc:c1',
    })
    expect(parseReportQuery(buildReportQuery(rangeState))).toEqual(rangeState)
    expect(rangeState.from).toBe('2026-07-01')
    expect(rangeState.src).toBe('cc:c1')
  })
})

/*
 * The reactive half — patch()/writable against a fake route/router (the
 * report-state-sync idiom), including the me-page key coexistence with
 * usePersonalLens.
 */
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

describe('useReportState — src is an owned key (patch, back/forward echo)', () => {
  it('writing src shallow-routes ?src=, clearing removes it', () => {
    const rs = useReportState({ scope: 'region' })
    rs.src.value = 'cc:c1'
    expect(route.query.src).toBe('cc:c1')
    expect(rs.src.value).toBe('cc:c1')
    rs.src.value = null
    expect(route.query.src).toBeUndefined()
    expect(rs.src.value).toBeNull()
  })

  it('patch() carries src alongside the window without disturbing either', () => {
    route.query = { scope: 'cost-centre', month: '2026-07', cc: 'c1' }
    const rs = useReportState()
    rs.patch({ src: 'cc:c1' })
    expect(route.query).toMatchObject({ scope: 'cost-centre', month: '2026-07', cc: 'c1', src: 'cc:c1' })
  })

  it('?lane and ?month both set → both honoured; a src patch clobbers neither (T13)', () => {
    // The me-page shape: usePersonalLens owns ?lane; the window rides ?month.
    route.query = { month: '2026-07', lane: 'chargeback', scope: 'region' }
    const rs = useReportState()
    expect(rs.month.value).toBe('2026-07')
    rs.patch({ src: 'region:apac' })
    expect(route.query.lane).toBe('chargeback') // usePersonalLens's key survives
    expect(route.query.month).toBe('2026-07')
    expect(route.query.src).toBe('region:apac')
  })

  it('usePersonalLens still owns lane: writing it preserves src + window', () => {
    route.query = { month: '2026-07', src: 'cc:c1', scope: 'region' }
    const lens = usePersonalLens()
    expect(lens.value).toBe('usage')
    lens.value = 'chargeback'
    expect(route.query).toMatchObject({
      month: '2026-07', src: 'cc:c1', lane: 'chargeback', scope: 'region',
    })
    // Back to the default drops ONLY the lane key.
    lens.value = 'usage'
    expect(route.query.lane).toBeUndefined()
    expect(route.query.src).toBe('cc:c1')
    expect(route.query.month).toBe('2026-07')
  })
})
