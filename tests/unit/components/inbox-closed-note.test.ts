/*
 * closedNote (#630, #631): the sentence an item the worker closed shows in the
 * drawer and the Closed list. Periods are UTC provider periods, so the month
 * and week must read the same in any viewer zone.
 */
import { describe, it, expect } from 'vitest'
import { closedNote } from '../../../app/components/inbox/types'

const resolved = (body: Record<string, unknown>) => ({ ack_state: 'resolved' as const, body })

describe('closedNote', () => {
  it('names the month that is over', () => {
    expect(closedNote(resolved({ closed_reason: 'period-ended', closed_month: '2026-10' }))).toBe(
      'Closed automatically: October 2026 is over.',
    )
  })

  it('names the week that is over, as a UTC day', () => {
    expect(closedNote(resolved({ closed_reason: 'period-ended', closed_week_start: '2026-11-02' }))).toBe(
      'Closed automatically: the week of 2 Nov 2026 is over.',
    )
  })

  it('says the budget was raised, with the new budget', () => {
    expect(closedNote(resolved({ closed_reason: 'budget-raised', closed_cap_usd: 1500 }))).toMatch(
      /^Closed automatically: the budget was raised to \$1.500 and the project is inside it\.$/,
    )
  })

  it('says nothing for an item a person closed, or an open item', () => {
    expect(closedNote(resolved({}))).toBeNull()
    expect(closedNote({ ack_state: 'dismissed', body: { closed_reason: 'period-ended', closed_month: '2026-10' } })).toBeNull()
    expect(closedNote({ ack_state: 'unread', body: {} })).toBeNull()
  })

  it('a malformed period still reads as a sentence, never as raw data', () => {
    expect(closedNote(resolved({ closed_reason: 'period-ended', closed_month: 'oops' }))).toBe(
      'Closed automatically: the period it was about is over.',
    )
  })
})
