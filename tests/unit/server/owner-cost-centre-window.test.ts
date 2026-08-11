// @vitest-environment node
/*
 * The P&L-owner card's WINDOW resolution.
 *
 * `/me/cost-centres` is the Cost-Centre reporting scope's primary table, and that
 * scope carries a period control — so the card windows on the period it is asked
 * for. The rule that matters is the one `server/utils/period.ts` spends a header
 * on: the upper bound is NEVER in the future. A window that reaches past `now`
 * counts rows that have not been spent yet inside a figure the page calls burn,
 * and no fixture whose rows are all in the past can ever catch it — which is
 * exactly why this is asserted here, on the pure function, rather than left to an
 * end-to-end figure.
 */
import { describe, it, expect } from 'vitest'
import { resolveOwnerWindow, ownerWindowDates } from '../../../server/api/v1/me/cost-centres.get'

const NOW = new Date('2026-07-14T09:30:00.000Z')

describe('resolveOwnerWindow', () => {
  it('defaults to MONTH TO DATE — the upper bound is now, not the month end', () => {
    const w = resolveOwnerWindow({}, NOW)
    expect(w.startIso).toBe('2026-07-01T00:00:00.000Z')
    expect(w.endIso).toBe('2026-07-14T09:30:00.000Z')
    expect(w.endIso).not.toBe('2026-08-01T00:00:00.000Z')
    expect(w.runsToNow).toBe(true)
  })

  it('the CURRENT month asked for by name is the same month-to-date window', () => {
    expect(resolveOwnerWindow({ month: '2026-07' }, NOW)).toEqual(resolveOwnerWindow({}, NOW))
  })

  it('a COMPLETED month is its whole calendar month, half-open at the next month start', () => {
    const w = resolveOwnerWindow({ month: '2026-06' }, NOW)
    expect(w.startIso).toBe('2026-06-01T00:00:00.000Z')
    expect(w.endIso).toBe('2026-07-01T00:00:00.000Z')
    // A month that has finished cannot run out of budget in the future.
    expect(w.runsToNow).toBe(false)
  })

  it('a FUTURE month collapses to an empty window rather than inverting', () => {
    const w = resolveOwnerWindow({ month: '2026-09' }, NOW)
    expect(w.startIso).toBe('2026-09-01T00:00:00.000Z')
    expect(w.endIso).toBe('2026-09-01T00:00:00.000Z')
    expect(new Date(w.endIso).getTime()).toBeGreaterThanOrEqual(new Date(w.startIso).getTime())
  })

  it('a custom range is half-open on the day AFTER `to`, so `to` is included', () => {
    const w = resolveOwnerWindow({ from: '2026-05-01', to: '2026-05-31' }, NOW)
    expect(w.startIso).toBe('2026-05-01T00:00:00.000Z')
    expect(w.endIso).toBe('2026-06-01T00:00:00.000Z')
    expect(w.runsToNow).toBe(false)
  })

  it('a range reaching into the FUTURE is clamped at now — never an open upper bound', () => {
    const w = resolveOwnerWindow({ from: '2026-07-01', to: '2026-12-31' }, NOW)
    expect(w.endIso).toBe('2026-07-14T09:30:00.000Z')
    expect(w.runsToNow).toBe(true)
  })

  it('a range that already ended is NOT stretched to now', () => {
    const w = resolveOwnerWindow({ from: '2026-05-01', to: '2026-05-10' }, NOW)
    expect(w.endIso).toBe('2026-05-11T00:00:00.000Z')
    expect(w.runsToNow).toBe(false)
  })

  it('a partial range is rejected rather than silently becoming a month', () => {
    expect(() => resolveOwnerWindow({ from: '2026-05-01' }, NOW)).toThrow()
    expect(() => resolveOwnerWindow({ to: '2026-05-01' }, NOW)).toThrow()
  })
})

/*
 * `isMonthToDate` is a SEPARATE fact from `runsToNow`, and the separation is the
 * whole point: `exhaustionDate` divides spend by the DAY OF THE MONTH, so it is
 * arithmetic about a month-to-date window and nothing else. Gating it on "does
 * this window reach now" let a quarter-to-date range — two months of burn — be
 * divided by the 14th and printed as a run-out date.
 */
describe('resolveOwnerWindow — which window licenses an MTD projection', () => {
  it('is true for the default, for the current month by name, and for a range that IS MTD', () => {
    expect(resolveOwnerWindow({}, NOW).isMonthToDate).toBe(true)
    expect(resolveOwnerWindow({ month: '2026-07' }, NOW).isMonthToDate).toBe(true)
    // Structural, not param-shaped: this range resolves to exactly [Jul 1, now).
    expect(resolveOwnerWindow({ from: '2026-07-01', to: '2026-12-31' }, NOW).isMonthToDate).toBe(true)
  })

  it('is FALSE for a longer window that still runs to now — the divisor would not fit', () => {
    const w = resolveOwnerWindow({ from: '2026-05-01', to: '2026-12-31' }, NOW)
    expect(w.runsToNow).toBe(true) // it IS live…
    expect(w.isMonthToDate).toBe(false) // …and still not month-to-date
  })

  it('is FALSE for a completed month and for a range that ended in the past', () => {
    expect(resolveOwnerWindow({ month: '2026-06' }, NOW).isMonthToDate).toBe(false)
    expect(resolveOwnerWindow({ from: '2026-05-01', to: '2026-05-10' }, NOW).isMonthToDate).toBe(false)
  })
})

describe('the effective window a caller can label', () => {
  it('names a whole calendar month, and only a whole calendar month', () => {
    expect(resolveOwnerWindow({ month: '2026-06' }, NOW).month).toBe('2026-06')
    // Month-to-date is NOT June-the-month; claiming it would label a partial
    // period with a complete one's name.
    expect(resolveOwnerWindow({}, NOW).month).toBeNull()
    expect(resolveOwnerWindow({ from: '2026-06-01', to: '2026-06-29' }, NOW).month).toBeNull()
    // …but a RANGE that happens to cover the whole month is that month.
    expect(resolveOwnerWindow({ from: '2026-06-01', to: '2026-06-30' }, NOW).month).toBe('2026-06')
  })

  it('reports an INCLUSIVE `to` — the exclusive bound would name a day it excludes', () => {
    expect(ownerWindowDates(resolveOwnerWindow({ month: '2026-06' }, NOW))).toEqual({
      from: '2026-06-01',
      to: '2026-06-30', // never 2026-07-01
    })
    expect(ownerWindowDates(resolveOwnerWindow({ from: '2026-07-01', to: '2026-12-31' }, NOW))).toEqual({
      from: '2026-07-01',
      to: '2026-07-14', // clamped at now, not the requested December
    })
  })

  it('a collapsed (future) window does not report a `to` before its `from`', () => {
    expect(ownerWindowDates(resolveOwnerWindow({ month: '2026-09' }, NOW))).toEqual({
      from: '2026-09-01',
      to: '2026-09-01',
    })
  })
})
