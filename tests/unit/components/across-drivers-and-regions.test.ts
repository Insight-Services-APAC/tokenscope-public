// @vitest-environment happy-dom
/*
 * The whole-company Top-drivers card and the Regions card — the two halves of
 * `docs/design/reporting-consolidation/prototype.html` fix 4 / fix 4a.
 *
 * fix 4a is a DE-DUPLICATION, and that is what makes it testable from two sides.
 * Region used to be answered twice — a ranked bar here, a pivot of Top drivers
 * there — and the two disagreed about both the values and the rank order. So this
 * file asserts both halves of the single home: the Regions card now carries the
 * columns a bar chart could not (people, share), and the drivers card no longer
 * offers the axis at all.
 *
 * The pivot list is asserted as an ORDERED, EXACT list rather than by
 * `not.toContain('Region')`: an axis re-added anywhere in the row is the
 * divergence coming back, and a containment check would not see it.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RegionRankCard from '../../../app/components/reporting/across/RegionRankCard.vue'
import TopDriversCard from '../../../app/components/reporting/across/TopDriversCard.vue'
import type {
  AcrossRegionCard,
  AcrossChargebackRegion,
  AcrossDriversResp,
} from '../../../app/components/reporting/across-report-types'
import type { DriverRow } from '../../../shared/reports/types'

// ─────────────────────────────────────────────────────────────────────────────
// Regions card
// ─────────────────────────────────────────────────────────────────────────────

function card(over: Partial<AcrossRegionCard> = {}): AcrossRegionCard {
  return {
    regionId: 'ra',
    code: 'ra',
    displayName: 'Region A',
    genuineUsd: 50,
    anthropicChargeableUsd: 12,
    copilotChargeableUsd: 0,
    chargeableUsd: 12,
    activeUsers: 2,
    avgPerUserUsd: 25,
    // Deliberately WRONG on the wire, so a card reading this field instead of
    // deriving its own share renders 99% and fails. Two places rendering one
    // fact is the very thing fix 4a is about.
    sharePct: 0.99,
    ...over,
  }
}

const CARDS: AcrossRegionCard[] = [
  card({ regionId: 'rb', displayName: 'Region B', genuineUsd: 30, activeUsers: 6 }),
  card(),
  card({ regionId: null, displayName: 'Unassigned', genuineUsd: 20, activeUsers: 1 }),
]

const CHARGEBACK: AcrossChargebackRegion[] = [
  { regionId: 'ra', label: 'Region A', chargeableUsd: 12 },
  { regionId: 'rb', label: 'Region B', chargeableUsd: 8 },
]

const mountRegions = (lane: 'usage' | 'chargeback' = 'usage') =>
  mount(RegionRankCard, { props: { cards: CARDS, chargebackRows: CHARGEBACK, lane } })

describe('Regions is a TABLE with people and share, not a bare ranked bar (fix 4a)', () => {
  it('names four columns: Region · People · Attributed usage · Share', () => {
    const headers = mountRegions().findAll('thead th').map((th) => th.text())
    expect(headers).toEqual(['Region', 'People', 'Attributed usage', 'Share'])
  })

  it('ranks by usage DESC and carries each region’s own headcount', () => {
    const w = mountRegions()
    const cells = w.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => td.text()))
    expect(cells.map((c) => c[0])).toEqual(['Region A', 'Region B', 'UnassignedNo region'])
    expect(cells.map((c) => c[1])).toEqual(['2', '6', '1'])
    expect(cells.map((c) => c[2])).toEqual(['$50.00', '$30.00', '$20.00'])
  })

  it('derives share from the rows ON SCREEN, never from the card’s own sharePct', () => {
    // 50/100, 30/100, 20/100 — the fixture's `sharePct: 0.99` must not appear.
    const shares = mountRegions()
      .findAll('tbody tr')
      .map((tr) => tr.findAll('td').at(-1)!.text())
    expect(shares).toEqual(['50%', '30%', '20%'])
  })

  it('the Unassigned bucket is badged and is NOT a drill button', () => {
    const w = mountRegions()
    const last = w.findAll('tbody tr').at(-1)!
    expect(last.text()).toContain('No region')
    expect(last.find('button').exists()).toBe(false)
    // …while a real region is one, and emits its id.
    const first = w.findAll('tbody tr')[0]!
    first.find('[data-testid="across-region-drill"]').trigger('click')
    expect(w.emitted('select')?.[0]).toEqual(['ra'])
  })

  /*
   * PEOPLE IS §A-ONLY. An active-developer count is a usage fact;
   * `v_finance_chargeback_month` has no equivalent, and borrowing the §A count to
   * sit beside a §B charge would put two concerns in one row. The column is
   * ABSENT in the chargeback lane rather than blank or borrowed.
   */
  it('the chargeback lane drops People, renames the value column, and re-ranks off the bill', () => {
    const w = mountRegions('chargeback')
    const headers = w.findAll('thead th').map((th) => th.text())
    expect(headers).toEqual(['Region', 'Chargeback', 'Share'])
    const cells = w.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => td.text()))
    // Ranked off `chargebackRows` (12, 8) — NOT off the usage cards (50, 30, 20).
    expect(cells.map((c) => c[1])).toEqual(['$12.00', '$8.00'])
    expect(cells.map((c) => c.at(-1))).toEqual(['60%', '40%'])
  })

  it('says so when no region carries spend, rather than rendering an empty table', () => {
    const w = mount(RegionRankCard, {
      props: { cards: [], chargebackRows: [], lane: 'usage' },
    })
    expect(w.find('[data-testid="across-region-empty"]').text()).toContain('No region carries spend')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Top drivers card
// ─────────────────────────────────────────────────────────────────────────────

function driverRow(over: Partial<DriverRow> = {}): DriverRow {
  return { key: 'p1', label: 'Atlas', usd: 60, sharePct: 0.6, spendClass: 'indicative', ...over }
}

function drivers(over: Partial<AcrossDriversResp> = {}): AcrossDriversResp {
  return {
    axis: 'project',
    headlineUsd: 100,
    rows: [driverRow(), driverRow({ key: 'p2', label: 'Borealis', usd: 40, sharePct: 0.4 })],
    concentration: null as never,
    measureLanes: { rows: 'attributed', headlineUsd: 'attributed' },
    ...over,
  }
}

const mountDrivers = (props: Record<string, unknown> = {}) =>
  mount(TopDriversCard, {
    props: { drivers: drivers(), axis: 'project', ...props },
    global: { stubs: { ClientOnly: { template: '<div><slot /></div>' }, VChart: true } },
  })

describe('Top drivers lists PROJECTS, and neither Region nor Model is one of its pivots (fix 4 / 4a, 07-build D6)', () => {
  it('offers exactly Budget · Practice · Teammate · Surface, in that order', () => {
    // Model left the same way Region did: the dedicated Top models card beside
    // this one is the single model surface (07-model-axis-subtraction-build.md
    // D6, owner 2026-08-04). The ENDPOINT still accepts axis=model — that is
    // the dedicated card's own fetch, not a pivot here.
    const chips = mountDrivers()
      .findAll('[data-testid="drivers-axis"] button')
      .map((b) => b.text())
    expect(chips).toEqual(['Budget', 'Practice', 'Teammate', 'Surface'])
    expect(chips).not.toContain('Model')
  })

  it('has no region chip, and no dead drill BUTTON on any row (drill contract, fix 7)', () => {
    const w = mountDrivers()
    expect(w.find('[data-testid="drivers-axis-region"]').exists()).toBe(false)
    /*
     * The old assertion was "every axis label button still renders; none of them
     * navigates any more" — which is exactly the live-looking dead button the
     * drill contract (developer pages D29) removes. Without drill grants every
     * name is PLAIN TEXT: no button, no link, nothing to click and nothing
     * announced as actionable.
     */
    expect(w.find('[data-testid="drivers-drill"]').exists()).toBe(false)
    expect(w.find('[data-testid="drivers-drill-link"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="drivers-plain"]').length).toBeGreaterThan(0)
    expect(w.emitted('drill')).toBeUndefined()
  })

  it('renders ONE ranking — the table’s own bars, not a second chart above it', () => {
    const w = mountDrivers()
    expect(w.findAll('[data-testid^="drivers-bar-"]')).toHaveLength(2)
    expect(w.find('.chart-ranked-bar').exists()).toBe(false)
    expect(w.findAllComponents({ name: 'ChartRankedBar' })).toHaveLength(0)
  })

  it('re-emits the chip press as update:axis', async () => {
    const w = mountDrivers()
    await w.find('[data-testid="drivers-axis-teammate"]').trigger('click')
    expect(w.emitted('update:axis')?.[0]).toEqual(['teammate'])
  })
})

/*
 * prototype.html lines 780-781 + `note('lane', …)`: the card's lede names the
 * lane and promises "Every pivot sums to that lane's total". That is a CLAIM, so
 * it may only be made where it holds — and Dev has exactly one pivot where it
 * does not: the BUDGET axis answers `attributed` even under the chargeback
 * toggle, because `provider_usage_fact` has no project column.
 */
describe('Top drivers states the lane its rows are on, and only promises a sum-back it keeps', () => {
  it('names the attributed lane and promises the sum-back', () => {
    const w = mountDrivers()
    expect(w.find('[data-testid="across-drivers-lane"]').text()).toBe(
      'What is driving whole-company spend on the attributed lane.',
    )
    expect(w.find('[data-testid="across-drivers-sumback-note"]').text()).toBe(
      "Every pivot sums to that lane's total.",
    )
  })

  it('names the billed lane when the rows are billed', () => {
    const w = mountDrivers({
      drivers: drivers({ measureLanes: { rows: 'billed', headlineUsd: 'billed' } }),
      lane: 'chargeback',
    })
    expect(w.find('[data-testid="across-drivers-lane"]').text()).toContain('billed lane')
    expect(w.find('[data-testid="across-drivers-sumback-note"]').text()).toBe(
      "Every pivot sums to that lane's total.",
    )
  })

  it('a pivot answering OFF the page’s lane states its own denominator instead', () => {
    // The budget axis under chargeback: rows are attributed while the page is
    // billed. The promise would be false here, so it is not made.
    const w = mountDrivers({ drivers: drivers(), lane: 'chargeback', axis: 'project' })
    expect(w.find('[data-testid="across-drivers-sumback-note"]').text()).toBe(
      'This pivot answers on the attributed lane and sums to its own total, not to the billed headline.',
    )
  })

  it('the value column carries the CALLER’s period word, never a hardcoded month', () => {
    const headers = mountDrivers({ periodLabel: 'July 2026' })
      .findAll('thead th')
      .map((th) => th.text())
    expect(headers).toContain('July 2026')
    expect(headers).not.toContain('This month')
  })
})
