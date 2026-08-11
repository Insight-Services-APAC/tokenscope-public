// @vitest-environment happy-dom
/*
 * The elevated-access chip on /reporting (app/pages/reporting/index.vue) —
 * shown for EVERY viewer holding ≥1 active report-access grant (mig 0129),
 * worded ONLY from the shared REPORT_ACCESS_PERMISSION_LABELS vocabulary
 * (#shared/auth/report-visibility) so this chip and the admin grant pane
 * (ReportAccessSection.vue) can never name the same permission two different
 * ways — the retired local VISIBILITY_MODE_LABEL map was exactly that
 * duplication, and it is a recorded defect.
 *
 * Harness lifted from reporting-shell.test.ts: the page uses Nuxt
 * auto-imports (`useFetch`, `useReportState`) as unqualified globals, so we
 * stub them + wrap in <Suspense> for the page's top-level `await useFetch`.
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
  permissions?: string[]
}

const makeMeta = (over: Partial<Meta> = {}): Meta => ({
  scopes: ['region'],
  defaultScope: 'region',
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

describe('/reporting elevated-access chip', () => {
  it('renders no chip when meta carries no permissions field at all', async () => {
    const w = await mountShell(makeMeta())
    expect(w.find('[data-testid="reporting-visibility-chip"]').exists()).toBe(false)
  })

  it('renders no chip for an explicitly empty permissions array', async () => {
    const w = await mountShell(makeMeta({ permissions: [] }))
    expect(w.find('[data-testid="reporting-visibility-chip"]').exists()).toBe(false)
  })

  it('names a single held permission from the shared label, with "granted"', async () => {
    const w = await mountShell(makeMeta({ permissions: ['finance'] }))
    const chip = w.find('[data-testid="reporting-visibility-chip"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('Elevated access: Finance reporting (whole company) · granted')
  })

  it('joins both held permissions from the shared labels', async () => {
    const w = await mountShell(makeMeta({ permissions: ['operational', 'finance'] }))
    const chip = w.find('[data-testid="reporting-visibility-chip"]')
    expect(chip.text()).toBe(
      'Elevated access: Operational reporting (whole company), Finance reporting (whole company) · granted',
    )
  })

  it('renders even with zero granted scopes — every viewer, not just a scoped one', async () => {
    const w = await mountShell(makeMeta({ scopes: [], defaultScope: null, permissions: ['operational'] }))
    expect(w.find('[data-testid="reporting-visibility-chip"]').exists()).toBe(true)
  })
})
