// @vitest-environment node
/*
 * Run-rate + quota projections (brief §6.4) — pure math, edge cases:
 * day 1 of month, already exhausted, no allocation, beyond month-end, and the
 * three ADR 0012 defects that live in this file:
 *
 *   - `exhaustionDate` could only say "already exhausted" by returning TODAY,
 *     which the UI rendered as "on pace to exhaust your quota ~<today>" while
 *     the quota had in fact been passed weeks earlier at 2.2x. `quotaProjection`
 *     returns the state instead, with the overage.
 *   - `runRate` on the LAST day of the month scales by days_in_month /
 *     days_elapsed == 1, so "on pace for ~$X by month end" is the month-to-date
 *     figure relabelled. `is_projection` marks that day so the UI can withhold
 *     the forecast.
 *   - the exhaustion date was a day late: `daysToExhaust` was added to the
 *     first instant of the month, which is the START of the day AFTER the one
 *     the quota runs out on. Ten $10 days exhaust $100 on the 10th, not the
 *     11th. All five bare-date surfaces move with the correction.
 */
import { describe, it, expect } from 'vitest'
import { exhaustionDate, quotaProjection, runRate } from '../../../server/usage/projections'

describe('runRate (linear-mtd, AEUF billing.py:486 port)', () => {
  it('scales MTD by days_in_month / days_elapsed', () => {
    // 2026-06-15: $100 over 15 of 30 days → $200 projected
    const r = runRate(100, new Date('2026-06-15T12:00:00Z'))
    expect(r.projected_month_end_usd).toBe('200.00')
    expect(r.days_elapsed).toBe(15)
    expect(r.days_in_month).toBe(30)
    expect(r.method).toBe('linear-mtd')
    expect(r.is_projection).toBe(true)
  })

  it('day 1 of the month does not divide by zero or explode', () => {
    const r = runRate(10, new Date('2026-06-01T03:00:00Z'))
    expect(r.days_elapsed).toBe(1)
    expect(r.projected_month_end_usd).toBe('300.00') // 10 × 30/1
    expect(r.is_projection).toBe(true)
  })

  it('handles 31-day and 28-day months', () => {
    expect(runRate(31, new Date('2026-07-31T00:00:00Z')).projected_month_end_usd).toBe('31.00')
    expect(runRate(14, new Date('2027-02-14T00:00:00Z')).days_in_month).toBe(28)
  })

  it('is NOT a projection on the last day of the month — the scale factor is 1', () => {
    /*
     * The shipped card said "on pace for ~$1,449.70 by month end · day 31 of
     * 31" while the headline said $1,449.70. A forecast that equals the figure
     * it forecasts from tells the reader nothing; the flag is what lets the UI
     * stop pretending otherwise.
     */
    const lastDay = runRate(1449.7, new Date('2026-07-31T06:27:00Z'))
    expect(lastDay.days_elapsed).toBe(31)
    expect(lastDay.days_in_month).toBe(31)
    expect(lastDay.projected_month_end_usd).toBe('1449.70') // == the MTD it came from
    expect(lastDay.is_projection).toBe(false)
    // 30-day month, day 30 — same identity, same verdict.
    expect(runRate(500, new Date('2026-06-30T23:00:00Z')).is_projection).toBe(false)
    // The day before is still a real projection.
    expect(runRate(500, new Date('2026-06-29T23:00:00Z')).is_projection).toBe(true)
  })
})

describe('quotaProjection (the STATE, not a date that has to be read for what it is not)', () => {
  const midJune = new Date('2026-06-15T12:00:00Z')

  it('projects a within-month exhaustion date at the MTD daily rate', () => {
    // $150 over 15 days = $10/day; a $200 quota takes 20 of those, and the
    // 20th lands on day 20 — 20 June.
    expect(quotaProjection(150, 200, midJune)).toEqual({ state: 'projected', date: '2026-06-20' })
  })

  it('says EXHAUSTED, with the overage, when the quota is already passed', () => {
    /*
     * The headline defect: at 221% of quota the product said "on pace to
     * exhaust your quota ~2026-07-31". It is not on pace to be exhausted; it IS
     * exhausted. The overage is arithmetic on two figures the reader can see —
     * deliberately NOT a back-projected "you passed it around the 14th", which
     * would be an extrapolation dressed up as a fact.
     */
    expect(quotaProjection(6846.35, 3100, midJune)).toEqual({
      state: 'exhausted',
      over_usd: '3746.35',
    })
    // Exactly at the quota counts as exhausted (matches the >= 100% RAG bar).
    expect(quotaProjection(300, 300, midJune)).toEqual({ state: 'exhausted', over_usd: '0.00' })
  })

  it('distinguishes no-quota from no-spend rather than collapsing both to null', () => {
    expect(quotaProjection(100, 0, midJune)).toEqual({ state: 'no-quota' })
    expect(quotaProjection(0, 300, midJune)).toEqual({ state: 'no-spend' })
  })

  it('exhaustion that lands in a FUTURE month → not-at-this-pace (MTD resets at month-end)', () => {
    // $10/day vs $310 needs day 31, and June has 30 → next month → not "this month"
    expect(quotaProjection(150, 310, midJune)).toEqual({ state: 'not-at-this-pace' })
    // slow burn ($1/day vs $300 → ~day 300) likewise → never year-2999
    expect(quotaProjection(15, 300, midJune)).toEqual({ state: 'not-at-this-pace' })
    // Guard the guard: the cap must sit at the month boundary and not one day
    // inside it. $300 is the largest quota June's pace still reaches — if this
    // were also not-at-this-pace the case above would prove nothing about WHERE
    // the cap falls, only that a big enough quota trips it.
    expect(quotaProjection(150, 300, midJune)).toEqual({ state: 'projected', date: '2026-06-30' })
  })
})

