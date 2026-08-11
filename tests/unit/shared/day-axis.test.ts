/*
 * T1 — the partial day renders PARTIAL, not zero.
 * T4 — the shaper is pure and clock-free.
 *
 * THE DEFECT THESE PIN. `padDays` and `StackedBars`' dense axis both zero-filled
 * a trailing window ending at the BROWSER's today, so the current day was
 * emitted with a genuine `0` — an assertion the server explicitly refuses to
 * make ("a FUTURE day is NOT emitted, because nothing has been measured there",
 * `usage-series.ts`). A three-hour-old day drawn at zero reads as a collapse.
 * NULL IS NOT 0, and this project's recurring defect class is exactly that
 * substitution.
 *
 * The clock-freedom assertions are not ceremony: the whole slice rests on the
 * shaper being a function of arguments only, so `vi.setSystemTime` moving a year
 * must not move a single output.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { dayAxis, denseDays, padOnto } from '../../../shared/reports/day-axis'

afterEach(() => {
  vi.useRealTimers()
})

describe('denseDays — the settled run', () => {
  it('is `count` days ending at endDay INCLUSIVE, ascending', () => {
    expect(denseDays('2026-08-04', 3)).toEqual(['2026-08-02', '2026-08-03', '2026-08-04'])
  })

  it('crosses month and year boundaries', () => {
    expect(denseDays('2026-09-01', 2)).toEqual(['2026-08-31', '2026-09-01'])
    expect(denseDays('2027-01-01', 2)).toEqual(['2026-12-31', '2027-01-01'])
    expect(denseDays('2028-03-01', 2)).toEqual(['2028-02-29', '2028-03-01'])
  })

  it('yields [] rather than throwing on a nonsense count — a chart may not fail to render', () => {
    expect(denseDays('2026-08-04', 0)).toEqual([])
    expect(denseDays('2026-08-04', -5)).toEqual([])
    expect(denseDays('2026-08-04', Number.NaN)).toEqual([])
  })
})

describe('T1 — the still-filling day is never a fabricated zero', () => {
  const endDay = '2026-08-04' // settledThrough
  const today = '2026-08-05'

  it('a today with NO data does not appear on the axis at all', () => {
    // The morning dip, precisely: at 09:00 Sydney the current UTC day is three
    // hours old and empty. Padding it to 0 draws a collapse; omitting it draws
    // the truth, which is that the day is not finished.
    const axis = dayAxis({ endDay, days: 3, partialDay: today, presentDays: ['2026-08-03'] })
    expect(axis.days).toEqual(['2026-08-02', '2026-08-03', '2026-08-04'])
    expect(axis.days).not.toContain(today)
    expect(axis.partialDay).toBeNull()
  })

  it('a today WITH data appears BEYOND the edge, marked partial', () => {
    const axis = dayAxis({ endDay, days: 3, partialDay: today, presentDays: [today] })
    expect(axis.days).toEqual(['2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'])
    expect(axis.partialDay).toBe(today)
    // Beyond, not instead of: the settled run is intact underneath it.
    expect(axis.days.slice(0, 3)).toEqual(denseDays(endDay, 3))
  })

  it('the partial marker echoes the SAME decision that shaped the axis', () => {
    // A key that re-derives "is today on the axis" is how a legend ends up
    // claiming a treatment the chart did not apply.
    const absent = dayAxis({ endDay, days: 3, partialDay: today, presentDays: [] })
    expect(absent.days.includes(absent.partialDay ?? '')).toBe(false)
    const present = dayAxis({ endDay, days: 3, partialDay: today, presentDays: [today] })
    expect(present.days.includes(present.partialDay!)).toBe(true)
  })

  it('a partialDay at or before the edge is not admitted twice', () => {
    // It is already a settled day on the run; adding it again would duplicate a
    // bar and mark a COMPLETE day as still accruing.
    const axis = dayAxis({ endDay, days: 3, partialDay: endDay, presentDays: [endDay] })
    expect(axis.days).toEqual(['2026-08-02', '2026-08-03', '2026-08-04'])
    expect(axis.partialDay).toBeNull()
  })

  it('no partialDay at all is the plain settled run', () => {
    expect(dayAxis({ endDay, days: 2 })).toEqual({
      days: ['2026-08-03', '2026-08-04'],
      partialDay: null,
    })
  })

  it('a SETTLED day with no rows IS zero-filled — that zero was measured', () => {
    const rows = [{ day: '2026-08-02', v: 5 }]
    const out = padOnto(rows, denseDays(endDay, 3), (day) => ({ day, v: 0 }))
    expect(out).toEqual([
      { day: '2026-08-02', v: 5 },
      { day: '2026-08-03', v: 0 },
      { day: '2026-08-04', v: 0 },
    ])
  })
})

describe('T4 — pure and clock-free', () => {
  it('moving the system clock a YEAR changes nothing', () => {
    const input = {
      endDay: '2026-08-04',
      days: 5,
      partialDay: '2026-08-05',
      presentDays: ['2026-08-05'],
    }
    vi.useFakeTimers({ toFake: ['Date'] })

    vi.setSystemTime(new Date('2026-08-05T09:00:00Z'))
    const a = dayAxis(input)
    const padA = padOnto([{ day: '2026-08-03', v: 1 }], a.days, (day) => ({ day, v: 0 }))

    vi.setSystemTime(new Date('2027-02-17T23:59:00Z'))
    const b = dayAxis(input)
    const padB = padOnto([{ day: '2026-08-03', v: 1 }], b.days, (day) => ({ day, v: 0 }))

    expect(b).toEqual(a)
    expect(padB).toEqual(padA)
    // …and the answer is the one the ARGUMENTS name, not the one the clock does.
    expect(a.days.at(-1)).toBe('2026-08-05')
  })

  it('takes no clock argument and reads no ambient day', () => {
    // If a default sneaks back in, this is the assertion that catches it: the
    // axis for a window in 2019 must be entirely in 2019.
    const { days } = dayAxis({ endDay: '2019-03-04', days: 3 })
    expect(days.every((d) => d.startsWith('2019-03'))).toBe(true)
  })

  it('refuses a malformed endDay rather than silently anchoring somewhere', () => {
    expect(() => denseDays('05/08/2026', 3)).toThrow(/YYYY-MM-DD/)
  })
})
