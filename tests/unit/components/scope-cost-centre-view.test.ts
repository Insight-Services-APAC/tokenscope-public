// @vitest-environment happy-dom
/*
 * ScopeCostCentreView — the rebuilt Cost-Centre BUDGET TRACKER (reporting-redesign
 * wave B). Verifies build-design §3's "exactly one of skeleton / error / empty /
 * data" contract (for BOTH the grid and the drill), the RAG budget-state
 * distinction (over / near / on-track / no-budget-set), the two visually distinct
 * on-track mechanics (exhaustion DATE vs run-rate DOLLAR), and the §A BURN drill
 * (burn headline + vendor donut + drivers, incl. a placement-moved top spender).
 *
 * The View renders the real (auto-import-backed) DateRangeControl and the ECharts
 * client kit; both are stubbed here so the pure View mounts without a Nuxt runtime.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScopeCostCentreView from '../../../app/components/reporting/ScopeCostCentreView.vue'
import type {
  CostCentreReport,
  CostCentreDrill,
} from '../../../app/components/reporting/cost-centre/cost-centre-view-types'

// DateRangeControl self-wires to the auto-imported useReportState (undefined outside
// Nuxt); ClientOnly/VChart are Nuxt/nuxt-echarts globals. Stub all so the View mounts.
const global = {
  stubs: {
    DateRangeControl: true,
    LaneToggle: true,
    ClientOnly: { template: '<div><slot /></div>' },
    VChart: true,
  },
}

const meta = {
  month: '2026-07',
  monthFloor: '2026-01',
  asOfDate: '2026-07-10',
  providerStates: [
    { vendor: 'anthropic' as const, state: 'settling' as const, settlesAt: '2026-08-30', closeRun: false as const },
    { vendor: 'usage' as const, state: 'settling' as const, settlesAt: '2026-09-04', closeRun: false as const },
  ],
  scope: 'cost-centre' as const,
  pointInTimeDims: true,
}

function forecast(projectedUsd: number) {
  return {
    asOfDate: '2026-07-02',
    daysElapsed: 2,
    daysInMonth: 31,
    factor: 15.5,
    meteredMtdUsd: projectedUsd / 15.5,
    meteredProjectedUsd: projectedUsd,
    projectedUsd,
  }
}

// Four cards spanning every RAG state: over / near / on-track / no-budget-set.
function makeReport(over: Partial<CostCentreReport> = {}): CostCentreReport {
  return {
    meta,
    laneNote: 'Per-cost-centre burn is the project cost-owning-unit usage axis.',
    cards: [
      { id: 'a', code: 'a', displayName: 'Practice A', regionCode: 'ra', burnUsd: 120, chargeUsd: 90, allocationUsd: 100, utilisation: 1.2, exhaustionDate: '2026-07-13', forecast: forecast(775), asOfDate: '2026-07-02' },
      { id: 'b', code: 'b', displayName: 'Practice B', regionCode: 'rb', burnUsd: 85, chargeUsd: 60, allocationUsd: 100, utilisation: 0.85, exhaustionDate: '2026-07-20', forecast: forecast(500), asOfDate: '2026-07-02' },
      { id: 'c', code: 'c', displayName: 'Practice C', regionCode: 'rc', burnUsd: 40, chargeUsd: 25, allocationUsd: 100, utilisation: 0.4, exhaustionDate: null, forecast: forecast(300), asOfDate: '2026-07-02' },
      { id: 'd', code: 'd', displayName: 'Practice D', regionCode: 'rd', burnUsd: 10, chargeUsd: 0, allocationUsd: null, utilisation: null, exhaustionDate: null, forecast: forecast(60), asOfDate: '2026-07-02' },
    ],
    summary: {
      totalBurnUsd: 255,
      totalAllocationUsd: 300,
      countOverBudget: 1,
      countNearBudget: 1,
      countOnTrack: 1,
      countNoAllocation: 1,
      asOfDate: '2026-07-02',
    },
    ...over,
  }
}

function makeDrill(over: Partial<CostCentreDrill> = {}): CostCentreDrill {
  return {
    meta: { ...meta, pointInTimeDims: true },
    cc: { id: 'a', code: 'a', displayName: 'Practice A', regionCode: 'ra' },
    // §A usage BURN — the SAME lane as the tracker card burn.
    burnUsd: 143.83,
    vendor: { claudeUsd: 143.83, copilotUsd: 0, otherUsd: 0 },
    allocationUsd: 500,
    axis: 'teammate',
    headlineUsd: 143.83,
    denominatorLabel: 'cost-centre burn',
    rows: [
      // Phil H — the largest spender whose CURRENT placement moved; §A homes by
      // emit-time cost_owning_unit_id, so he STAYS in the burn (the bug this fixes).
      { key: 'ph', label: 'Phil H', usd: 90, sharePct: 0.6257, spendClass: 'indicative' },
      { key: 'al', label: 'alice', usd: 33.83, sharePct: 0.2352, spendClass: 'indicative' },
      { key: 'el', label: 'ellen', usd: 20, sharePct: 0.1391, spendClass: 'indicative' },
    ],
    ...over,
  }
}

const baseProps = {
  driversAxis: 'teammate',
  exportParams: { scope: 'cost-centre', report: 'cards', month: '2026-07' },
  exportFilename: 'tokenscope-cost-centres-2026-07.csv',
  drillExportParams: { scope: 'cost-centre', report: 'drivers', cc: 'a', axis: 'teammate', month: '2026-07' },
  drillExportFilename: 'tokenscope-cost-centre-drivers-teammate-2026-07.csv',
  drillPending: false,
}

const gridSeen = (w: ReturnType<typeof mount>) => ({
  skeleton: w.find('[data-testid="report-skeleton"]').exists(),
  error: w.find('[data-testid="fetch-error-banner"]').exists(),
  empty: w.find('[data-testid="report-empty"]').exists(),
  data: w.find('[data-testid="cc-grid-data"]').exists(),
})

describe('ScopeCostCentreView — the grid four exclusive states', () => {
  it('SKELETON while pending with no data', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: null, drill: null, isDrill: false, pending: true } })
    expect(gridSeen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('ERROR when the grid fetch failed', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: null, drill: null, isDrill: false, pending: false, error: new Error('boom') } })
    const s = gridSeen(w)
    expect(s.error).toBe(true)
    expect([s.skeleton, s.empty, s.data]).toEqual([false, false, false])
  })

  it('EMPTY when there are no cost centres in scope', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport({ cards: [] }), drill: null, isDrill: false, pending: false } })
    expect(gridSeen(w)).toEqual({ skeleton: false, error: false, empty: true, data: false })
  })

  it('DATA renders the budget tracker + summary strip + lane note + export', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    expect(gridSeen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })
    expect(w.find('[data-testid="cc-summary-strip"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-budget-table"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-row-a"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-lane-note"]').exists()).toBe(true)
    expect(w.find('[data-testid="export-csv-button"]').exists()).toBe(true)
  })
})

describe('ScopeCostCentreView — the RAG budget states are visually distinct', () => {
  it('over / near / on-track rows carry their reserved status label; no-budget is clean', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    expect(w.find('[data-testid="cc-row-a"]').text()).toContain('Over budget')
    expect(w.find('[data-testid="cc-row-b"]').text()).toContain('Near budget')
    expect(w.find('[data-testid="cc-row-c"]').text()).toContain('On track')
    // No-allocation row: the CLEAN "No budget set" state + hint, never a fake on-track claim.
    const noBudget = w.find('[data-testid="cc-row-d"]')
    expect(noBudget.text()).toContain('No budget set')
    expect(noBudget.text()).toContain('Set an allocation to track burn against budget')
    expect(noBudget.text()).not.toContain('On track')
  })

  it('a budgeted row renders a projected-exhaustion DATE and a separate run-rate DOLLAR', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    const exhaustion = w.find('[data-testid="cc-row-exhaustion-a"]')
    expect(exhaustion.exists()).toBe(true)
    expect(exhaustion.text()).toContain('2026-07-13') // Mechanic 1 — a DATE
    expect(exhaustion.text().toLowerCase()).toContain('budget')
    const rowA = w.find('[data-testid="cc-row-a"]')
    expect(rowA.text()).toContain('$775') // Mechanic 2 — the run-rate DOLLAR
    // The no-exhaustion on-track row 'c' has no exhaustion element but still a run-rate.
    expect(w.find('[data-testid="cc-row-exhaustion-c"]').exists()).toBe(false)
    expect(w.find('[data-testid="cc-row-c"]').text()).toContain('$300')
  })
})

const drillSeen = (w: ReturnType<typeof mount>) => ({
  skeleton: w.find('[data-testid="report-skeleton"]').exists(),
  error: w.find('[data-testid="fetch-error-banner"]').exists(),
  empty: w.find('[data-testid="report-empty"]').exists(),
  data: w.find('[data-testid="cc-drill-data"]').exists(),
})

describe('ScopeCostCentreView — the drill four exclusive states', () => {
  it('SKELETON while the drill is pending with no drill data', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: true, pending: false, drillPending: true } })
    expect(drillSeen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('ERROR when the drill fetch failed (e.g. a 403 anti-IDOR)', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: true, pending: false, drillError: new Error('403') } })
    expect(drillSeen(w).error).toBe(true)
  })

  it('EMPTY when the cost centre has no burn for the month', () => {
    const drill = makeDrill({ burnUsd: 0, vendor: { claudeUsd: 0, copilotUsd: 0, otherUsd: 0 }, rows: [] })
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false } })
    expect(drillSeen(w)).toEqual({ skeleton: false, error: false, empty: true, data: false })
  })

  it('DATA renders the burn headline, the vendor donut, the drivers table + export', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    expect(drillSeen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })
    const headline = w.find('[data-testid="cc-burn-headline"]')
    // The burn headline is the §A usage burn — the SAME figure as the tracker row.
    expect(headline.text()).toContain('$143.83')
    // Framed against the CC's current allocation when set.
    expect(headline.text()).toContain('$500.00')
    expect(w.find('[data-testid="cc-drill-donut"]').exists()).toBe(true)
    expect(w.find('[data-testid="drivers-table"]').exists()).toBe(true)
    // The §A drill notes billing lives in the Finance tab (no §B showback columns here).
    expect(w.find('[data-testid="cc-drill-lane-note"]').text().toLowerCase()).toContain('finance tab')
    expect(w.find('[data-testid="cc-showback-vs-chargeable"]').exists()).toBe(false)
    expect(w.find('[data-testid="export-csv-button"]').exists()).toBe(true)
  })

  it('the top spender whose placement MOVED still appears in the §A burn drill (the bug fix)', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    const drivers = w.find('[data-testid="drivers-table"]')
    expect(drivers.exists()).toBe(true)
    // Phil H is the CC's largest spender; his current placement moved, but §A homes by
    // emit-time cost_owning_unit_id, so he is NOT dropped from the burn drill.
    expect(drivers.text()).toContain('Phil H')
    // Rows reconcile to the burn headline (DriversTable sum-back row is not RED).
    expect(w.find('[data-testid="drivers-sumback"]').attributes('data-mismatch')).toBe('false')
  })
})

describe('ScopeCostCentreView — the §A/§B lane re-lens (grid)', () => {
  it('USAGE lane (default): the summary primary tile is Total burn; rows show burn', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    const primary = w.find('[data-testid="cc-summary-primary"]')
    expect(primary.text()).toContain('Total burn')
    expect(primary.text()).toContain('$255') // Σ burn (120+85+40+10)
    // The budget row shows the §A burn figure as the primary.
    expect(w.find('[data-testid="cc-row-a"]').text()).toContain('$120')
  })

  it('CHARGEBACK lane: primary tile is Total chargeback; rows show §B charge with burn-derived RAG/run-rate/exhaustion suppressed', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false, lane: 'chargeback' } })
    const primary = w.find('[data-testid="cc-summary-primary"]')
    expect(primary.text()).toContain('Total chargeback')
    expect(primary.text()).toContain('$175') // Σ chargeUsd (90+60+25+0)
    // The budget row re-lenses to the §B chargeback figure ($90 for Practice A, not $120 burn).
    const rowA = w.find('[data-testid="cc-row-a"]')
    expect(rowA.text()).toContain('$90')
    expect(rowA.text().toLowerCase()).toContain('chargeback')
    // Allocation context stays framed, but the §A burn-derived RAG chip / run-rate / exhaustion
    // are SUPPRESSED — they describe the burn, not the §B figure (no §B number over §A projections).
    expect(rowA.text()).toContain('allocated')
    expect(rowA.text()).not.toContain('Over budget')
    expect(rowA.text().toLowerCase()).not.toContain('on track for')
    expect(w.find('[data-testid="cc-row-exhaustion-a"]').exists()).toBe(false)
    // The whole-scope RAG rollup is burn-based → hidden behind a scope note (both the summary
    // strip and the budget table carry the "switch to Usage" note).
    expect(w.find('[data-testid="cc-summary-scope-note"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-budget-scope-note"]').exists()).toBe(true)
    // The burn-based RAG count tiles are not shown in chargeback mode.
    expect(w.text()).not.toContain('Over budget')
  })
})
