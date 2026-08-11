// @vitest-environment happy-dom
/*
 * BudgetStateCell — T11 (developer pages build D15.2): the against-budget cell's
 * three-state truth table, pinned ONCE for every consumer, plus the per-bucket
 * pace line (07-r1-M4: per-row projectedMonthEnd, never the portfolio figure).
 *
 * MUTATIONS these pin:
 *  - collapse null-allocation and absent-allocation into one state → the
 *    truth-table tests go red (a missing decision is not "not applicable");
 *  - divide by a zero allocation → the Infinity test goes red;
 *  - print the PORTFOLIO projection under each row (the 07-r1-M4 defect) →
 *    the two-rows test goes red (both lines would read the same ~$X);
 *  - revert DriversTable's re-mount to an inline cell → the consumer test
 *    goes red (one implementation, not two).
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BudgetStateCell from '../../../app/components/reporting/BudgetStateCell.vue'
import DriversTable from '../../../app/components/reporting/DriversTable.vue'
import { projectedMonthEnd } from '../../../app/composables/useRagState'
import type { DriverRow } from '#shared/reports/types'

/*
 * The pace line renders in one of TWO elements now: a projection that lands
 * OVER budget leads with the multiple in `budget-state-pace-over`, one that
 * lands under keeps the quiet `budget-state-pace`. These tests are about the
 * per-bucket FIGURE (07-r1-M4 — never the portfolio's), which is unchanged, so
 * they read whichever element the component chose rather than pinning the
 * routing they were never about.
 */
function paceText(w: { find: (s: string) => { exists: () => boolean; text: () => string } }): string {
  const over = w.find('[data-testid="budget-state-pace-over"]')
  return over.exists() ? over.text() : w.find('[data-testid="budget-state-pace"]').text()
}
function paceExists(w: { find: (s: string) => { exists: () => boolean } }): boolean {
  return w.find('[data-testid="budget-state-pace-over"]').exists()
    || w.find('[data-testid="budget-state-pace"]').exists()
}


describe('BudgetStateCell — the three-state truth table (T11)', () => {
  it('a real allocation renders CONSUMPTION against it — "87% of $6,024.00"', () => {
    const w = mount(BudgetStateCell, { props: { usd: 5240.88, budgetUsd: 6024 } })
    const text = w.text().replace(/\s+/g, ' ')
    expect(text).toContain('87%')
    expect(text).toContain('of $6,024.00')
    // Over-budget tints red via costCentreBudgetState — the ONE tint function.
    const over = mount(BudgetStateCell, { props: { usd: 7000, budgetUsd: 6024 } })
    expect(over.find('[data-testid="budget-state-consumed"]').classes()).toContain('text-rag-red')
    expect(w.find('[data-testid="budget-state-consumed"]').classes()).toContain('text-rag-amber')
  })

  it('`budgetUsd: null` says "no budget set" — never 0% and never $0', () => {
    const w = mount(BudgetStateCell, { props: { usd: 2246.09, budgetUsd: null } })
    expect(w.text()).toContain('no budget set')
    expect(w.text()).not.toContain('%')
    expect(w.text()).not.toContain('$0')
  })

  it('an ABSENT budgetUsd renders not-applicable "—", not "no budget set"', () => {
    const w = mount(BudgetStateCell, { props: { usd: 100 } })
    expect(w.text().trim()).toBe('—')
    expect(w.text()).not.toContain('no budget set')
    expect(w.find('[aria-label="not applicable"]').exists()).toBe(true)
  })

  it('a ZERO allocation reads as no budget, never an infinite consumption', () => {
    const w = mount(BudgetStateCell, { props: { usd: 40, budgetUsd: 0 } })
    expect(w.text()).toContain('no budget set')
    expect(w.text()).not.toContain('Infinity')
    expect(w.text()).not.toContain('NaN')
  })
})