describe('quotaProjection — the day the quota runs out ON (day semantics)', () => {
  const midJune = new Date('2026-06-15T12:00:00Z')

  it('names the day the exhausting increment lands on, not the day after it', () => {
    /*
     * $50 MTD on 5 January is $10/day; ten of those exhaust a $100 quota ON
     * the 10th. The shipped arithmetic added `daysToExhaust` to the first
     * INSTANT of the month, which is the start of day 11 — every quota-runout
     * date the product printed was a day late.
     */
    const jan5 = new Date('2026-01-05T09:00:00Z')
    expect(quotaProjection(50, 100, jan5)).toEqual({ state: 'projected', date: '2026-01-10' })
    expect(exhaustionDate(50, 100, jan5)).toBe('2026-01-10')
  })

  it('rolls a part-day overshoot to the day spend actually crosses the quota', () => {
    // $10/day vs $205: 20 whole days leave $5 outstanding, so it is crossed
    // during day 21 — the ceiling, not the floor, of daysToExhaust.
    expect(quotaProjection(150, 205, midJune)).toEqual({ state: 'projected', date: '2026-06-21' })
  })

  it('never back-dates the runout onto a day that has already elapsed', () => {
    // A cent under the quota on day 15: imminent, but it has NOT happened —
    // the `exhausted` state is what says that, and a date must stay ahead.
    const p = quotaProjection(299.99, 300, midJune)
    expect(p).toEqual({ state: 'projected', date: '2026-06-16' })
    expect(p.state === 'projected' && p.date > '2026-06-15').toBe(true)
  })

  it('holds for operand pairs whose quotient is NOT exactly representable', () => {
    /*
     * The other tests in this describe all use operands whose float division
     * happens to be exact ($10/day against $100, $205, $300), so they pin the
     * day semantics only where binary arithmetic was never going to argue.
     * Both cases below are decimally exact and binary-noisy:
     *
     *   100.23 / (33.41 / 1) === 3.0000000000000004  → ceil 4, the day AFTER
     *   300.60 / (10.02 / 1) === 30.000000000000004  → ceil 31, past June
     *
     * The first prints a date one day late — the very defect the DAY SEMANTICS
     * block claims to have fixed. The second is worse than late: day 31 trips
     * the month-end cap, so a developer whose quota runs out ON 30 June is told
     * `not-at-this-pace` and shown no warning at all.
     */
    const jun1 = new Date('2026-06-01T09:00:00Z')
    expect(quotaProjection(33.41, 100.23, jun1)).toEqual({ state: 'projected', date: '2026-06-03' })
    expect(quotaProjection(10.02, 300.6, jun1)).toEqual({ state: 'projected', date: '2026-06-30' })
    expect(exhaustionDate(10.02, 300.6, jun1)).toBe('2026-06-30')
  })

  it('rounds down only inside money precision, never over a real cent', () => {
    /*
     * Guard the guard for the tolerance itself. The half-cent window must not
     * be wide enough to swallow a genuine shortfall: one cent short of the
     * quota after N days means the quota is crossed on day N+1, and that has to
     * survive. $10.00/day against a $100.01 quota is exactly that case.
     */
    const jun1 = new Date('2026-06-01T09:00:00Z')
    expect(quotaProjection(10, 100.01, jun1)).toEqual({ state: 'projected', date: '2026-06-11' })
    expect(quotaProjection(10, 100, jun1)).toEqual({ state: 'projected', date: '2026-06-10' })
  })
})

// NOT "behaviour unchanged" — that title survived the commit that changed the
// behaviour. exhaustionDate delegates to quotaProjection, so the day-semantics
// correction moved every date it returns one day earlier; the assertions below
// carry the corrected values.
describe('exhaustionDate — the date-shaped view of the same arithmetic', () => {
  const midJune = new Date('2026-06-15T12:00:00Z')

  it('projects a within-month exhaustion date at the MTD daily rate', () => {
    expect(exhaustionDate(150, 200, midJune)).toBe('2026-06-20')
  })

  it('already exhausted → today (the lossy encoding the state type exists to replace)', () => {
    expect(exhaustionDate(350, 300, midJune)).toBe('2026-06-15')
  })

  it('no allocation or no spend → null', () => {
    expect(exhaustionDate(100, 0, midJune)).toBeNull()
    expect(exhaustionDate(0, 300, midJune)).toBeNull()
  })

  it('exhaustion that lands in a FUTURE month → null (MTD resets at month-end; no cross-month projection)', () => {
    expect(exhaustionDate(150, 310, midJune)).toBeNull()
    expect(exhaustionDate(15, 300, midJune)).toBeNull()
    // Guard the guard, as above: $300 is the last quota June's pace reaches, so
    // the null cases prove the cap sits at the month boundary rather than one
    // day inside it. The five bare-date surfaces move with this correction.
    expect(exhaustionDate(150, 300, midJune)).toBe('2026-06-30')
  })

  it('agrees with quotaProjection on every state — one implementation, two views', () => {
    // The five surfaces still rendering a bare date must keep reading the SAME
    // arithmetic the state type reports; a second copy is how they would drift.
    const cases: [number, number][] = [
      [150, 200],
      [350, 300],
      [100, 0],
      [0, 300],
      [150, 300],
      [150, 310],
      [150, 205],
      [299.99, 300],
      [15, 300],
    ]
    for (const [mtd, quota] of cases) {
      const p = quotaProjection(mtd, quota, midJune)
      const d = exhaustionDate(mtd, quota, midJune)
      if (p.state === 'projected') expect(d).toBe(p.date)
      else if (p.state === 'exhausted') expect(d).toBe('2026-06-15')
      else expect(d).toBeNull()
    }
  })
})
