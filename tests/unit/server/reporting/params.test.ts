/*
 * reporting/params — the date-range + unified-window resolution (the reporting
 * endpoints' shared param heart). Pure: no DB, no router, `now` injected.
 *
 * Covers: resolveReportRange (from/to parse → half-open UTC range, inclusive `to`,
 * partial/invalid → 400) and resolveReportWindow (default-to-month back-compat +
 * range branch + month↔range discriminator).
 */
import { describe, it, expect } from 'vitest'
import {
  resolveReportRange,
  resolveReportWindow,
  resolveReportMonth,
} from '../../../../server/reporting/params'

/** Run `fn`, returning the thrown error's `statusCode` (or `undefined` if it did not throw). */
function statusOf(fn: () => unknown): number | undefined {
  try {
    fn()
    return undefined
  } catch (e) {
    return (e as { statusCode?: number }).statusCode
  }
}

describe('resolveReportRange', () => {
  it('returns null when NEITHER from nor to is present (caller falls back to month)', () => {
    expect(resolveReportRange({})).toBeNull()
    expect(resolveReportRange({ from: undefined, to: undefined })).toBeNull()
  })

  it('parses from/to into a HALF-OPEN UTC range with an inclusive `to` (to + 1 day)', () => {
    const r = resolveReportRange({ from: '2026-07-05', to: '2026-07-20' })
    expect(r).not.toBeNull()
    expect(r!.from).toBe('2026-07-05')
    expect(r!.to).toBe('2026-07-20')
    expect(r!.startIso).toBe('2026-07-05T00:00:00.000Z')
    // inclusive 20th → exclusive end is the 21st at 00:00Z
    expect(r!.endIso).toBe('2026-07-21T00:00:00.000Z')
  })

  it('a single-day range spans exactly one UTC day', () => {
    const r = resolveReportRange({ from: '2026-02-28', to: '2026-02-28' })!
    expect(r.startIso).toBe('2026-02-28T00:00:00.000Z')
    expect(r.endIso).toBe('2026-03-01T00:00:00.000Z')
  })

  it('a range ending on a month/year boundary rolls the exclusive end forward', () => {
    const r = resolveReportRange({ from: '2026-12-01', to: '2026-12-31' })!
    expect(r.endIso).toBe('2027-01-01T00:00:00.000Z')
  })

  it('a PARTIAL range (exactly one of from/to) is a 400', () => {
    expect(statusOf(() => resolveReportRange({ from: '2026-07-01' }))).toBe(400)
    expect(statusOf(() => resolveReportRange({ to: '2026-07-01' }))).toBe(400)
  })

  it('a non-real date (bad shape or 2026-02-30) is a 400', () => {
    expect(statusOf(() => resolveReportRange({ from: 'July', to: '2026-07-01' }))).toBe(400)
    expect(statusOf(() => resolveReportRange({ from: '2026-2-1', to: '2026-07-01' }))).toBe(400)
    expect(statusOf(() => resolveReportRange({ from: '2026-02-30', to: '2026-03-01' }))).toBe(400)
    expect(statusOf(() => resolveReportRange({ from: '2026-13-01', to: '2026-13-02' }))).toBe(400)
  })

  it('from > to is a 400', () => {
    expect(statusOf(() => resolveReportRange({ from: '2026-07-20', to: '2026-07-05' }))).toBe(400)
  })

  it('a span beyond the max (MAX_RANGE_DAYS) is a 400, but the cap itself is allowed', () => {
    // A pathological range (full-history scan / unusable heatmap axis) is rejected.
    expect(statusOf(() => resolveReportRange({ from: '2000-01-01', to: '2100-01-01' }))).toBe(400)
    // Exactly the cap (400 inclusive days from a fixed start) is fine.
    expect(resolveReportRange({ from: '2026-01-01', to: '2027-02-04' })).not.toBeNull()
  })
})

describe('resolveReportWindow — default-to-month back-compat', () => {
  it('with no from/to and no month, defaults to the current UTC month (identical to resolveReportMonth)', () => {
    const now = new Date('2026-05-15T12:00:00.000Z')
    const win = resolveReportWindow({}, { now })
    const { month, range } = resolveReportMonth(undefined, { now })
    expect(win.isMonth).toBe(true)
    expect(win.monthStr).toBe(month)
    expect(win.monthStr).toBe('2026-05')
    expect(win.startIso).toBe(range.startIso)
    expect(win.endIso).toBe(range.endIso)
    expect(win.monthRange).not.toBeNull()
  })

  it('an explicit month resolves to that month window with inclusive from/to dates', () => {
    const win = resolveReportWindow({ month: '2026-02' }, { now: new Date('2026-05-15T00:00:00Z') })
    expect(win.isMonth).toBe(true)
    expect(win.monthStr).toBe('2026-02')
    expect(win.startIso).toBe('2026-02-01T00:00:00.000Z')
    expect(win.endIso).toBe('2026-03-01T00:00:00.000Z')
    expect(win.from).toBe('2026-02-01')
    expect(win.to).toBe('2026-02-28') // inclusive last day of Feb 2026
  })
})

describe('resolveReportWindow — custom range branch', () => {
  it('from/to WIN over month, mark isMonth=false and carry no monthRange', () => {
    const win = resolveReportWindow({ month: '2026-05', from: '2026-07-03', to: '2026-07-08' })
    expect(win.isMonth).toBe(false)
    expect(win.monthStr).toBeNull()
    expect(win.monthRange).toBeNull()
    expect(win.from).toBe('2026-07-03')
    expect(win.to).toBe('2026-07-08')
    expect(win.startIso).toBe('2026-07-03T00:00:00.000Z')
    expect(win.endIso).toBe('2026-07-09T00:00:00.000Z')
  })

  it('propagates the range 400 (partial range) through the window resolver', () => {
    expect(statusOf(() => resolveReportWindow({ from: '2026-07-03' }))).toBe(400)
  })
})
