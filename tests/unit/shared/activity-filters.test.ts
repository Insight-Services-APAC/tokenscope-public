/*
 * Activity filter parsing — the day bounds must be REAL calendar days.
 *
 * WHY THIS EXISTS. `from` / `to` were shape-checked only (`\d{4}-\d{2}-\d{2}`),
 * so `2026-02-31` passed validation, reached the `${f.from}::date` cast in
 * `server/usage/activity-list.ts`, and aborted the query — the caller got a 500
 * for a mistake that is a 400. A boundary that admits an impossible value has
 * not validated it; it has deferred it to whoever cannot report it properly.
 *
 * The non-leap February case is the one a month-length table gets wrong, so it
 * is asserted on both sides (2026 rejects the 29th, 2024 accepts it).
 */
import { describe, it, expect } from 'vitest'
import {
  ActivityExportQuery,
  ActivityFilterQuery,
  ActivityListQuery,
  isRealUtcDay,
} from '../../../shared/schemas/activity'

const IMPOSSIBLE = [
  /*
   * YEAR ZERO — the hole the ROUND-TRIP check alone leaves (external review r2).
   * `0000-01-01` is a real ISO-8601 instant, so `Date.parse` → `toISOString`
   * returns it unchanged and the day "exists" as far as JavaScript is concerned.
   * Postgres has no year 0 in its AD/BC text form: `'0000-01-01'::date` raises
   * `date/time field value out of range` and aborts the query — the very 500
   * this validator exists to turn into a 400.
   *
   * RED ON REVERT: drop the `MIN_YEAR` guard from `isRealUtcDay` and these two
   * go red (and the query they reach goes back to 500ing).
   */
  '0000-01-01',
  '0000-12-31',
  '2026-02-31', // never exists
  '2026-02-29', // 2026 is not a leap year
  '2026-04-31', // 30-day month
  '2026-13-01', // month out of range
  '2026-00-10', // month zero
  '2026-01-00', // day zero
  '2026-01-32',
]

// `0001-01-01` is the FIRST day Postgres will cast through this literal, and
// the shape regex caps the other end at 9999 — so the guard narrows the accepted
// range to exactly what the database can represent, not to a business rule.
const REAL = ['0001-01-01', '2024-02-29', '2026-02-28', '2026-01-01', '2026-12-31', '9999-12-31']

describe('isRealUtcDay', () => {
  it.each(IMPOSSIBLE)('rejects %s', (day) => {
    expect(isRealUtcDay(day)).toBe(false)
  })

  it.each(REAL)('accepts %s', (day) => {
    expect(isRealUtcDay(day)).toBe(true)
  })
})

describe('ActivityFilterQuery day bounds', () => {
  it.each(IMPOSSIBLE)('rejects an impossible `from` (%s) rather than passing it to ::date', (day) => {
    expect(ActivityFilterQuery.safeParse({ from: day }).success).toBe(false)
  })

  it.each(IMPOSSIBLE)('rejects an impossible `to` (%s)', (day) => {
    expect(ActivityFilterQuery.safeParse({ to: day }).success).toBe(false)
  })

  it('still accepts a real range, and both bounds survive parsing', () => {
    const parsed = ActivityFilterQuery.parse({ from: '2024-02-29', to: '2026-02-28' })
    expect(parsed.from).toBe('2024-02-29')
    expect(parsed.to).toBe('2026-02-28')
  })

  it('still rejects a malformed shape', () => {
    expect(ActivityFilterQuery.safeParse({ from: '2026-2-3' }).success).toBe(false)
    expect(ActivityFilterQuery.safeParse({ from: 'yesterday' }).success).toBe(false)
  })

  it('leaves the bounds optional', () => {
    expect(ActivityFilterQuery.parse({}).from).toBeUndefined()
  })

  // The list and the CSV extend the SAME filter schema (D20); the guard has to
  // travel with it, or one of the two surfaces keeps the 500.
  it('applies to the list and the export queries alike', () => {
    expect(ActivityListQuery.safeParse({ from: '2026-02-31' }).success).toBe(false)
    expect(ActivityExportQuery.safeParse({ to: '2026-02-31' }).success).toBe(false)
  })
})
