/*
 * The archive/cold-fallback suites classify rows as hot or cold against the REAL
 * clock. Their previous absolute constants held only inside a narrow window and
 * inverted silently once it passed — both suites then failed on every branch,
 * every day, and the failure read as a regression in whatever PR was open.
 *
 * "It passes today" is therefore not the property worth pinning. These assert the
 * invariants hold on EVERY date, so the constants cannot rot again.
 */
import { describe, it, expect } from 'vitest'
import { archiveWindow } from '../../integration/helpers/archive-window'

const DAY_MS = 86_400_000
const HOT_DAYS = 30 // what both suites pass to runArchiveLedger
const BACKFILL_DAYS = 90 // the rollup's window, which the cold assertions rely on

/** Every day across four years — leap year, month lengths, year boundaries. */
function everyDay(): Date[] {
  const out: Date[] = []
  for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2029, 11, 31); t += DAY_MS) {
    out.push(new Date(t))
  }
  return out
}

describe('archiveWindow — classification holds on any date', () => {
  const days = everyDay()

  it('always puts HOT comfortably inside the hot window', () => {
    for (const now of days) {
      const w = archiveWindow(now)
      const ageDays = (now.getTime() - new Date(w.hot).getTime()) / DAY_MS
      expect(ageDays, `hot age on ${now.toISOString().slice(0, 10)}`).toBeLessThan(HOT_DAYS)
      expect(ageDays).toBeGreaterThanOrEqual(0)
    }
  })

  it('always puts the WHOLE cold month outside the hot window', () => {
    // The worker archives per PARTITION, so it is the month's END that must be
    // cold, not merely the row's own date.
    for (const now of days) {
      const w = archiveWindow(now)
      const monthEndAge = (now.getTime() - new Date(`${w.coldMonthEnd}T00:00:00.000Z`).getTime()) / DAY_MS
      expect(monthEndAge, `cold month end age on ${now.toISOString().slice(0, 10)}`).toBeGreaterThan(HOT_DAYS)
    }
  })

  it('always keeps COLD inside the rollup backfill window', () => {
    for (const now of days) {
      const w = archiveWindow(now)
      const ageDays = (now.getTime() - new Date(w.cold).getTime()) / DAY_MS
      expect(ageDays, `cold age on ${now.toISOString().slice(0, 10)}`).toBeLessThan(BACKFILL_DAYS)
      expect(ageDays).toBeGreaterThan(HOT_DAYS)
    }
  })

  it('always lands COLD and HOT in different months', () => {
    // The partition assertions require it: same month would make "cold partition
    // dropped" and "hot data untouched" contradict each other.
    for (const now of days) {
      const w = archiveWindow(now)
      expect(w.coldMonthStart, `months on ${now.toISOString().slice(0, 10)}`).not.toBe(w.hotMonthStart)
    }
  })

  it('derives the partition name and bounds from the cold date itself', () => {
    const w = archiveWindow(new Date('2026-07-31T00:00:00.000Z'))
    expect(w.cold.slice(0, 7)).toBe('2026-05')
    expect(w.coldPartition).toBe('attribution_record_2026_05')
    expect(w.coldMonthStart).toBe('2026-05-01')
    expect(w.coldMonthEnd).toBe('2026-06-01')
  })

  it('rolls the exclusive upper bound across a year boundary', () => {
    const w = archiveWindow(new Date('2027-03-10T00:00:00.000Z'))
    expect(w.coldMonthStart).toBe('2026-12-01')
    expect(w.coldMonthEnd).toBe('2027-01-01')
  })
})
