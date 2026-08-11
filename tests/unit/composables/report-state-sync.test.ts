// @vitest-environment happy-dom
/*
 * useReportState — the REACTIVE URL-sync the reporting shell's scope tabs drive
 * (build-design §1/§3: "useReportState owns scope/month/region/ou ⇄ URL"). The
 * pure parse/serialise core is covered in report-state.test.ts; this exercises
 * the writable computeds + patch against a fake Nuxt route/router so the
 * shell's `?scope=` sync (and the drop of a foreign scope's `ou`/`cc`) is pinned.
 *
 * useReportState calls the Nuxt auto-imports `useRoute()` / `useRouter()` as
 * unqualified globals; we stub them with a reactive fake route whose query the
 * fake router's `replace` mutates — exactly the shallow-routed behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive } from 'vue'
import { useReportState } from '../../../app/composables/useReportState'

const route = reactive<{ query: Record<string, string> }>({ query: {} })
const router = {
  replace: ({ query }: { query: Record<string, string> }) => {
    // Vue Router drops `undefined` keys; mirror that so null→dropped is exercised.
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

describe('useReportState — scope-tab URL sync (the shell tabModel)', () => {
  it('writing `scope` shallow-routes `?scope=` into the URL', () => {
    const rs = useReportState({ scope: 'region' })
    expect(rs.scope.value).toBe('region') // default from meta
    rs.scope.value = 'finance'
    expect(route.query.scope).toBe('finance')
    expect(rs.scope.value).toBe('finance')
  })

  it('switching scope via patch DROPS the previous scope\'s ou/cc drill', () => {
    route.query = { scope: 'region', region: 'r1', ou: 'o1', cc: 'c1' }
    const rs = useReportState()
    // The shell's tabModel setter: patch scope + clear ou/cc.
    rs.patch({ scope: 'finance', ou: null, cc: null })
    expect(route.query.scope).toBe('finance')
    expect(route.query.ou).toBeUndefined()
    expect(route.query.cc).toBeUndefined()
    expect(route.query.region).toBe('r1') // region is preserved across the switch
  })

  it('month/region writes round-trip through the URL', () => {
    const rs = useReportState({ scope: 'region' })
    rs.month.value = '2026-05'
    rs.region.value = 'r2'
    expect(route.query.month).toBe('2026-05')
    expect(route.query.region).toBe('r2')
    // Clearing a key removes it from the URL.
    rs.region.value = null
    expect(route.query.region).toBeUndefined()
  })

  it('an invalid `?scope=` falls back to the provided default (client gating is UX only)', () => {
    route.query = { scope: 'bogus' }
    const rs = useReportState({ scope: 'region' })
    expect(rs.scope.value).toBe('region')
  })
})
