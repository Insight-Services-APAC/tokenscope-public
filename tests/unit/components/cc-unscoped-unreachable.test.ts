// @vitest-environment happy-dom
/*
 * B1 (external review, HIGH) — THE UNSCOPED COST-CENTRE STATE IS UNREACHABLE.
 *
 * The prototype ruling is absolute: *"The Cost-centre tab lands ON a cost
 * centre. There is no unscoped state, and never was. The reader arrives already
 * scoped … because 'which cost centre am I looking at' must never be a question
 * this page leaves open."* (`R:551-559`.)
 *
 * The shipped page contradicted it twice over:
 *   1. `ScopeCostCentre`'s landing watcher was ONE-SHOT (`if (landed.value …)`),
 *      and the drill's crumb was a BUTTON that set `?cc=` to null. Clicking it
 *      dropped the reader into the unscoped multi-centre grid, and the spent
 *      watcher could never put them back.
 *   2. `CcScopeLine` in that state kept printing the DEFAULT centre's name
 *      (`scope.scopeLabel`), so the header claimed a scope the body was not
 *      showing — the owner's Dev report, verbatim: "hard to tell WHAT cost
 *      centre I'm looking at", "top burners shows CCs from all regions".
 *
 * Two doors, so two closures: the crumb is a label, and the watcher re-lands on
 * ANY null `cc` (a hand-edited URL, a stale bookmark, a tab switch that drops
 * the key). This file shoots both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
// Imported AFTER the mocks by hoisting — `vi.mock` is lifted above every import,
// so the container resolves the stubbed composables (both are real ESM imports
// in this file, not Nuxt auto-imports, so `stubGlobal` cannot reach them).
import ScopeCostCentre from '../../../app/components/reporting/ScopeCostCentre.vue'
import CcDrill from '../../../app/components/reporting/cost-centre/CcDrill.vue'
// Asserted through the CONSTANT: these tests are about the CLAIM, and pinning
// the noun made a vocabulary change read as a behaviour regression.
import { BU_LABEL_PLURAL } from '#shared/reports/vocabulary'

vi.mock('../../../app/composables/useReportState', () => ({ useReportState: () => rs }))
vi.mock('../../../app/composables/useDrillContract', () => ({
  useDrillGrants: () => ref({}),
  useDrillWindow: () => ref({}),
}))

const SCOPE = {
  options: [{ id: 'cc-1', displayName: 'AI Apps & Data', regionCode: 'apac', owned: true }],
  defaultCcId: 'cc-1',
  scopeLabel: 'AI Apps & Data',
  selectorVisible: false,
}

const rs = {
  month: ref<string | null>('2026-07'),
  from: ref<string | null>(null),
  to: ref<string | null>(null),
  lane: ref('usage'),
  cc: ref<string | null>(null),
  patch: vi.fn((p: { cc?: string | null }) => {
    if ('cc' in p) rs.cc.value = p.cc ?? null
  }),
}

const STUBS = {
  // The whole presentational tree is irrelevant here; only the container's URL
  // writes are. It echoes what it was told the scope is.
  ScopeCostCentreView: {
    props: ['isDrill'],
    template: '<div data-testid="view" :data-is-drill="String(isDrill)" />',
  },
}

function mountContainer() {
  vi.stubGlobal('useFetch', () => ({
    data: ref({ scope: SCOPE, cards: [], summary: null, meta: {} }),
    pending: ref(false),
    error: ref(null),
  }))
  /*
   * URL-SENSITIVE. One blanket stub returned the DRILL's shape to the trend
   * request too, so `trendWindowLabel` dereferenced `trend.window.from` on an
   * object that has no `window` — four unhandled rejections and a non-zero exit
   * while every assertion still passed. A green summary line over a red exit
   * code is the reading this repo has been bitten by before.
   */
  vi.stubGlobal('$fetch', async (url: string) =>
    String(url).endsWith('/trend')
      ? {
          window: { from: '2026-06-10', to: '2026-08-08' },
          windowDays: 60,
          series: [],
          activeTrend: { window: { from: '2026-06-10', to: '2026-08-08' }, series: [] },
          usageWeeklyLanes: [],
          perDeveloper: { points: [], deltaDays: 7 },
        }
      : { cc: { id: 'cc-1' } },
  )
  /*
   * The container reads the SERVER clock to size BAND 2's rolling window — it
   * must never compute one itself (Reporting.md §3a). `useServerClock` is a Nuxt
   * auto-import, so it has to be stubbed here like the two above or every mount
   * in this file dies with a ReferenceError before it reaches the assertion.
   */
  vi.stubGlobal('useServerClock', () => ({
    clock: ref({ now: '2026-07-22T09:00:00.000Z', today: '2026-07-22', settledThrough: '2026-07-21' }),
  }))
  return mount(ScopeCostCentre, { global: { stubs: STUBS } })
}

