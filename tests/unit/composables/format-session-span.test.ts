/*
 * #577: a session reads by when it ran ("Mon 9 Nov, 14:05 to 16:40"), in the
 * viewer's zone; #587: an instant reads "10 Nov 2026, 08:10".
 */
import { describe, it, expect } from 'vitest'
import { fmtInstant, fmtSessionSpan, fmtSpanDuration } from '../../../app/composables/useFormat'

// Brisbane is UTC+10 with no daylight saving, so these never drift.
const BNE = 'Australia/Brisbane'

describe('fmtSessionSpan', () => {
  it('a same-day session reads weekday, date, start and end', () => {
    expect(fmtSessionSpan('2026-11-09T04:05:00Z', '2026-11-09T06:40:00Z', BNE)).toBe('Mon 9 Nov, 14:05 to 16:40')
  })

  it('a session that crosses midnight shows both dates', () => {
    expect(fmtSessionSpan('2026-11-06T13:10:00Z', '2026-11-06T14:25:00Z', BNE)).toBe('Fri 6 Nov, 23:10 to Sat 7 Nov, 00:25')
  })

  it('renders in the zone it is given: the same instants read differently in UTC', () => {
    expect(fmtSessionSpan('2026-11-06T13:10:00Z', '2026-11-06T14:25:00Z', 'UTC', { utcLabel: true })).toBe(
      'Fri 6 Nov, 13:10 to 14:25 UTC',
    )
  })

  it('a one-instant session shows one time', () => {
    expect(fmtSessionSpan('2026-11-09T04:05:00Z', '2026-11-09T04:05:00Z', BNE)).toBe('Mon 9 Nov, 14:05')
  })

  it('a missing start falls back to the end; a missing end is a dash', () => {
    expect(fmtSessionSpan(null, '2026-11-09T04:05:00Z', BNE)).toBe('Mon 9 Nov, 14:05')
    expect(fmtSessionSpan('2026-11-09T04:05:00Z', null, BNE)).toBe('—')
  })
})

describe('fmtSpanDuration', () => {
  it('rounds to the minute', () => {
    expect(fmtSpanDuration('2026-11-09T04:05:00Z', '2026-11-09T06:40:00Z')).toBe('2 h 35 min')
    expect(fmtSpanDuration('2026-11-09T04:05:00Z', '2026-11-09T04:40:00Z')).toBe('35 min')
    expect(fmtSpanDuration('2026-11-09T04:05:00Z', '2026-11-09T06:05:00Z')).toBe('2 h')
    expect(fmtSpanDuration('2026-11-09T04:05:00Z', '2026-11-09T04:05:20Z')).toBe('under a minute')
  })
  it('a dash when it cannot say', () => {
    expect(fmtSpanDuration(null, '2026-11-09T06:40:00Z')).toBe('—')
    expect(fmtSpanDuration('2026-11-09T06:40:00Z', '2026-11-09T04:05:00Z')).toBe('—')
  })
})

describe('fmtInstant', () => {
  it('reads day, short month, year and 24-hour time', () => {
    expect(fmtInstant('2026-11-09T22:10:00Z', BNE)).toBe('10 Nov 2026, 08:10')
  })
  it('accepts a Postgres text timestamp', () => {
    expect(fmtInstant('2026-11-09 22:10:00+00', BNE)).toBe('10 Nov 2026, 08:10')
  })
  it('a dash for nothing or nonsense', () => {
    expect(fmtInstant(null)).toBe('—')
    expect(fmtInstant('not a time')).toBe('—')
  })
})
