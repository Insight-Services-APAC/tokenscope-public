/*
 * analytics-poll window — unit tests for the trailing revision window.
 *
 * Anthropic cost revises for up to ~30 days. The earlier start-of-current-month
 * window orphaned late prior-month revisions once the month rolled over (a May 28
 * revision was invisible from June 1), silently mis-counting actual_spend (the
 * bill-anchored money surface, mig 0059). analyticsPollWindow must re-pull a
 * trailing 30-day window that CROSSES the month boundary. See
 * docs/design/bill-anchored-reconciliation-and-existence.md §5.
 */
import { describe, it, expect } from 'vitest'
import { analyticsPollWindow, ANTHROPIC_REVISION_WINDOW_DAYS } from '../../../server/workers/registry'

describe('analyticsPollWindow', () => {
  it('ends at today (UTC date)', () => {
    const { endingAt } = analyticsPollWindow(new Date('2026-06-24T09:00:00Z'))
    expect(endingAt).toBe('2026-06-24')
  })

  it('starts exactly 30 days before today', () => {
    const { startingAt } = analyticsPollWindow(new Date('2026-06-24T09:00:00Z'))
    expect(startingAt).toBe('2026-05-25') // 2026-06-24 minus 30 days
    expect(ANTHROPIC_REVISION_WINDOW_DAYS).toBe(30)
  })

  it('REGRESSION: crosses the month boundary so late prior-month revisions are re-pulled', () => {
    // The exact bug: on June 2 the old window was [June 1, June 2] and a revision
    // to a May 28 charge was never re-pulled. The trailing window must include May.
    const { startingAt, endingAt } = analyticsPollWindow(new Date('2026-06-02T00:30:00Z'))
    expect(endingAt).toBe('2026-06-02')
    expect(startingAt).toBe('2026-05-03')
    expect(startingAt <= '2026-05-28').toBe(true) // May 28 is inside the window
  })

  it('crosses a year boundary', () => {
    const { startingAt, endingAt } = analyticsPollWindow(new Date('2026-01-05T12:00:00Z'))
    expect(endingAt).toBe('2026-01-05')
    expect(startingAt).toBe('2025-12-06')
  })

  it('uses UTC, not local time, for the day boundary', () => {
    // Late-UTC instant must still resolve to the UTC calendar day, not local.
    const { endingAt } = analyticsPollWindow(new Date('2026-06-24T23:59:59Z'))
    expect(endingAt).toBe('2026-06-24')
  })
})
