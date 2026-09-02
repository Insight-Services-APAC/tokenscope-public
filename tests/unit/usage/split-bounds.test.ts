// @vitest-environment node
/*
 * splitBounds — the arithmetic every split read shares.
 *
 * Every defect this split produced lived here, and each was invisible until a
 * fixture put spend exactly on the boundary. A pure unit test can cover the
 * shapes an integration fixture cannot cheaply hold: a window ending in the
 * past, a window starting in the future, a window shorter than a day.
 *
 * The invariant, stated once and then ASSERTED rather than described: the two
 * arms are disjoint and their union is exactly [startIso, endIso). An earlier
 * version of this file checked disjointness and containment only, which passes
 * just as happily when an arm silently drops part of the window — the defect
 * the invariant exists to catch.
 */
import { describe, it, expect } from 'vitest'
import { splitBounds, type RollupGate, type SplitBounds } from '../../../server/usage/rollup-gate'

const GATE: RollupGate = { settledThrough: '2026-05-14', todayUtc: '2026-05-15' }

/** The instants an arm actually covers, as half-open [from, to). Empty = null. */
function intervals(b: SplitBounds, endIso: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  if (b.rollupTo) {
    // A day arm covers midnight-to-midnight, so its exclusive end is the day
    // AFTER its inclusive last day.
    const after = new Date(Date.parse(`${b.rollupTo}T00:00:00.000Z`) + 86_400_000).toISOString()
    out.push([`${b.rollupFrom}T00:00:00.000Z`, after])
  }
  if (b.liveFrom < endIso) out.push([b.liveFrom, endIso])
  return out
}

describe('splitBounds', () => {
  it('current month clamped to mid-day: rollup stops yesterday, live starts today', () => {
    expect(
      splitBounds(GATE, { startIso: '2026-05-01T00:00:00.000Z', endIso: '2026-05-15T12:00:00.000Z' }),
    ).toEqual({
      rollupFrom: '2026-05-01',
      rollupTo: '2026-05-14',
      liveFrom: '2026-05-15T00:00:00.000Z',
    })
  })

  it('COMPLETED month: the rollup arm stops at the window end, not at settledThrough', () => {
    // The defect that shipped past the first review. settledThrough is 05-14,
    // but April's window ends 05-01, so the arm must stop at 04-30 or the month
    // absorbs two weeks of May.
    const b = splitBounds(GATE, { startIso: '2026-04-01T00:00:00.000Z', endIso: '2026-05-01T00:00:00.000Z' })
    expect(b?.rollupTo).toBe('2026-04-30')
  })

  it('a window ending at a UTC midnight excludes that day, because endIso is exclusive', () => {
    const b = splitBounds(GATE, { startIso: '2026-05-01T00:00:00.000Z', endIso: '2026-05-10T00:00:00.000Z' })
    expect(b?.rollupTo).toBe('2026-05-09')
  })

  it('a window starting in the FUTURE keeps the live arm at the window start', () => {
    // Otherwise the live arm begins at today and admits rows before the
    // requested start.
    const b = splitBounds(GATE, { startIso: '2026-06-01T00:00:00.000Z', endIso: '2026-06-30T00:00:00.000Z' })
    expect(b?.liveFrom).toBe('2026-06-01T00:00:00.000Z')
  })

  it('a window entirely inside today has NO rollup arm', () => {
    // rollupTo would precede rollupFrom; null says "this arm covers nothing"
    // rather than emitting an inverted range that silently matches no rows.
    const b = splitBounds(GATE, { startIso: '2026-05-15T00:00:00.000Z', endIso: '2026-05-15T12:00:00.000Z' })
    expect(b?.rollupTo).toBeNull()
    expect(b?.liveFrom).toBe('2026-05-15T00:00:00.000Z')
  })

  it('the arms COVER THE WINDOW EXACTLY, across many shapes', () => {
    const shapes = [
      ['2026-05-01T00:00:00.000Z', '2026-05-15T12:00:00.000Z'], // current month, clamped
      ['2026-04-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'], // completed month
      ['2026-05-14T00:00:00.000Z', '2026-05-15T12:00:00.000Z'], // straddles the boundary
      ['2026-05-15T00:00:00.000Z', '2026-05-15T23:00:00.000Z'], // inside today
      ['2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z'], // a single past day
      ['2026-05-15T08:00:00.000Z', '2026-05-15T12:00:00.000Z'], // mid-day start INSIDE today
      ['2026-06-01T00:00:00.000Z', '2026-06-30T00:00:00.000Z'], // wholly in the future
    ] as const
    for (const [startIso, endIso] of shapes) {
      const b = splitBounds(GATE, { startIso, endIso })
      const why = `${startIso}..${endIso}`
      expect(b, `refused a supported shape: ${why}`).not.toBeNull()
      const arms = intervals(b!, endIso)
      // Sorted, contiguous, and spanning the window with no gap and no overlap.
      arms.sort((x, y) => (x[0] < y[0] ? -1 : 1))
      expect(arms.length, `no coverage at all on ${why}`).toBeGreaterThan(0)
      expect(arms[0]![0], `coverage starts late/early on ${why}`).toBe(startIso)
      expect(arms[arms.length - 1]![1], `coverage ends late/early on ${why}`).toBe(endIso)
      for (let i = 1; i < arms.length; i++) {
        expect(arms[i - 1]![1], `gap or overlap on ${why}`).toBe(arms[i]![0])
      }
    }
  })

  it('REFUSES a mid-day start that a whole-day arm would round outward', () => {
    // The arm would begin at 05-01T00:00Z and count eight hours the caller did
    // not ask for. There is no day-grain expression of "from 08:00", so it
    // declines and the caller reads the view.
    expect(
      splitBounds(GATE, { startIso: '2026-05-01T08:00:00.000Z', endIso: '2026-05-15T12:00:00.000Z' }),
    ).toBeNull()
  })

  it('REFUSES a mid-day end on a PAST day, whose remainder nothing would cover', () => {
    // The live arm starts at today, so for a window ending before today it is
    // empty — and 05-10T00:00Z..12:00Z would be dropped silently.
    expect(
      splitBounds(GATE, { startIso: '2026-05-01T00:00:00.000Z', endIso: '2026-05-10T12:00:00.000Z' }),
    ).toBeNull()
  })

  it('ALLOWS a mid-day end on TODAY — the route’s own shape, covered by the live arm', () => {
    // The refusal above must not swallow the only mid-day bound the page
    // actually produces, or the split is dead code on every request.
    expect(
      splitBounds(GATE, { startIso: '2026-05-01T00:00:00.000Z', endIso: '2026-05-15T12:00:00.000Z' }),
    ).not.toBeNull()
  })
})
