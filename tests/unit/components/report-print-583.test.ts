// @vitest-environment happy-dom
/*
 * #583: reports print cleanly.
 *
 * What can be proven without a browser's print preview (the chart sizing and
 * page breaks are checked by eye on dev, per the issue):
 *   - the printed header states scope, period as UTC dates, lens, settling
 *     state and the server clock's time, and is hidden on screen;
 *   - the period comes from the payload's own window (a month is its whole UTC
 *     month, leap years included; a custom range is printed as sent);
 *   - a view publishes its facts to the page, and publishing without a page is
 *     a no-op (views mount in tests without one);
 *   - the region view's lens follows the selected lane, so a chargeback print
 *     never carries a Usage label;
 *   - Print calls the browser's print, and every control the print must drop
 *     is marked print:hidden.
 */
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, nextTick, type Ref } from 'vue'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ReportPrintHeader from '../../../app/components/reporting/ReportPrintHeader.vue'
import PrintButton from '../../../app/components/reporting/PrintButton.vue'
import ScopeRegionalView from '../../../app/components/reporting/ScopeRegionalView.vue'
import {
  providePrintFacts,
  publishPrintFacts,
  billMonthsWindow,
  printPeriod,
  settlingLine,
  windowFromMeta,
  type ReportPrintFacts,
} from '../../../app/components/reporting/print-facts'
import { makeReport, regionalViewGlobal } from './helpers/regional-report-fixture'

const facts: ReportPrintFacts = {
  scope: 'APAC',
  from: '2026-11-01',
  to: '2026-11-30',
  lens: 'chargeback',
  settling: [
    { vendor: 'anthropic', state: 'settling' },
    { vendor: 'usage', state: 'estimated' },
  ],
}

describe('windowFromMeta', () => {
  it('a month is its whole UTC month', () => {
    expect(windowFromMeta({ month: '2026-11' })).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(windowFromMeta({ month: '2026-12' })).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  })
  it('February follows the leap-year rule', () => {
    expect(windowFromMeta({ month: '2028-02' }).to).toBe('2028-02-29')
    expect(windowFromMeta({ month: '2026-02' }).to).toBe('2026-02-28')
    expect(windowFromMeta({ month: '2100-02' }).to).toBe('2100-02-28')
    expect(windowFromMeta({ month: '2000-02' }).to).toBe('2000-02-29')
  })
  it('a custom range is printed as the server sent it', () => {
    expect(windowFromMeta({ month: '2026-10', range: { from: '2026-10-05', to: '2026-11-04' } })).toEqual({
      from: '2026-10-05',
      to: '2026-11-04',
    })
  })
})

describe('printPeriod: the app\'s date style, read off the UTC day strings', () => {
  it('one month, across months, across years, one day', () => {
    expect(printPeriod('2026-11-01', '2026-11-30')).toBe('1 to 30 Nov 2026 (UTC)')
    expect(printPeriod('2026-10-28', '2026-11-03')).toBe('28 Oct to 3 Nov 2026 (UTC)')
    expect(printPeriod('2026-12-28', '2027-01-03')).toBe('28 Dec 2026 to 3 Jan 2027 (UTC)')
    expect(printPeriod('2026-11-05', '2026-11-05')).toBe('5 Nov 2026 (UTC)')
  })
})

describe('billMonthsWindow: Finance prints the whole months its bill sums', () => {
  it('a custom range widens to the months it touches; a month stays a month', () => {
    expect(billMonthsWindow({ month: '2026-10', range: { from: '2026-10-05', to: '2026-11-04' } })).toEqual({
      from: '2026-10-01',
      to: '2026-11-30',
    })
    expect(billMonthsWindow({ month: '2026-10' })).toEqual({ from: '2026-10-01', to: '2026-10-31' })
  })
})

describe('settlingLine', () => {
  it('names each vendor in the chips\' own words, never "finalised"', () => {
    const line = settlingLine([...facts.settling, { vendor: 'github', state: 'settled' }])
    expect(line).toBe('Anthropic: Settling · Usage: Estimated · GitHub Copilot: Provisional')
    expect(line.toLowerCase()).not.toContain('final')
  })
})

describe('ReportPrintHeader', () => {
  it('states scope, UTC period, lens, settling and the server time, print-only', () => {
    const w = mount(ReportPrintHeader, { props: { facts, asOf: '2026-11-11T03:20:00.000Z' } })
    const el = w.get('[data-testid="report-print-header"]')
    expect(el.classes()).toEqual(expect.arrayContaining(['hidden', 'print:block']))
    expect(el.text()).toContain('APAC')
    expect(w.get('[data-testid="report-print-period"]').text()).toBe('1 to 30 Nov 2026 (UTC)')
    expect(w.get('[data-testid="report-print-lens"]').text()).toBe('Chargeback')
    expect(w.get('[data-testid="report-print-settling"]').text()).toBe('Anthropic: Settling · Usage: Estimated')
    expect(w.get('[data-testid="report-print-as-of"]').text()).toMatch(/^Page loaded .*2026/)
  })

  it('renders nothing until a view has published, and says so when the clock has not landed', () => {
    expect(mount(ReportPrintHeader, { props: { facts: null, asOf: null } }).html()).not.toContain('report-print-header')
    const w = mount(ReportPrintHeader, { props: { facts, asOf: null } })
    expect(w.get('[data-testid="report-print-as-of"]').text()).toBe('Page load time unavailable')
  })
})