beforeEach(() => {
  rs.cc.value = null
  rs.patch.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

describe('the landing is not one-shot', () => {
  it('lands on the server-resolved centre with no ?cc=', async () => {
    mountContainer()
    await flushPromises()
    expect(rs.cc.value).toBe('cc-1')
  })

  /*
   * RED ON REVERT: restore the `landed` ref and the `if (landed.value || …)`
   * guard, and `cc` stays null here — the unscoped grid, permanently.
   */
  it('RE-lands when the scope is cleared out from under it', async () => {
    mountContainer()
    await flushPromises()
    rs.patch.mockClear()

    // Whatever cleared it — a hand-edited URL, a bookmark, a tab switch.
    rs.cc.value = null
    await nextTick()
    await flushPromises()

    expect(rs.cc.value).toBe('cc-1')
    expect(rs.patch).toHaveBeenCalledWith({ cc: 'cc-1' })
  })

  it('leaves a DIFFERENT centre alone — re-landing is for the null case only', async () => {
    mountContainer()
    await flushPromises()
    rs.patch.mockClear()

    rs.cc.value = 'cc-2'
    await nextTick()
    await flushPromises()

    expect(rs.cc.value).toBe('cc-2')
    expect(rs.patch).not.toHaveBeenCalled()
  })
})

describe('the drill crumb is a trail, not a door out', () => {
  /*
   * RED ON REVERT: put the `<button … @click="emit('clearDrill')">Cost centres`
   * back and the crumb offers the forbidden exit again.
   */
  it('renders "Cost centres" as text — there is no clear control on it', () => {
    const w = mount(CcDrill, {
      props: {
        drill: {
          cc: { id: 'cc-1', displayName: 'AI Apps & Data', regionCode: 'apac' },
          meta: { month: '2026-07', range: null },
          burnUsd: 0,
          allocationUsd: 0,
          vendor: { claudeUsd: 0, copilotUsd: 0, otherUsd: 0 },
          axis: 'project',
          headlineUsd: 0,
          denominatorLabel: '',
          rows: [],
          budgets: { rows: [], headlineUsd: 0, denominatorLabel: '' },
          people: { rows: [], headlineUsd: 0, denominatorLabel: '' },
          overSoftCap: { rows: [], softCapUsd: 0, rosterUsd: 0, note: null },
          providerFreshness: [],
          exposure: null,
        },
        budgetsExportParams: {},
        budgetsExportFilename: 'b.csv',
        peopleExportParams: {},
        peopleExportFilename: 'p.csv',
      },
      global: {
        stubs: {
          ChartDonut: true,
          DriversTable: true,
          ProviderFreshnessBar: true,
          ExportCsvButton: true,
          CcOverSoftCap: true,
          TierExposureCard: true,
          ClientOnly: { template: '<div><slot /></div>' },
        },
        mocks: { fmtUsd: (v: number) => `$${Number(v).toFixed(2)}` },
      },
    })
    const crumb = w.find('[data-testid="cc-drill-crumb"]')
    expect(crumb.exists()).toBe(true)
    expect(crumb.text()).toContain(`${BU_LABEL_PLURAL}`)
    expect(crumb.findAll('button')).toHaveLength(0)
    expect(w.emitted()).not.toHaveProperty('clearDrill')
  })
})
