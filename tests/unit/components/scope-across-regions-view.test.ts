// @vitest-environment happy-dom
/*
 * ScopeAcrossRegionsView — the presentational Across-Regions (whole-company) tree.
 * Verifies build-design §3's "exactly one of skeleton / error / empty / data"
 * contract, the KPI tiles, the provider split + active-users trend, the seasonality
 * heatmap card, the drivers/top-models/concentration section, the Copilot "pending"
 * chip, and the DATAVIZ rule that a MoM delta is NEUTRAL (arrow, never RAG green).
 *
 * The View renders the real (auto-import-backed) DateRangeControl and the ECharts
 * client kit; both are stubbed here so the pure View mounts without a Nuxt runtime.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScopeAcrossRegionsView from '../../../app/components/reporting/ScopeAcrossRegionsView.vue'
import type {
  AcrossReport,
  AcrossDriversResp,
} from '../../../app/components/reporting/across-report-types'
import type { AcrossTrend, Seasonality, ActiveTrend } from '../../../shared/reports/types'

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
  scope: 'across' as const,
  pointInTimeDims: true,
}

const dailyMetrics = [
  { day: '2026-07-08', genuineUsd: 30, tokens: 2000, activeUsers: 2 },
  { day: '2026-07-09', genuineUsd: 28, tokens: 2000, activeUsers: 3 },
]

function makeReport(over: Partial<AcrossReport> = {}): AcrossReport {
  return {
    meta,
    kpis: {
      genuineUsd: 58,
      chargeableUsd: 12,
      anthropicChargeableUsd: 12,
      tokens: 4000,
      activeUsers: 3,
      momDeltaPct: 28 / 30,
      chargeMomDeltaPct: null,
      avgPerUserUsd: 58 / 3,
      billedTeammates: 2,
      billedTokens: 3000,
      avgChargePerBilledUser: 6,
    },
    copilot: { mode: 'pool-utilisation', pending: true, chargeableUsd: null },
    forecast: null,
    actualUsd: 58,
    dailyMetrics,
    // §B per-day Anthropic chargeback (bill lane) — the Chargeable-tile sparkline source.
    chargeDaily: [
      { day: '2026-07-08', chargeUsd: 6 },
      { day: '2026-07-09', chargeUsd: 6 },
    ],
    // §B provider split (bill lane) — Anthropic vs Copilot pooled (null while pending).
    chargebackProviderSplit: { anthropicUsd: 12, copilotUsd: null },
    providerSplit: {
      claudeCode: { spendUsd: 40, activeUsers: 2 },
      copilot: { spendUsd: 15, activeUsers: 2 },
      other: { spendUsd: 3, activeUsers: 1 },
    },
    regionCards: [
      { regionId: 'ra', code: 'ra', displayName: 'Region A', genuineUsd: 50, anthropicChargeableUsd: 12, copilotChargeableUsd: 120, chargeableUsd: 12, activeUsers: 2, avgPerUserUsd: 25, sharePct: 50 / 58 },
      { regionId: 'rb', code: 'rb', displayName: 'Region B', genuineUsd: 8, anthropicChargeableUsd: 0, copilotChargeableUsd: 0, chargeableUsd: 0, activeUsers: 1, avgPerUserUsd: 8, sharePct: 8 / 58 },
    ],
    // §B chargeback-by-region ranking (bill lane) — the chargeback-lane swap for regionCards.
    chargebackByRegion: [
      { regionId: 'ra', label: 'Region A', chargeableUsd: 12 },
      { regionId: 'rb', label: 'Region B', chargeableUsd: 0 },
    ],
    ...over,
  }
}

const drivers: AcrossDriversResp = {
  axis: 'teammate',
  headlineUsd: 58,
  rows: [
    { key: 'd', label: 'dave', usd: 30, sharePct: 30 / 58, spendClass: 'pooled-usage' },
    { key: 'a', label: 'alice', usd: 20, sharePct: 20 / 58, spendClass: 'indicative' },
    { key: 'b', label: 'bob', usd: 8, sharePct: 8 / 58, spendClass: 'indicative' },
  ],
  concentration: {
    activeUsers: 3,
    totalUsd: 58,
    top1: 30 / 58,
    top5: 30 / 58,
    top10: 50 / 58,
    segments: [
      { key: 'power', label: 'Power users', count: 1, totalUsd: 30, sharePct: 30 / 58, avgUsd: 30, medianUsd: 30 },
      { key: 'heavy', label: 'Heavy users', count: 1, totalUsd: 20, sharePct: 20 / 58, avgUsd: 20, medianUsd: 20 },
      { key: 'typical', label: 'Typical users', count: 0, totalUsd: 0, sharePct: 0, avgUsd: 0, medianUsd: 0 },
      { key: 'light', label: 'Light users', count: 1, totalUsd: 8, sharePct: 8 / 58, avgUsd: 8, medianUsd: 8 },
    ],
  },
}

const modelDrivers: AcrossDriversResp = {
  axis: 'model',
  headlineUsd: 58,
  rows: [
    { key: 'opus', label: 'claude-opus-4', usd: 38, sharePct: 38 / 58, spendClass: 'indicative' },
    { key: 'sonnet', label: 'claude-sonnet-4', usd: 20, sharePct: 20 / 58, spendClass: 'indicative' },
  ],
  concentration: drivers.concentration,
}

const trend: AcrossTrend = {
  window: { from: '2026-05-12', to: '2026-07-10' },
  series: [
    { day: '2026-07-08', key: 'claude-code', value: 12 },
    { day: '2026-07-09', key: 'copilot-cli', value: 6 },
  ],
  // §B daily Anthropic chargeback series (bill lane) — feeds the §B spend-trend card.
  chargeSeries: [
    { day: '2026-07-08', chargeUsd: 6 },
    { day: '2026-07-09', chargeUsd: 6 },
  ],
}

const seasonality: Seasonality = {
  window: { from: '2026-05-12', to: '2026-07-10' },
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

const activeTrend: ActiveTrend = {
  window: { from: '2026-05-12', to: '2026-07-10' },
  series: [
    { day: '2026-07-08', claudeCode: 2, copilot: 1 },
    { day: '2026-07-09', claudeCode: 3, copilot: 2 },
  ],
}

const baseProps = {
  drivers,
  modelDrivers,
  trend,
  seasonality,
  activeTrend,
  driversAxis: 'teammate',
  trendWindowLabel: 'Last 60 days',
  exportParams: { scope: 'across-regions', report: 'drivers', axis: 'teammate', month: '2026-07' },
  exportFilename: 'tokenscope-across-regions-drivers-teammate-2026-07.csv',
}

const seen = (w: ReturnType<typeof mount>) => ({
  skeleton: w.find('[data-testid="report-skeleton"]').exists(),
  error: w.find('[data-testid="fetch-error-banner"]').exists(),
  empty: w.find('[data-testid="report-empty"]').exists(),
  data: w.find('[data-testid="across-data"]').exists(),
})

describe('ScopeAcrossRegionsView — the four exclusive states', () => {
  it('SKELETON while pending with no data', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: null, pending: true }, global })
    expect(seen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('ERROR when the fetch failed', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: null, pending: false, error: new Error('boom') }, global })
    const s = seen(w)
    expect(s.error).toBe(true)
    expect([s.skeleton, s.empty, s.data]).toEqual([false, false, false])
  })

  it('EMPTY when the period has no genuine/chargeable/active data', () => {
    const report = makeReport({ kpis: { genuineUsd: 0, chargeableUsd: 0, anthropicChargeableUsd: 0, tokens: 0, activeUsers: 0, momDeltaPct: null, chargeMomDeltaPct: null, avgPerUserUsd: 0 }, regionCards: [] })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false }, global })
    expect(seen(w)).toEqual({ skeleton: false, error: false, empty: true, data: false })
  })

  it('DATA renders KPIs + provider split + trends + seasonality + region + drivers + models + export', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(seen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })
    const kpi = w.find('[data-testid="across-kpi-genuine"]')
    expect(kpi.text()).toContain('Attributed usage')
    expect(kpi.text()).toContain('$58')
    expect(kpi.text().toLowerCase()).toContain('will be charged')
    // The "will be charged" figure is Anthropic-only while Copilot is pending — the caption
    // flags that so it does not silently under-read (finding #7).
    expect(kpi.text().toLowerCase()).toContain('copilot pending')
    expect(w.find('[data-testid="across-hero"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-provider-split"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-active-trend-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-trend-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-seasonality-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-region-rank"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-drivers-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="drivers-table"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-top-models"]').exists()).toBe(true)
    expect(w.find('[data-testid="export-csv-button"]').exists()).toBe(true)
  })
})

describe('ScopeAcrossRegionsView — the MoM delta is a NEUTRAL magnitude, not a status', () => {
  it('rising: up arrow, no RAG-green tint', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const mom = w.find('[data-testid="across-kpi-mom"]')
    expect(mom.exists()).toBe(true)
    expect(mom.text()).toContain('↑')
    expect(mom.text()).toContain('93%') // fmtPct(|28/30|), unsigned — the arrow carries direction
    expect(mom.html()).not.toContain('rag-green')
    expect(mom.html()).not.toContain('rag-red')
  })

  it('falling: down arrow, no RAG-red tint', () => {
    const report = makeReport({ kpis: { genuineUsd: 58, chargeableUsd: 12, anthropicChargeableUsd: 12, tokens: 4000, activeUsers: 3, momDeltaPct: -0.2, chargeMomDeltaPct: null, avgPerUserUsd: 58 / 3 } })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false }, global })
    const mom = w.find('[data-testid="across-kpi-mom"]')
    expect(mom.text()).toContain('↓')
    expect(mom.text()).toContain('20%')
    expect(mom.html()).not.toContain('rag-red')
    expect(mom.html()).not.toContain('rag-green')
  })

  it('hides the MoM tile in custom-range mode (momDeltaPct null)', () => {
    const report = makeReport({ kpis: { genuineUsd: 58, chargeableUsd: 12, anthropicChargeableUsd: 12, tokens: 4000, activeUsers: 3, momDeltaPct: null, chargeMomDeltaPct: null, avgPerUserUsd: 58 / 3 } })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false }, global })
    expect(w.find('[data-testid="across-kpi-mom"]').exists()).toBe(false)
  })
})

describe('ScopeAcrossRegionsView — ConcentrationCard wiring', () => {
  it('feeds the top-1/5/10 tiles + labelled segments from drivers.concentration', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const card = w.find('[data-testid="concentration-card"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('Top 1%')
    expect(card.text()).toContain('Top 10%')
    expect(card.text()).toContain('Power users')
    expect(card.text()).toContain('Light users')
  })

  it('renders no ConcentrationCard when drivers (hence concentration) is absent', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, drivers: null, report: makeReport(), pending: false }, global })
    expect(w.find('[data-testid="concentration-card"]').exists()).toBe(false)
  })
})

describe('ScopeAcrossRegionsView — the Copilot chargeback marker', () => {
  it('shows the "pending" chip in pool-utilisation mode (pre-Wave-0 validation)', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const chip = w.find('[data-testid="across-copilot-pending"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text().toLowerCase()).toContain('pending')
  })

  it('hides the pending chip once chargeback mode is validated', () => {
    const report = makeReport({ copilot: { mode: 'chargeback', pending: false, chargeableUsd: 120 }, kpis: { genuineUsd: 58, chargeableUsd: 132, anthropicChargeableUsd: 12, tokens: 4000, activeUsers: 3, momDeltaPct: 28 / 30, chargeMomDeltaPct: null, avgPerUserUsd: 58 / 3 } })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false }, global })
    expect(w.find('[data-testid="across-copilot-pending"]').exists()).toBe(false)
  })
})

describe('ScopeAcrossRegionsView — the §A/§B lane re-lens', () => {
  it('USAGE lane (default): the §A analytics render full-fidelity, region rank reads "Usage by region"', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    // §A-only cards present, no usage-only placeholder.
    expect(w.find('[data-testid="across-provider-split"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-trend-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-drivers-section"]').exists()).toBe(true)
    expect(w.find('[data-testid="usage-only-card"]').exists()).toBe(false)
    // The hero shows the usage headline; the KPI money tiles are not greyed.
    expect(w.find('[data-testid="across-region-rank"]').text()).toContain('Usage by region')
    expect(w.find('[data-testid="across-kpi-tokens"]').attributes('data-usage-only')).toBeUndefined()
  })

  it('CHARGEBACK lane: hero re-lenses; §A-only tiles RE-LENS to §B billed figures (not greyed); §A cards swap to §B', () => {
    const w = mount(ScopeAcrossRegionsView, {
      props: { ...baseProps, report: makeReport(), pending: false, lane: 'chargeback' },
      global,
    })
    // Hero re-lensed to the §B chargeable cost-of-record.
    const hero = w.find('[data-testid="across-hero"]')
    expect(hero.find('[data-testid="across-chargeback-total"]').exists()).toBe(true)
    expect(hero.text()).toContain('attributed usage') // the §A source stays visible (secondary)

    // The three formerly-§A tiles RE-LENS to their §B bill-lane analogue — NOT greyed.
    const active = w.find('[data-testid="across-kpi-active"]')
    const tokens = w.find('[data-testid="across-kpi-tokens"]')
    const avg = w.find('[data-testid="across-kpi-avg"]')
    expect(active.attributes('data-usage-only')).toBeUndefined()
    expect(tokens.attributes('data-usage-only')).toBeUndefined()
    expect(avg.attributes('data-usage-only')).toBeUndefined()
    expect(active.text()).toContain('Billed teammates')
    expect(active.text()).toContain('2') // kpis.billedTeammates
    expect(tokens.text()).toContain('Billed tokens')
    expect(avg.text()).toContain('Avg charge / billed user')
    // Both money tiles STAY visible (both matter equally).
    expect(w.find('[data-testid="across-kpi-genuine"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-kpi-chargeable"]').exists()).toBe(true)
    // The hero carries the honest Anthropic-per-teammate / Copilot-pooled caveat.
    expect(w.find('[data-testid="across-chargeback-caveat"]').text().toLowerCase()).toContain('pooled per')

    // §A cards RE-LENS to their §B bill-lane analogue (not a usage-only placeholder).
    expect(w.find('[data-testid="across-provider-split"]').exists()).toBe(false)
    expect(w.find('[data-testid="across-trend-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="chargeback-split-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="chargeback-trend-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="chargeback-dow-card"]').exists()).toBe(true)

    // Model-split (top models) + drivers + concentration stay usage-only — the bill lane
    // has NO model dim, so that bundle keeps the deliberate usage-only placeholder.
    expect(w.find('[data-testid="across-drivers-section"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="usage-only-card"]').length).toBe(1)

    // The region ranking re-titles + re-ranks to the §B chargeback field.
    expect(w.find('[data-testid="across-region-rank"]').text()).toContain('Chargeback by region')
  })

  it('CHARGEBACK lane MoM uses chargeMomDeltaPct (not the usage delta)', () => {
    const report = makeReport({
      kpis: { genuineUsd: 58, chargeableUsd: 12, anthropicChargeableUsd: 12, tokens: 4000, activeUsers: 3, momDeltaPct: null, chargeMomDeltaPct: 0.5, avgPerUserUsd: 58 / 3, billedTeammates: 2, billedTokens: 3000, avgChargePerBilledUser: 6 },
    })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false, lane: 'chargeback' }, global })
    const mom = w.find('[data-testid="across-kpi-mom"]')
    // Usage MoM is null (would hide the tile in usage mode) but the chargeback delta shows it.
    expect(mom.exists()).toBe(true)
    expect(mom.text()).toContain('↑')
    expect(mom.text().toLowerCase()).toContain('chargeback')
  })
})