describe('publishPrintFacts', () => {
  it('is a no-op without a page to publish to', () => {
    const View = defineComponent({
      setup() {
        publishPrintFacts(() => facts)
        return () => h('div')
      },
    })
    expect(() => mount(View)).not.toThrow()
  })

  it('publishes while mounted and clears on unmount', async () => {
    let holder: Ref<ReportPrintFacts | null> | null = null
    const View = defineComponent({
      setup() {
        publishPrintFacts(() => facts)
        return () => h('div')
      },
    })
    const Page = defineComponent({
      props: { show: Boolean },
      setup(props) {
        holder = providePrintFacts()
        return () => (props.show ? h(View) : h('div'))
      },
    })
    const w = mount(Page, { props: { show: true } })
    await nextTick()
    expect(holder!.value).toEqual(facts)
    await w.setProps({ show: false })
    expect(holder!.value).toBeNull()
  })
})

describe('the region view publishes its own window and lane', () => {
  function mountUnderPage(lane: 'usage' | 'chargeback') {
    let holder: Ref<ReportPrintFacts | null> | null = null
    const report = makeReport()
    const Page = defineComponent({
      setup() {
        holder = providePrintFacts()
        return () =>
          h(ScopeRegionalView, {
            report,
            drivers: null,
            modelDrivers: null,
            concentration: null,
            trend: null,
            activeTrend: null,
            behaviour: null,
            pending: false,
            lane,
            driversAxis: 'project',
            exportParams: {},
            exportFilename: 'x.csv',
          })
      },
    })
    mount(Page, { global: regionalViewGlobal })
    return { facts: holder!.value, report }
  }

  it('usage', async () => {
    const { facts: f, report } = mountUnderPage('usage')
    await nextTick()
    expect(f?.lens).toBe('usage')
    expect({ from: f?.from, to: f?.to }).toEqual(windowFromMeta(report.meta))
    expect(f?.settling.map((s) => s.state)).toEqual(report.meta.providerStates.map((p) => p.state))
  })

  it('chargeback', async () => {
    const { facts: f } = mountUnderPage('chargeback')
    await nextTick()
    expect(f?.lens).toBe('chargeback')
  })
})

describe('Print', () => {
  it('opens the browser print dialog', async () => {
    const spy = vi.fn()
    vi.stubGlobal('print', spy)
    const w = mount(PrintButton)
    await w.get('[data-testid="print-button"]').trigger('click')
    expect(spy).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it('every control a print drops is marked print:hidden where it is defined', () => {
    const root = resolve(__dirname, '../../..')
    const files = [
      'app/components/nav/AppHeader.vue',
      'app/components/reporting/LaneToggle.vue',
      'app/components/reporting/DateRangeControl.vue',
      'app/components/ui/RegionSelector.vue',
      'app/components/ui/InfoDot.vue',
      'app/components/reporting/ExportCsvButton.vue',
      'app/components/reporting/PrintButton.vue',
      'app/components/charts/ViewSwitch.vue',
      // PR 590 review: the report cards' own toggles, and Finance's period picker
      // (the printed header already states the period).
      'app/components/reporting/DriversTable.vue',
      'app/components/reporting/regional/RegionalSpendTrend.vue',
      'app/components/reporting/across/SpendTrendCard.vue',
      'app/components/reporting/ChargebackTrendCard.vue',
      'app/components/reporting/FinancePeriodControl.vue',
    ]
    for (const f of files) expect(readFileSync(resolve(root, f), 'utf8'), f).toContain('print:hidden')
    // A hidden toggle leaves its choice on the page as print-only text, so the
    // figures can still be read: which breakdown, lines or stacked, $ or share.
    for (const [f, id] of [
      ['app/components/reporting/DriversTable.vue', 'drivers-axis-print'],
      ['app/components/reporting/regional/RegionalSpendTrend.vue', 'regional-trend-mode-print'],
      ['app/components/reporting/across/SpendTrendCard.vue', 'across-trend-mode-print'],
      ['app/components/reporting/ChargebackTrendCard.vue', 'chargeback-trend-unit-print'],
    ] as const) {
      const src = readFileSync(resolve(root, f), 'utf8')
      const at = src.indexOf(`data-testid="${id}"`)
      expect(at, f).toBeGreaterThan(-1)
      expect(src.slice(src.lastIndexOf('<span', at), at), f).toContain('hidden print:inline')
    }
    expect(readFileSync(resolve(root, 'app/components/ui/Card.vue'), 'utf8')).toContain('print:break-inside-avoid')
    expect(readFileSync(resolve(root, 'app/assets/css/main.css'), 'utf8')).toMatch(/@media print[\s\S]*thead[\s\S]*table-header-group/)
  })
})
