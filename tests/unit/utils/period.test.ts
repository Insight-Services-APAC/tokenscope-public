// @vitest-environment node
/*
 * period — reporting month-navigation helpers (reporting-consolidation Wave 1).
 * Half-open UTC ranges, explicit UTC day/days-in-month, YYYY-MM validation.
 */
import { describe, it, expect } from 'vitest'
import {
  MONTH_REGEX,
  daysInMonthUtc,
  isValidMonth,
  monthKeyUtc,
  monthRangeUtc,
  utcDayOfMonth,
} from '../../../server/utils/period'

describe('monthRangeUtc', () => {
  it('returns a half-open [monthStart, nextMonthStart) UTC range', () => {
    const r = monthRangeUtc('2026-06')
    expect(r.startIso).toBe('2026-06-01T00:00:00.000Z')
    expect(r.endIso).toBe('2026-07-01T00:00:00.000Z')
    expect(r.monthStartUtc.getTime()).toBe(Date.UTC(2026, 5, 1))
    expect(r.nextMonthStartUtc.getTime()).toBe(Date.UTC(2026, 6, 1))
    expect(r.month).toBe('2026-06')
  })

  it('rolls the year over at December', () => {
    const r = monthRangeUtc('2026-12')
    expect(r.startIso).toBe('2026-12-01T00:00:00.000Z')
    expect(r.endIso).toBe('2027-01-01T00:00:00.000Z')
  })

  it('is HALF-OPEN: the last instant of the month is IN range, the next-month start is OUT', () => {
    const r = monthRangeUtc('2026-06')
    const lastInstant = new Date('2026-06-30T23:59:59.999Z')
    const nextStart = new Date('2026-07-01T00:00:00.000Z')
    expect(lastInstant >= r.monthStartUtc && lastInstant < r.nextMonthStartUtc).toBe(true)
    expect(nextStart < r.nextMonthStartUtc).toBe(false) // excluded — lands in July
  })

  it('throws on a malformed month', () => {
    expect(() => monthRangeUtc('2026-13')).toThrow()
    expect(() => monthRangeUtc('2026-6')).toThrow()
    expect(() => monthRangeUtc('nope')).toThrow()
  })
})

describe('isValidMonth / MONTH_REGEX', () => {
  it('accepts YYYY-MM with month 01-12', () => {
    expect(isValidMonth('2026-01')).toBe(true)
    expect(isValidMonth('2026-12')).toBe(true)
    expect(MONTH_REGEX.test('1999-07')).toBe(true)
  })
  it('rejects out-of-range or mis-shaped months', () => {
    expect(isValidMonth('2026-00')).toBe(false)
    expect(isValidMonth('2026-13')).toBe(false)
    expect(isValidMonth('2026-6')).toBe(false)
    expect(isValidMonth('26-06')).toBe(false)
    expect(isValidMonth('2026-06-01')).toBe(false)
  })
})

describe('utcDayOfMonth / daysInMonthUtc / monthKeyUtc', () => {
  it('utcDayOfMonth is the UTC calendar day', () => {
    expect(utcDayOfMonth(new Date('2026-06-10T23:00:00Z'))).toBe(10)
    expect(utcDayOfMonth(new Date('2026-06-01T00:00:00Z'))).toBe(1)
  })

  it('daysInMonthUtc handles 30/31/28/29-day months', () => {
    expect(daysInMonthUtc(new Date('2026-06-15T00:00:00Z'))).toBe(30) // June
    expect(daysInMonthUtc(new Date('2026-07-15T00:00:00Z'))).toBe(31) // July
    expect(daysInMonthUtc(new Date('2027-02-15T00:00:00Z'))).toBe(28) // Feb non-leap
    expect(daysInMonthUtc(new Date('2028-02-15T00:00:00Z'))).toBe(29) // Feb leap
  })

  it('monthKeyUtc is the YYYY-MM of the UTC month', () => {
    expect(monthKeyUtc(new Date('2026-06-30T23:59:59Z'))).toBe('2026-06')
    expect(monthKeyUtc(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01')
  })
})
