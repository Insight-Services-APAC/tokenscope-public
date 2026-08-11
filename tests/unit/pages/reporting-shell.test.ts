// @vitest-environment happy-dom
/*
 * /reporting SHELL (app/pages/reporting/index.vue) — the zero-scope gate (L3).
 *
 * The shell bootstraps from GET /reports/meta (granted scopes + best default) and renders
 * the active scope. When NO scopes are granted, `activeScope` falls back to 'region' — but
 * rendering an ungranted Region view only 403-banners. The shell must instead render a
 * proper empty-state and mount NO scope component.
 *
 * The page uses Nuxt auto-imports (`useFetch`, `useReportState`) as unqualified globals and
 * auto-imported child components; we stub the globals + register component stubs, and wrap the
 * page in <Suspense> so its top-level `await useFetch` resolves under @vue/test-utils.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import ReportingIndex from '../../../app/pages/reporting/index.vue'

interface Meta {
  scopes: string[]
  defaultScope: string | null
  monthFloors: { usage: string | null; bill: string | null; reconciliation: string | null; overall: string }
  copilotMode: 'pool-utilisation' | 'chargeback'
}

const makeMeta = (over: Partial<Meta> = {}): Meta => ({
  scopes: [],
  defaultScope: null,
  monthFloors: { usage: null, bill: null, reconciliation: null, overall: '2026-05' },
  copilotMode: 'pool-utilisation',
  ...over,
})

const SCOPE_STUBS = {
  UiPageHead: true,
  UiFetchErrorBanner: true,
  UiTabs: true,
  UiEmptyState: true,
  ReportingScopeRegion: { template: '<div data-testid="scope-region-stub" />' },
  ReportingScopeCostCentre: { template: '<div data-testid="scope-cost-centre-stub" />' },
  ReportingScopeFinance: { template: '<div data-testid="scope-finance-stub" />' },
}

async function mountShell(meta: Meta) {
  vi.stubGlobal('useFetch', () => ({ data: ref(meta), error: ref(null) }))
  vi.stubGlobal('useReportState', (init: { scope?: string } = {}) => ({
    scope: ref(init.scope ?? 'region'),
    month: ref<string | null>(null),
    region: ref<string | null>(null),
    ou: ref<string | null>(null),
    cc: ref<string | null>(null),
    patch: vi.fn(),
  }))
  const Parent = defineComponent({
    components: { ReportingIndex },
    template: '<Suspense><ReportingIndex /></Suspense>',
  })
  const w = mount(Parent, { global: { stubs: SCOPE_STUBS } })
  await flushPromises()
  return w
}

afterEach(() => vi.unstubAllGlobals())

const anyScopeMounted = (w: Awaited<ReturnType<typeof mountShell>>) =>
  ['region', 'cost-centre', 'finance'].some((s) => w.find(`[data-testid="scope-${s}-stub"]`).exists())

/*
 * Region is a PER-SCOPE key, never a shell-wide default. A home-region default seeded here
 * used to be materialised into the URL by patch() and then inherited by the Finance scope,
 * silently narrowing its per-CoU table to the home region while the Σ=bill headline stayed
 * whole-company (they stopped footing). The shell must (a) NOT pass a region default, and
 * (b) drop region on every scope switch. `/reports/meta` no longer returns a region default
 * at all — the effective Regional region comes back on the Regional responses themselves —
 * so (a) is now belt AND braces.
 */
describe('/reporting shell — region is not a global default', () => {
  async function mountCapturing(meta: Meta, tabStub: object) {
    const inits: Array<Record<string, unknown>> = []
    const patch = vi.fn()
    vi.stubGlobal('useFetch', () => ({ data: ref(meta), error: ref(null) }))
    vi.stubGlobal('useReportState', (init: { scope?: string } = {}) => {
      inits.push(init as Record<string, unknown>)
      return {
        scope: ref(init.scope ?? 'region'),
        month: ref<string | null>(null),
        region: ref<string | null>(null),
        ou: ref<string | null>(null),
        cc: ref<string | null>(null),
        patch,
      }
    })
    const Parent = defineComponent({
      components: { ReportingIndex },
      template: '<Suspense><ReportingIndex /></Suspense>',
    })
    const w = mount(Parent, { global: { stubs: { ...SCOPE_STUBS, UiTabs: tabStub } } })
    await flushPromises()
    return { w, inits, patch }
  }

  it('does NOT seed a region default', async () => {
    const { inits } = await mountCapturing(
      makeMeta({ scopes: ['region', 'finance'], defaultScope: 'region' }),
      true,
    )
    // The shell is the only useReportState caller here (scopes are stubbed).
    const shellInit = inits[0] ?? {}
    expect(shellInit.region).toBeUndefined()
    expect('region' in shellInit).toBe(false)
  })

  it('drops region/ou/cc AND the period (month + from/to) when switching scope so Finance never inherits them', async () => {
    // A UiTabs stub that fires a scope switch to Finance on click. The shell's
    // `data-testid="reporting-scope-tabs"` falls through onto the stub's root element,
    // so we locate + click it by that id.
    const UiTabsStub = defineComponent({
      props: ['modelValue', 'tabs'],
      emits: ['update:modelValue'],
      template: `<button @click="$emit('update:modelValue', 'finance')" />`,
    })
    const { w, patch } = await mountCapturing(
      makeMeta({ scopes: ['region', 'finance'], defaultScope: 'region' }),
      UiTabsStub,
    )
    await w.find('[data-testid="reporting-scope-tabs"]').trigger('click')
    // The scope switch clears the sub-scope keys AND the period — an in-progress "This
    // quarter" range must not leak into Finance (retrospective) and desync its picker.
    expect(patch).toHaveBeenCalledWith({
      scope: 'finance',
      region: null,
      ou: null,
      cc: null,
      month: null,
      from: null,
      to: null,
    })
    // The period keys are explicitly part of the clearing patch (regression guard).
    const arg = patch.mock.calls[0]![0] as Record<string, unknown>
    expect(arg.month).toBeNull()
    expect(arg.from).toBeNull()
    expect(arg.to).toBeNull()
  })
})

describe('/reporting shell — zero granted scopes (L3)', () => {
  it('renders the no-scopes empty-state and mounts NO scope component', async () => {
    const w = await mountShell(makeMeta({ scopes: [], defaultScope: null }))
    expect(w.find('[data-testid="reporting-no-scopes"]').exists()).toBe(true)
    expect(anyScopeMounted(w)).toBe(false)
    // The scope tabs are not rendered either — there is nothing to tab between.
    expect(w.find('[data-testid="reporting-scope-tabs"]').exists()).toBe(false)
  })

  it('with a granted scope, it renders that scope and NOT the empty-state (gate does not over-fire)', async () => {
    const w = await mountShell(makeMeta({ scopes: ['region'], defaultScope: 'region' }))
    expect(w.find('[data-testid="reporting-no-scopes"]').exists()).toBe(false)
    expect(w.find('[data-testid="scope-region-stub"]').exists()).toBe(true)
  })
})
