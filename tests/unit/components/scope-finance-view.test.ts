// @vitest-environment happy-dom
/*
 * ScopeFinanceView — the presentational Finance tree (Wave 5). Verifies
 * build-design §3's "exactly one of skeleton / error / empty / data" contract (for
 * BOTH the index and the drill), the VISIBLE Σ=bill check row states (green matched /
 * RED unsettled, with the amounts), the exempt-gap card, the per-CoU table, and the
 * INFORMATIONAL Overage Drivers panel (D-Q6, never a charge).
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScopeFinanceView from '../../../app/components/reporting/ScopeFinanceView.vue'
import type { FinanceReport, FinanceDrill } from '../../../app/components/reporting/finance-report-types'

const meta = {
  month: '2026-05',
  monthFloor: '2026-05',
  asOfDate: '2026-05-31',
  providerStates: [
    { vendor: 'anthropic' as const, state: 'settling' as const, settlesAt: '2026-06-30', closeRun: false as const },
    { vendor: 'github' as const, state: 'settling' as const, settlesAt: '2026-06-07', invoiceReconciled: false, closeRun: false as const },
  ],
  scope: 'finance' as const,
  pointInTimeDims: false,
}

const HOMING = 'Chargeback rows are homed to the current org structure.'

function makeReport(over: Partial<FinanceReport> = {}): FinanceReport {
  return {
    meta,
    billCheck: {
      chargebackUsd: 360,
      billUsd: 360,
      deltaUsd: 0,
      matched: true,
      unsettled: false,
      copilotChargebackUsd: 300,
      providers: [
        { provider: 'anthropic', billUsd: 60, unsettled: false },
        { provider: 'github', billUsd: 300, unsettled: false },
      ],
    },
    cous: [
      { couId: 'a', code: 'a', displayName: 'Practice A', regionCode: 'ra', anthropicUsd: 50, copilotUsd: 300, copilotPending: false, chargeableUsd: 350 },
      { couId: null, code: null, displayName: 'Unallocated', regionCode: null, anthropicUsd: 0, copilotUsd: 20, copilotPending: false, chargeableUsd: 20 },
    ],
    copilot: { mode: 'chargeback', pending: false },
    exemptGap: { indicativeUsageUsd: 90, chargebackUsd: 360, gapUsd: -270, copilotChargebackUsd: 300 },
    region: null,
    homingNote: HOMING,
    ...over,
  }
}

function makeDrill(over: Partial<FinanceDrill> = {}): FinanceDrill {
  return {
    meta,
    cou: { id: 'a', code: 'a', displayName: 'Practice A', regionCode: 'ra' },
    anthropicCharges: [
      { teammateId: 'al', label: 'alice', chargeUsd: 30 },
      { teammateId: 'bo', label: 'bob', chargeUsd: 20 },
    ],
    anthropicChargeableUsd: 50,
    copilot: {
      mode: 'chargeback',
      pending: false,
      pooledLines: [{ orgId: 'o1', label: 'Octo Org', licenseUsd: 200, overageUsd: 100, netUsd: 300, unsettled: false }],
      poolUtilisation: null,
      chargeableUsd: 300,
      licenseNetUsd: 200,
      overageNetUsd: 100,
      unsettled: false,
    },
    chargeableUsd: 350,
    projectOverlay: [
      { key: 'p1', label: 'Project X', usd: 30, sharePct: 0.6, spendClass: 'indicative' },
      { key: '__untagged', label: 'Untagged', usd: 20, sharePct: 0.4, spendClass: 'indicative' },
    ],
    projectHeadlineUsd: 50,
    overageDrivers: {
      overageNetUsd: 100,
      perSeatShareUsd: 100,
      rows: [
        { key: 'al', label: 'alice', usd: 75, sharePct: 0.75, spendClass: 'indicative' },
        { key: 'bo', label: 'bob', usd: 25, sharePct: 0.25, spendClass: 'indicative' },
      ],
    },
    homingNote: HOMING,
    ...over,
  }
}

const baseProps = {
  month: '2026-05',
  floor: '2026-01',
  ceiling: '2026-06',
  exportParams: { scope: 'finance', report: 'ledger', month: '2026-05' },
  exportFilename: 'tokenscope-finance-ledger-2026-05.csv',
  drillPending: false,
}

const indexSeen = (w: ReturnType<typeof mount>) => ({
  skeleton: w.find('[data-testid="report-skeleton"]').exists(),
  error: w.find('[data-testid="fetch-error-banner"]').exists(),
  empty: w.find('[data-testid="report-empty"]').exists(),
  data: w.find('[data-testid="finance-index-data"]').exists(),
})

describe('ScopeFinanceView — the index four exclusive states', () => {
  it('SKELETON while pending with no data', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: null, drill: null, isDrill: false, pending: true } })
    expect(indexSeen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('ERROR when the index fetch failed', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: null, drill: null, isDrill: false, pending: false, error: new Error('boom') } })
    const s = indexSeen(w)
    expect(s.error).toBe(true)
    expect([s.skeleton, s.empty, s.data]).toEqual([false, false, false])
  })

  it('EMPTY when the month has no finance data at all', () => {
    const empty = makeReport({
      cous: [],
      billCheck: { chargebackUsd: 0, billUsd: 0, deltaUsd: 0, matched: true, unsettled: false, copilotChargebackUsd: 0, providers: [] },
      exemptGap: { indicativeUsageUsd: 0, chargebackUsd: 0, gapUsd: 0, copilotChargebackUsd: 0 },
    })
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: empty, drill: null, isDrill: false, pending: false } })
    expect(indexSeen(w)).toEqual({ skeleton: false, error: false, empty: true, data: false })
  })

  it('DATA renders the Σ=bill row, exempt-gap card, per-CoU table + homing disclosure + export', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    expect(indexSeen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })
    expect(w.find('[data-testid="finance-bill-check"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-exempt-gap"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-cou-table"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-cou-row-a"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-homing"]').text().toLowerCase()).toContain('current org structure')
    expect(w.find('[data-testid="export-csv-button"]').exists()).toBe(true)
  })

  it('hides the (month-grained) ledger export in a multi-month range, showing a note instead', () => {
    const w = mount(ScopeFinanceView, {
      props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false, ledgerMonthOnly: true },
    })
    expect(w.find('[data-testid="export-csv-button"]').exists()).toBe(false)
    expect(w.find('[data-testid="finance-ledger-month-only"]').text().toLowerCase()).toContain('month-grained')
  })
})

describe('ScopeFinanceView — the Σ=bill check row states', () => {
  it('a MATCHED month renders GREEN "reconciles to bill" with the amounts', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    const check = w.find('[data-testid="finance-bill-check"]')
    expect(check.attributes('data-matched')).toBe('true')
    expect(w.find('[data-testid="finance-bill-check-matched"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-bill-check-unsettled"]').exists()).toBe(false)
    expect(check.text()).toContain('$360') // chargeback = bill amount shown
  })

  it('an UNSETTLED month renders RED "unsettled" with the amounts (never a silent pass)', () => {
    const report = makeReport({
      billCheck: {
        chargebackUsd: 50, billUsd: 50, deltaUsd: 0, matched: false, unsettled: true, copilotChargebackUsd: 50,
        providers: [{ provider: 'github', billUsd: 50, unsettled: true }],
      },
    })
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report, drill: null, isDrill: false, pending: false } })
    const check = w.find('[data-testid="finance-bill-check"]')
    expect(check.attributes('data-matched')).toBe('false')
    const chip = w.find('[data-testid="finance-bill-check-unsettled"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('unsettled')
    expect(check.text()).toContain('$50')
  })
})

describe('ScopeFinanceView — the Copilot chargeback chip (index)', () => {
  it('shows the "pending" chip in pool-utilisation mode', () => {
    const report = makeReport({
      copilot: { mode: 'pool-utilisation', pending: true },
      cous: [{ couId: 'a', code: 'a', displayName: 'Practice A', regionCode: 'ra', anthropicUsd: 50, copilotUsd: 300, copilotPending: true, chargeableUsd: 50 }],
    })
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report, drill: null, isDrill: false, pending: false } })
    expect(w.find('[data-testid="finance-copilot-pending-chip"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-copilot-chargeback-chip"]').exists()).toBe(false)
    // The Copilot column reads "pending", never a leaked charge into the total.
    expect(w.find('[data-testid="finance-cou-row-a"]').text().toLowerCase()).toContain('pending')
  })

  it('shows the "included" chip once chargeback mode is validated', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    expect(w.find('[data-testid="finance-copilot-pending-chip"]').exists()).toBe(false)
    expect(w.find('[data-testid="finance-copilot-chargeback-chip"]').exists()).toBe(true)
  })
})

const drillSeen = (w: ReturnType<typeof mount>) => ({
  skeleton: w.find('[data-testid="report-skeleton"]').exists(),
  error: w.find('[data-testid="fetch-error-banner"]').exists(),
  empty: w.find('[data-testid="report-empty"]').exists(),
  data: w.find('[data-testid="finance-drill-data"]').exists(),
})

describe('ScopeFinanceView — the drill four exclusive states', () => {
  it('SKELETON while the drill is pending with no drill data', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: null, isDrill: true, pending: false, drillPending: true } })
    expect(drillSeen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('ERROR when the drill fetch failed (e.g. a 404)', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: null, isDrill: true, pending: false, drillError: new Error('404') } })
    expect(drillSeen(w).error).toBe(true)
  })

  it('DATA renders the Anthropic charges, Copilot pooled lines, project overlay, Overage Drivers', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    expect(drillSeen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })
    expect(w.find('[data-testid="finance-anthropic-charges"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-copilot-pooled-lines"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-copilot-pool-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="finance-project-overlay"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-overage-drivers"]').exists()).toBe(true)
  })

  it('pool-utilisation mode renders the pool card, NOT the pooled lines, and hides Overage Drivers', () => {
    const drill = makeDrill({
      copilot: { mode: 'pool-utilisation', pending: true, pooledLines: null, poolUtilisation: { usageGrossUsd: 500, poolUsd: 400, utilisation: 1.25 }, chargeableUsd: null, licenseNetUsd: 200, overageNetUsd: 100, unsettled: false },
      chargeableUsd: 50,
      overageDrivers: null,
    })
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false } })
    expect(w.find('[data-testid="finance-copilot-pool-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-copilot-pooled-lines"]').exists()).toBe(false)
    expect(w.find('[data-testid="finance-copilot-pending-note"]').text().toLowerCase()).toContain('pending correct writer')
    expect(w.find('[data-testid="finance-overage-drivers"]').exists()).toBe(false)
    expect(w.find('[data-testid="finance-copilot-pending-chip"]').exists()).toBe(true)
  })
})

describe('ScopeFinanceView — the Overage Drivers panel is INFORMATIONAL', () => {
  it('labels the shares informational — not a charge — and reconciles to the paid overage', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    const panel = w.find('[data-testid="finance-overage-drivers"]')
    expect(panel.exists()).toBe(true)
    expect(panel.find('[data-testid="finance-overage-note"]').text().toLowerCase()).toContain('never a charge')
    // The DriversTable sum-back row reconciles (Σ shares = paid overage) — not RED.
    const sumback = panel.find('[data-testid="drivers-sumback"]')
    expect(sumback.attributes('data-mismatch')).toBe('false')
  })
})

// ── M1: pool-utilisation foot-mismatch honesty (Σ=bill + exempt-gap captions) ──
describe('ScopeFinanceView — pool-utilisation reconciling captions (M1)', () => {
  const poolUtilReport = () =>
    makeReport({
      copilot: { mode: 'pool-utilisation', pending: true },
      // Σ=bill stays whole-truth (300 Copilot pooled net), while the CoU column holds it back.
      cous: [{ couId: 'a', code: 'a', displayName: 'Practice A', regionCode: 'ra', anthropicUsd: 60, copilotUsd: 300, copilotPending: true, chargeableUsd: 60 }],
    })

  it('pool-utilisation mode: the Σ=bill row carries the held-back Copilot caption with the exact amount', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: poolUtilReport(), drill: null, isDrill: false, pending: false } })
    const cap = w.find('[data-testid="finance-bill-copilot-caption"]')
    expect(cap.exists()).toBe(true)
    expect(cap.text().toLowerCase()).toContain('pending cutover')
    expect(cap.text()).toContain('$300') // billCheck.copilotChargebackUsd
  })

  it('pool-utilisation mode: the exempt-gap card carries the same held-back caption', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: poolUtilReport(), drill: null, isDrill: false, pending: false } })
    const cap = w.find('[data-testid="finance-exempt-gap-copilot-caption"]')
    expect(cap.exists()).toBe(true)
    expect(cap.text()).toContain('$300') // exemptGap.copilotChargebackUsd
  })

  it('chargeback mode: NO reconciling captions (the Σ=bill row and the Chargeable column foot)', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    expect(w.find('[data-testid="finance-bill-copilot-caption"]').exists()).toBe(false)
    expect(w.find('[data-testid="finance-exempt-gap-copilot-caption"]').exists()).toBe(false)
  })
})

// ── M2: unsettled CoU-month drill caveats the Chargeable headline + shows amber ──
describe('ScopeFinanceView — unsettled CoU-month drill (M2)', () => {
  const unsettledDrill = () =>
    makeDrill({
      // A pooled line with usage but no read license SKU → chargeableUsd drops the unread license.
      copilot: {
        mode: 'chargeback',
        pending: false,
        pooledLines: [{ orgId: 'o1', label: 'Octo Org', licenseUsd: 0, overageUsd: 50, netUsd: 50, unsettled: true }],
        poolUtilisation: null,
        chargeableUsd: 50,
        licenseNetUsd: 0,
        overageNetUsd: 50,
        unsettled: true,
      },
      chargeableUsd: 50,
      overageDrivers: null,
    })

  it('renders the amber unsettled chip + Chargeable caveat, NOT the green "included" chip', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: unsettledDrill(), isDrill: true, pending: false } })
    expect(w.find('[data-testid="finance-copilot-unsettled-chip"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-copilot-chargeback-chip"]').exists()).toBe(false)
    const caveat = w.find('[data-testid="finance-drill-chargeable-caveat"]')
    expect(caveat.exists()).toBe(true)
    expect(caveat.text().toLowerCase()).toContain('excludes unread license')
  })

  it('a settled drill still shows the green "included" chip and no caveat', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    expect(w.find('[data-testid="finance-copilot-chargeback-chip"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-copilot-unsettled-chip"]').exists()).toBe(false)
    expect(w.find('[data-testid="finance-drill-chargeable-caveat"]').exists()).toBe(false)
  })
})
