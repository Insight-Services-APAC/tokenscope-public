// @vitest-environment node
/*
 * Run-rate + exhaustion projections (brief §6.4) — pure math, edge cases:
 * day 1 of month, already exhausted, no allocation, beyond month-end.
 */
import { describe, it, expect } from 'vitest'
import { exhaustionDate, runRate } from '../../../server/usage/projections'

describe('runRate (linear-mtd, AEUF billing.py:486 port)', () => {
  it('scales MTD by days_in_month / days_elapsed', () => {
    // 2026-06-15: $100 over 15 of 30 days → $200 projected
    const r = runRate(100, new Date('2026-06-15T12:00:00Z'))
    expect(r.projected_month_end_usd).toBe('200.00')
    expect(r.days_elapsed).toBe(15)
    expect(r.days_in_month).toBe(30)
    expect(r.method).toBe('linear-mtd')
  })

  it('day 1 of the month does not divide by zero or explode', () => {
    const r = runRate(10, new Date('2026-06-01T03:00:00Z'))
    expect(r.days_elapsed).toBe(1)
    expect(r.projected_month_end_usd).toBe('300.00') // 10 × 30/1
  })

  it('handles 31-day and 28-day months', () => {
    expect(runRate(31, new Date('2026-07-31T00:00:00Z')).projected_month_end_usd).toBe('31.00')
    expect(runRate(14, new Date('2027-02-14T00:00:00Z')).days_in_month).toBe(28)
  })
})

describe('exhaustionDate', () => {
  const midJune = new Date('2026-06-15T12:00:00Z')

  it('projects a within-month exhaustion date at the MTD daily rate', () => {
    // $150 over 15 days = $10/day; $200 allocation → day 20 (Jun 21)
    expect(exhaustionDate(150, 200, midJune)).toBe('2026-06-21')
  })

  it('already exhausted → today', () => {
    expect(exhaustionDate(350, 300, midJune)).toBe('2026-06-15')
  })

  it('no allocation or no spend → null', () => {
    expect(exhaustionDate(100, 0, midJune)).toBeNull()
    expect(exhaustionDate(0, 300, midJune)).toBeNull()
  })

  it('exhaustion that lands in a FUTURE month → null (MTD resets at month-end; no cross-month projection)', () => {
    // $10/day vs $300 → day 30 (Jul 1) is next month → not "this month"
    expect(exhaustionDate(150, 300, midJune)).toBeNull()
    // slow burn ($1/day vs $300 → ~day 300) likewise → null, never year-2999
    expect(exhaustionDate(15, 300, midJune)).toBeNull()
  })
})