describe('BudgetStateCell — the pace line is PER BUCKET (07-r1-M4)', () => {
  // Two rows, same calendar (day 10 of 30), different spends: each line must
  // carry ITS OWN landing and neither may print the portfolio figure.
  const CAL = { daysElapsed: 10, daysInMonth: 30 }
  const rowA = { usd: 400, projected: projectedMonthEnd(400, CAL.daysElapsed, CAL.daysInMonth) }
  const rowB = { usd: 620, projected: projectedMonthEnd(620, CAL.daysElapsed, CAL.daysInMonth) }
  const portfolio = projectedMonthEnd(400 + 620, CAL.daysElapsed, CAL.daysInMonth)

  it('two rows, different spends → different ~$X; neither equals the portfolio figure', () => {
    const a = mount(BudgetStateCell, {
      props: { usd: rowA.usd, budgetUsd: 1000, projectedUsd: rowA.projected, monthEnd: 'July 31' },
    })
    const b = mount(BudgetStateCell, {
      props: { usd: rowB.usd, budgetUsd: 1000, projectedUsd: rowB.projected, monthEnd: 'July 31' },
    })
    const lineA = paceText(a)
    const lineB = paceText(b)
    // Both projections land OVER their budget, so both lead with the multiple.
    expect(lineA).toContain('~$1,200.00')
    expect(lineA).toContain('July 31')
    expect(lineB).toContain('~$1,860.00')
    expect(lineB).toContain('July 31')
    expect(lineA).not.toBe(lineB)
    // The 07-r1-M4 defect: the hero's portfolio landing under each pill.
    expect(portfolio).not.toBeNull()
    for (const line of [lineA, lineB]) {
      expect(line).not.toContain('$3,060.00')
    }
  })

  it('no projection passed → no pace line (the caller decides admission)', () => {
    const w = mount(BudgetStateCell, { props: { usd: 400, budgetUsd: 1000 } })
    expect(paceExists(w)).toBe(false)
  })

  it('falls back to "month end" when no date label is given', () => {
    const w = mount(BudgetStateCell, {
      props: { usd: 400, budgetUsd: 1000, projectedUsd: 1200 },
    })
    expect(paceText(w)).toContain('by month end')
  })
})

describe('BudgetStateCell — DriversTable consumes the ONE implementation', () => {
  it('the against-budget column renders through BudgetStateCell, per row state', () => {
    const rows: DriverRow[] = [
      { key: 'p1', label: 'Apollo', usd: 5240.88, sharePct: 0.7, spendClass: 'indicative', budgetUsd: 6024 },
      { key: 'p2', label: 'Borealis', usd: 2246.09, sharePct: 0.3, spendClass: 'indicative', budgetUsd: null },
    ]
    const w = mount(DriversTable, {
      props: { rows, headlineUsd: 7486.97, denominatorLabel: 'cost-centre usage' },
    })
    const p1 = w.find('[data-testid="drivers-budget-p1"]')
    expect(p1.find('[data-testid="budget-state-cell"]').exists()).toBe(true)
    expect(p1.text().replace(/\s+/g, ' ')).toContain('87% of $6,024.00')
    const p2 = w.find('[data-testid="drivers-budget-p2"]')
    expect(p2.find('[data-testid="budget-state-cell"]').exists()).toBe(true)
    expect(p2.text()).toContain('no budget set')
  })
})

describe('BudgetStateCell — the over-budget threshold is the RATIO, not the rounded percent', () => {
  /*
   * Regression, external review. `projectedOverPct` rounded before comparing, so
   * a projection at 100.3% became 100, failed `> 100`, and the row rendered with
   * the quiet under-budget treatment — the single case the loud treatment exists
   * for. Boundary values only: 100.3% must be loud, exactly 100% must not.
   */
  it('a projection just over budget is treated as over, not rounded away', () => {
    const w = mount(BudgetStateCell, {
      props: { usd: 400, budgetUsd: 1000, projectedUsd: 1003, monthEnd: 'July 31' },
    })
    expect(w.find('[data-testid="budget-state-pace-over"]').exists()).toBe(true)
    expect(w.find('[data-testid="budget-state-pace"]').exists()).toBe(false)
  })

  it('a projection landing exactly ON budget is not over', () => {
    const w = mount(BudgetStateCell, {
      props: { usd: 400, budgetUsd: 1000, projectedUsd: 1000, monthEnd: 'July 31' },
    })
    expect(w.find('[data-testid="budget-state-pace-over"]').exists()).toBe(false)
    expect(w.find('[data-testid="budget-state-pace"]').exists()).toBe(true)
  })
})
