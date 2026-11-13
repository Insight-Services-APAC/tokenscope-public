/*
 * budgetPeriodWords (#632): a budget period as days a person reads, the end
 * inclusive, for a viewer in any zone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { budgetPeriodWords, lastDayOf } from '../../../shared/budgets/period-words'

describe('budgetPeriodWords', () => {
  let tz: string | undefined
  beforeAll(() => {
    // A zone behind UTC: a local-Date implementation would read 31 Aug as 30 Aug.
    tz = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
  })
  afterAll(() => {
    process.env.TZ = tz
  })

  it('a calendar month reads 1 to 31 Aug 2026', () => {
    expect(budgetPeriodWords('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')).toBe('1 to 31 Aug 2026')
  })

  it('an end of 1 Sep (exclusive) reads "to 31 Aug 2026"', () => {
    expect(lastDayOf('2026-09-01T00:00:00.000Z')).toBe('2026-08-31')
    expect(budgetPeriodWords('2026-08-15T00:00:00.000Z', '2026-09-01T00:00:00.000Z')).toBe('15 to 31 Aug 2026')
  })

  it('spans months and years', () => {
    expect(budgetPeriodWords('2026-08-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z')).toBe('15 Aug to 14 Sep 2026')
    expect(budgetPeriodWords('2026-12-15T00:00:00.000Z', '2027-01-15T00:00:00.000Z')).toBe('15 Dec 2026 to 14 Jan 2027')
  })

  it('one day, and an end that is not midnight', () => {
    expect(budgetPeriodWords('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z')).toBe('1 Aug 2026')
    expect(budgetPeriodWords('2026-08-01T00:00:00.000Z', '2026-08-03T12:00:00.000Z')).toBe('1 to 3 Aug 2026')
  })

  it('open-ended and missing bounds', () => {
    expect(budgetPeriodWords('2026-08-01T00:00:00.000Z', null)).toBe('From 1 Aug 2026, no end date')
    expect(budgetPeriodWords(null, '2026-09-01T00:00:00.000Z')).toBe('Until 31 Aug 2026')
    expect(budgetPeriodWords(null, null)).toBe('No period set')
  })
})
