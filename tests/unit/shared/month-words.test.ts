// @vitest-environment node
/*
 * #641: every short month in the product comes from ONE table, so September
 * reads "Sep" everywhere. Node's (and current browsers') en-GB data says "Sept",
 * so each case here goes red if its formatter falls back to Intl's own word.
 */
import { describe, it, expect } from 'vitest'
import { MONTH_SHORT, formatMonthWords, monthShort } from '../../../shared/format/month-words'
import { fmtInstant, fmtSessionSpan, fmtUtcDay } from '../../../app/composables/useFormat'
import { budgetPeriodWords } from '../../../shared/budgets/period-words'
import { settlingDay } from '../../../shared/reports/settling-words'
import { isoWeekLabel } from '../../../app/components/reporting/charts/chart-utils'

describe('the month table (#641)', () => {
  it('is the twelve words the SPEC writes', () => {
    expect(MONTH_SHORT.join(' ')).toBe('Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec')
    expect(monthShort(9)).toBe('Sep')
    expect(monthShort(13)).toBeUndefined()
  })

  it('swaps only the month part and keeps the locale order', () => {
    const t = Date.UTC(2026, 8, 2, 12, 30)
    expect(formatMonthWords('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }, t)).toBe(
      '2 Sep 2026',
    )
    expect(formatMonthWords('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }, t)).toBe('Sep 2')
  })

  it('reads the month in the formatter zone, not the host zone', () => {
    // 30 Sep 23:30 UTC is already 1 Oct in Sydney.
    const t = Date.UTC(2026, 8, 30, 23, 30)
    expect(formatMonthWords('en-GB', { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' }, t)).toBe('1 Oct')
    expect(formatMonthWords('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }, t)).toBe('30 Sep')
  })
})

describe('September reads "Sep" on every path (#641)', () => {
  it('an instant', () => {
    expect(fmtInstant('2026-09-02T12:30:00Z', 'UTC')).toBe('2 Sep 2026, 12:30')
  })
  it('a UTC day', () => {
    expect(fmtUtcDay('2026-09-08')).toBe('8 Sep')
    expect(fmtUtcDay('2026-09-08', { year: true })).toBe('8 Sep 2026')
  })
  it('a session span', () => {
    expect(fmtSessionSpan('2026-09-07T14:05:00Z', '2026-09-07T16:40:00Z', 'UTC')).toBe('Mon 7 Sep, 14:05 to 16:40')
  })
  it('a budget period, a settling day and a week label', () => {
    expect(budgetPeriodWords('2026-09-01T00:00:00Z', '2026-12-31T00:00:00Z')).toBe('1 Sep to 30 Dec 2026')
    expect(settlingDay('2026-09-01')).toBe('1 Sep 2026')
    expect(isoWeekLabel('2026-W37')).toBe('Sep 07')
  })
})
