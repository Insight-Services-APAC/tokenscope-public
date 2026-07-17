// @vitest-environment happy-dom
/*
 * ScopeRegionalView — the presentational Regional (single-region) tree, rebuilt to
 * the locked design language + AEUF parity. Verifies build-design §3's "exactly one
 * of skeleton / error / empty / data" contract, the hero KPI pair, the provider
 * split + spend trend + seasonality + practice rank + top-models + drivers +
 * concentration section, the Copilot chargeback "pending" vs "included" chip, the
 * cross-region-only region selector, and the practice drill breadcrumb.
 *
 * The View renders the real (auto-import-backed) DateRangeControl and the ECharts
 * client kit; both are stubbed here so the pure View mounts without a Nuxt runtime.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScopeRegionalView from '../../../app/components/reporting/ScopeRegionalView.vue'
import type {
  RegionalReport,
  RegionalDriversResp,
  RegionalTrendResp,
} from '../../../app/components/reporting/regional/regional-view-types'
import type { ConcentrationStats } from '../../../app/components/reporting/ConcentrationCard.vue'
import type { ProviderSplit, ActiveTrend, Seasonality } from '../../../shared/reports/types'

// DateRangeControl self-wires to the auto-imported useReportState (undefined outside
// Nuxt); ClientOnly/VChart are Nuxt/nuxt-echarts globals the chart kit renders. Stub
// all so the pure View mounts.
const global = {
  stubs: {
    DateRangeControl: true,
    LaneToggle: true,
    // LaneSwitchLink self-wires to useReportState (undefined outside Nuxt) —
    // stubbed exactly like LaneToggle (iter-2 I5 cross-links).
    LaneSwitchLink: true,
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
  scope: 'regional' as const,
  pointInTimeDims: true,
}

const providerSplit: ProviderSplit = {
  claudeCode: { spendUsd: 32, activeUsers: 2 },
  copilotCli: { spendUsd: 15, activeUsers: 1 },
  // Three-lane §A ceiling: copilot-agent reads 0 today (absent from v_complete_usage).
  copilotAgent: { spendUsd: 0, activeUsers: 0 },
  other: { spendUsd: 3, activeUsers: 1 },
}

function makeReport(over: Partial<RegionalReport> = {}): RegionalReport {
  return {
    meta,
    region: { id: 'r1', code: 'ra', displayName: 'Region A' },
    regionOptions: [],
    drill: null,
    kpis: { genuineUsd: 50, chargeableUsd: 12, anthropicChargeableUsd: 12, tokens: 1000, activeUsers: 2, chargeMomDeltaPct: null, billedTeammates: 1, billedTokens: 800, avgChargePerBilledUser: 12 },
    copilot: { mode: 'pool-utilisation', pending: true, chargeableUsd: null },
    forecast: null,
    actualUsd: 50,
    dailyMetrics: [
      { day: '2026-07-02', genuineUsd: 20, tokens: 500, activeUsers: 2 },
      { day: '2026-07-03', genuineUsd: 30, tokens: 500, activeUsers: 2 },
    ],
    // §B per-day Anthropic chargeback (bill lane) — the Chargeable-tile sparkline source.
    chargeDaily: [
      { day: '2026-07-02', chargeUsd: 6 },
      { day: '2026-07-03', chargeUsd: 6 },
    ],
    // §B provider split (bill lane) — Anthropic vs Copilot pooled (null while pending).
    chargebackProviderSplit: { anthropicUsd: 12, copilotUsd: null },
    // §B per-lane chargeback totals (lane-visuals V2-Regional) — Σ == anthropicChargeableUsd (12).
    chargebackLanes: [
      { lane: 'claude', chargeUsd: 10 },
      { lane: 'claude-ai', chargeUsd: 2 },
    ],
    practices: [{ key: 'a', label: 'Practice A', value: 50, spendClass: 'indicative', isDefault: false }],
    chargebackByCostCentre: [
      { key: 'cou-a', label: 'Practice A', value: 12 },
      { key: 'unallocated', label: 'Unallocated', value: 0 },
    ],
    vendorSplit: null,
    exceptions: [],
    velocityThreshold: 0.25,
    providerSplit,
    ...over,
  }
}

const drivers: RegionalDriversResp = {
  axis: 'teammate',
  headlineUsd: 50,
  rows: [
    { key: 'd', label: 'dave', usd: 30, sharePct: 0.6, spendClass: 'pooled-usage' },
    { key: 'a', label: 'alice', usd: 20, sharePct: 0.4, spendClass: 'indicative' },
  ],
}

const modelDrivers: RegionalDriversResp = {
  axis: 'model',
  headlineUsd: 50,
  rows: [
    { key: 'opus', label: 'claude-opus-4', usd: 32, sharePct: 0.64, spendClass: 'indicative' },
    { key: 'sonnet', label: 'claude-sonnet-4', usd: 18, sharePct: 0.36, spendClass: 'indicative' },
  ],
}

const trend: RegionalTrendResp = {
  // The ONE shared window object the billed hero + donut bind on (iter-2 I1).
  window: { from: '2026-07-01', to: '2026-07-31' },
  windowDays: 31,
  // §A wire keys are the registry tool ids (the V2-Regional widening — the
  // pre-widening display names 'Claude'/'Copilot' are gone).
  series: [
    { day: '2026-07-02', key: 'claude-code', value: 20 },
    { day: '2026-07-03', key: 'copilot-cli', value: 8 },
  ],
  // §B daily Anthropic chargeback series (bill lane) — feeds the §B spend-trend card.
  chargeSeries: [
    { day: '2026-07-02', chargeUsd: 6 },
    { day: '2026-07-03', chargeUsd: 6 },
  ],
  // The per-lane widening (lane-visuals V2-Regional) — Σ lanes per day == chargeSeries[day].
  chargeLanes: [
    { day: '2026-07-02', lane: 'claude', chargeUsd: 6 },
    { day: '2026-07-03', lane: 'claude', chargeUsd: 4 },
    { day: '2026-07-03', lane: 'claude-ai', chargeUsd: 2 },
  ],
  // BILLED showback weekly lane cells (iter-2 I1) — the usage-view hero + donut.
  showbackWeeklyLanes: [
    { weekStart: '2026-06-29', lane: 'claude', usd: 30 },
    { weekStart: '2026-06-29', lane: 'claude-ai', usd: 12 },
    { weekStart: '2026-07-06', lane: 'claude', usd: 14 },
    { weekStart: '2026-07-06', lane: 'claude-ai', usd: 5 },
  ],
}

const concentration: ConcentrationStats = {
  top1: 0.6,
  top5: 0.6,
  top10: 1,
  segments: [
    { label: 'Power users', sharePct: 0.6, count: 1 },
    { label: 'Light users', sharePct: 0.4, count: 1 },
  ],
}

const activeTrend: ActiveTrend = {
  window: { from: '2026-07-01', to: '2026-07-31' },
  series: [
    { day: '2026-07-02', claudeCode: 2, copilot: 1 },
    { day: '2026-07-03', claudeCode: 2, copilot: 1 },
  ],
}

const seasonality: Seasonality = {
  window: { from: '2026-07-01', to: '2026-07-31' },
  weeks: ['2026-W27', '2026-W28'],
  cells: [
    { dow: 0, weekIdx: 0, value: 10 },
    { dow: 2, weekIdx: 1, value: 20 },
  ],
  // §B day-of-week Anthropic chargeback (bill lane), 7 buckets — feeds the §B dow card.
  chargeDow: [
    { dow: 0, chargeUsd: 8 },
    { dow: 1, chargeUsd: 0 },
    { dow: 2, chargeUsd: 4 },
    { dow: 3, chargeUsd: 0 },
    { dow: 4, chargeUsd: 0 },
    { dow: 5, chargeUsd: 0 },
    { dow: 6, chargeUsd: 0 },
  ],
}

const baseProps = {
  drivers,
  modelDrivers,
  concentration,
  trend,
  activeTrend,
  seasonality,
  momDeltaPct: null,
  driversAxis: 'teammate',
  exportParams: { scope: 'regional', report: 'drivers', axis: 'teammate', month: '2026-07' },
  exportFilename: 'tokenscope-regional-drivers-teammate-2026-07.csv',
}

const seen = (w: ReturnType<typeof mount>) => ({
  skeleton: w.find('[data-testid="report-skeleton"]').exists(),
  error: w.find('[data-testid="fetch-error-banner"]').exists(),
  empty: w.find('[data-testid="report-empty"]').exists(),
  data: w.find('[data-testid="regional-data"]').exists(),
})

describe('ScopeRegionalView — the four exclusive states', () => {
  it('SKELETON while pending with no data', () => {
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: null, pending: true }, global })
    expect(seen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('ERROR when the fetch failed', () => {
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: null, pending: false, error: new Error('boom') }, global })
    const s = seen(w)
    expect(s.error).toBe(true)
    expect([s.skeleton, s.empty, s.data]).toEqual([false, false, false])
  })

  it('EMPTY when the period has no genuine/chargeable/active data', () => {
    const report = makeReport({
      kpis: { genuineUsd: 0, chargeableUsd: 0, anthropicChargeableUsd: 0, tokens: 0, activeUsers: 0, chargeMomDeltaPct: null },
      practices: [],
    })
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report, pending: false }, global })
    expect(seen(w)).toEqual({ skeleton: false, error: false, empty: true, data: false })
  })

  it('DATA renders hero KPIs + provider split + trend + seasonality + practice rank + models + drivers + concentration + export', () => {
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(seen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })

    // The attributed-usage tile carries the §A total AND the honest "≈ $X will be
    // charged" caption (§B) — attribution, not chargeback ("showing ≠ charging").
    const kpi = w.find('[data-testid="regional-kpi-genuine"]')
    expect(kpi.text()).toContain('Attributed usage')
    expect(kpi.text()).toContain('$50')
    expect(kpi.text()).toContain('$12')
    expect(kpi.text().toLowerCase()).toContain('will be charged')
    // The "will be charged" figure is Anthropic-only while Copilot is pending — flagged so it
    // does not silently under-read (finding #7).
    expect(kpi.text().toLowerCase()).toContain('copilot pending')

    expect(w.find('[data-testid="regional-hero"]').exists()).toBe(true)
    // iter-2 I1: the billed composition hero + its pinned donut REPLACE the old
    // §A provider donut card; the basis caption is on both.
    expect(w.find('[data-testid="surface-hero-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="surface-hero-basis"]').text()).toContain('billed usage · all surfaces · weekly')
    expect(w.find('[data-testid="surface-donut-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="surface-donut-pointer"]').text()).toContain('bases differ')
    expect(w.find('[data-testid="across-active-trend-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="regional-trend-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="regional-seasonality"]').exists()).toBe(true)
    expect(w.find('[data-testid="regional-practice-rank"]').exists()).toBe(true)
    expect(w.find('[data-testid="regional-top-models"]').exists()).toBe(true)
    expect(w.find('[data-testid="drivers-table"]').exists()).toBe(true)
    expect(w.find('[data-testid="concentration-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="export-csv-button"]').exists()).toBe(true)
  })
})

describe('ScopeRegionalView — the Copilot chargeback chip', () => {
  it('shows the "pending" chip in pool-utilisation mode (pre-Wave-0 validation)', () => {
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const chip = w.find('[data-testid="copilot-pending-chip"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text().toLowerCase()).toContain('pending')
    expect(w.find('[data-testid="copilot-chargeback-chip"]').exists()).toBe(false)
  })

  it('drops the footer chip once chargeback mode is validated (no empty footer band; the sub conveys inclusion)', () => {
    const report = makeReport({
      copilot: { mode: 'chargeback', pending: false, chargeableUsd: 120 },
      kpis: { genuineUsd: 50, chargeableUsd: 132, anthropicChargeableUsd: 12, tokens: 1000, activeUsers: 2, chargeMomDeltaPct: null },
    })
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report, pending: false }, global })
    // No footer chip at all when not pending (parity with AcrossHero — an unconditional footer
    // slot rendered an empty band that inflated the Chargeable tile, finding #5).
    expect(w.find('[data-testid="copilot-pending-chip"]').exists()).toBe(false)
    expect(w.find('[data-testid="copilot-chargeback-chip"]').exists()).toBe(false)
    // Copilot inclusion is still conveyed — via the Chargeable tile's sub, not a chip.
    expect(w.find('[data-testid="regional-kpi-chargeable"]').text().toLowerCase()).toContain('copilot pooled net')
  })
})

describe('ScopeRegionalView — region selector + drill', () => {
  it('shows the region selector only when regionOptions are present (cross-region roles)', () => {
    const noSelector = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(noSelector.find('[data-testid="regional-region-selector"]').exists()).toBe(false)

    const withSelector = mount(ScopeRegionalView, {
      props: {
        ...baseProps,
        report: makeReport({
          regionOptions: [
            { id: 'r1', code: 'ra', displayName: 'Region A' },
            { id: 'r2', code: 'rb', displayName: 'Region B' },
          ],
        }),
        pending: false,
      },
      global,
    })
    expect(withSelector.find('[data-testid="regional-region-selector"]').exists()).toBe(true)
  })

  it('renders the breadcrumbed practice drill when `ou` (report.drill) is set', () => {
    const report = makeReport({ drill: { ouId: 'a', code: 'a', displayName: 'Practice A' } })
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report, pending: false }, global })

    const crumb = w.find('[data-testid="regional-drill-crumb"]')
    expect(crumb.exists()).toBe(true)
    expect(crumb.text()).toContain('Practice A')

    // Inside a practice, the top-level practice ranking is replaced by the drill's
    // users table — the region-level ranking must NOT also render.
    expect(w.find('[data-testid="regional-practice-rank"]').exists()).toBe(false)
    expect(w.find('[data-testid="drivers-table"]').exists()).toBe(true)
  })
})

describe('ScopeRegionalView — the §A/§B lane re-lens', () => {
  it('USAGE lane (default): the practice rank + §A analytics render; no usage-only placeholder', () => {
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(w.find('[data-testid="regional-practice-rank"]').exists()).toBe(true)
    expect(w.find('[data-testid="regional-chargeback-rank"]').exists()).toBe(false)
    // The billed hero + donut lead the usage view (iter-2 I1), with the page's
    // ONE LaneLegend carrying their lanes (V1 item 5).
    expect(w.find('[data-testid="surface-hero-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="surface-donut-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-legend"]').exists()).toBe(true)
    expect(w.find('[data-testid="usage-only-card"]').exists()).toBe(false)
  })

  it('CHARGEBACK lane: hero re-lenses, practice rank swaps to chargeback-by-cost-centre, §A cards grey/swap', () => {
    // Seed a velocity exception so the "signals suppressed in chargeback" gate is real.
    const report = makeReport({
      exceptions: [{ teammateId: 't1', name: 'Spiker', currentWeekUsd: 100, baselineMeanUsd: 40, deltaPct: 1.5 }],
    })
    const w = mount(ScopeRegionalView, {
      props: { ...baseProps, report, pending: false, lane: 'chargeback' },
      global,
    })
    // Hero shows the §B chargeable cost-of-record.
    expect(w.find('[data-testid="regional-chargeback-total"]').exists()).toBe(true)

    // The §A practice rank is swapped for the §B chargeback-by-cost-centre ranking.
    expect(w.find('[data-testid="regional-practice-rank"]').exists()).toBe(false)
    const cbRank = w.find('[data-testid="regional-chargeback-rank"]')
    expect(cbRank.exists()).toBe(true)
    expect(cbRank.text()).toContain('Chargeback by cost-centre')

    // The three formerly-§A tiles RE-LENS to their §B bill-lane analogue — NOT greyed.
    const tokens = w.find('[data-testid="regional-kpi-tokens"]')
    expect(tokens.attributes('data-usage-only')).toBeUndefined()
    expect(tokens.text()).toContain('Billed tokens')
    expect(w.find('[data-testid="regional-kpi-active"]').text()).toContain('Billed teammates')
    expect(w.find('[data-testid="regional-kpi-avg"]').text()).toContain('Avg charge / billed user')
    expect(w.find('[data-testid="regional-chargeback-caveat"]').text().toLowerCase()).toContain('pooled per')

    // §A/usage cards RE-LENS to their §B bill-lane analogue (not usage-only
    // placeholders); the billed hero + donut are usage-view elements and yield too.
    expect(w.find('[data-testid="surface-hero-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="surface-donut-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="regional-trend-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="chargeback-split-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="chargeback-trend-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="chargeback-dow-card"]').exists()).toBe(true)
    // Model-split (top models) + drivers + concentration stay usage-only (no model dim in
    // the bill) — exactly ONE usage-only placeholder remains (that bundle).
    expect(w.findAll('[data-testid="usage-only-card"]').length).toBe(1)
    // Velocity signals (a §A usage signal) are suppressed in chargeback mode.
    expect(w.find('[data-testid="regional-signals"]').exists()).toBe(false)
  })

  it('CHARGEBACK lane renders ONE page-level LaneLegend (union of the cards\' lanes) and lane-mode cards', () => {
    const w = mount(ScopeRegionalView, {
      props: { ...baseProps, report: makeReport(), pending: false, lane: 'chargeback' },
      global,
    })
    // The page legend carries the lane union (claude + claude-ai across trend + donut);
    // labels come from the registry.
    const legend = w.find('[data-testid="lane-legend"]')
    expect(legend.exists()).toBe(true)
    expect(w.find('[data-testid="lane-legend-claude"]').text()).toContain('Claude Code')
    expect(w.find('[data-testid="lane-legend-claude-ai"]').text()).toContain('Claude Chat')
    // The split card renders the capped+folded lane donut; the trend card the
    // WEEKLY lane stack (iter-2 I2 — the default grain).
    expect(w.find('[data-testid="chargeback-split-donut"]').exists()).toBe(true)
    expect(w.find('[data-testid="chargeback-trend-weekly"]').exists()).toBe(true)
    // USAGE mode carries its OWN page legend now — the billed hero's lanes (iter-2 I1).
    const usage = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(usage.find('[data-testid="lane-legend"]').exists()).toBe(true)
    // ...but never the §B copilot chargeback lanes (bases stay separated).
    expect(usage.find('[data-testid="lane-legend-copilot-license"]').exists()).toBe(false)
  })

  it('CHARGEBACK lane surfaces the copilot-unclassified badge (visible, never chargeable)', () => {
    const report = makeReport({
      chargebackLanes: [
        { lane: 'claude', chargeUsd: 10 },
        { lane: 'claude-ai', chargeUsd: 2 },
        { lane: 'copilot-license', chargeUsd: 100 },
        { lane: 'copilot-usage', chargeUsd: 20 },
        { lane: 'copilot-unclassified', chargeUsd: 7 },
      ],
      chargebackProviderSplit: { anthropicUsd: 12, copilotUsd: 120 },
    })
    const w = mount(ScopeRegionalView, {
      props: { ...baseProps, report, pending: false, lane: 'chargeback' },
      global,
    })
    const badge = w.find('[data-testid="chargeback-split-unclassified"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text().toLowerCase()).toContain('needs mapping')
    // The unclassified lane is not a donut slice → not a legend entry either.
    expect(w.find('[data-testid="lane-legend-copilot-unclassified"]').exists()).toBe(false)
    expect(w.find('[data-testid="lane-legend-copilot-license"]').exists()).toBe(true)
  })

  it('CHARGEBACK lane, $0 Anthropic + non-zero pooled Copilot: BOTH cards stay in lane mode (r3-6)', () => {
    // No Anthropic per-teammate chargeback this month, but validated pooled
    // Copilot lanes exist — the ONE page-level signal must put BOTH cards in
    // lane mode: donut on the split card, the lane-vocabulary EMPTY state on
    // the trend card — never the legacy single-series card silently.
    const report = makeReport({
      chargebackLanes: [
        { lane: 'copilot-license', chargeUsd: 100 },
        { lane: 'copilot-usage', chargeUsd: 20 },
      ],
      chargebackProviderSplit: { anthropicUsd: 0, copilotUsd: 120 },
    })
    const zeroTrend: RegionalTrendResp = {
      ...trend,
      chargeSeries: [
        { day: '2026-07-02', chargeUsd: 0 },
        { day: '2026-07-03', chargeUsd: 0 },
      ],
      chargeLanes: [],
    }
    const w = mount(ScopeRegionalView, {
      props: { ...baseProps, trend: zeroTrend, report, pending: false, lane: 'chargeback' },
      global,
    })
    // The page legend lists the Copilot lanes (the shared signal's source)...
    expect(w.find('[data-testid="lane-legend"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-legend-copilot-license"]').exists()).toBe(true)
    // ...the split card renders the lane donut...
    expect(w.find('[data-testid="chargeback-split-donut"]').exists()).toBe(true)
    // ...and the trend card shows its LANE-MODE state: the lane vocabulary +
    // the explicit empty note — not the legacy single-series chart.
    expect(w.find('[data-testid="chargeback-trend-card"]').text()).toContain('by surface')
    expect(w.find('[data-testid="chargeback-trend-lane-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="chargeback-trend-lanes"]').exists()).toBe(false)
  })

  it('CHARGEBACK lane + partial-month range, Copilot ON: pooled net WITHHELD — caveat, not a silent $0', () => {
    const report = makeReport({
      // Copilot chargeback validated (NOT pending) but the window is a partial-month range,
      // so the pooled (monthly) net is withheld — a DISTINCT state from pending.
      copilot: { mode: 'chargeback', pending: false, chargeableUsd: null, partialMonthUnavailable: true },
      chargebackProviderSplit: { anthropicUsd: 12, copilotUsd: null, partialMonthUnavailable: true },
    })
    const w = mount(ScopeRegionalView, {
      props: { ...baseProps, report, pending: false, lane: 'chargeback' },
      global,
    })
    // The hero caveats the partial-month withholding (not the pending copy)...
    expect(w.find('[data-testid="regional-chargeback-partial-month-note"]').exists()).toBe(true)
    expect(w.find('[data-testid="regional-chargeback-pending-note"]').exists()).toBe(false)
    // ...and the Chargeable tile does NOT claim "+ Copilot pooled net" (it is not folded here).
    expect(w.find('[data-testid="regional-kpi-chargeable"]').text().toLowerCase()).not.toContain(
      'copilot pooled net',
    )
    // The ChargebackSplitCard shows the partial-month state (not $0, not "pending validation").
    expect(w.find('[data-testid="chargeback-split-copilot-partial"]').exists()).toBe(true)
    expect(w.find('[data-testid="copilot-pending-chip"]').exists()).toBe(false)
  })
})
