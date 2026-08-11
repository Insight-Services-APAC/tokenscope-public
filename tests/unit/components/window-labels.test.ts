// @vitest-environment node
/*
 * window-labels — the periods named above the reporting tables.
 *
 * A wrong label here is not cosmetic: it puts a period on a budget table that
 * the figures beneath it do not cover, at the moment an owner decides whether
 * to extend. The defect that prompted these tests shipped in the "project at
 * the centre" slice and was caught in review — "still running AND starts on a
 * 1st" was treated as sufficient for month-to-date, so any open-ended range
 * beginning on a 1st was labelled with its FIRST month alone.
 */
import { describe, it, expect } from 'vitest'
import { ownerWindowLabel, quarterLabel, monthLabel } from '../../../app/components/reporting/window-labels'
import type { CostCentreWindow } from '../../../shared/schemas/cost-centres'

const w = (o: Partial<CostCentreWindow>): CostCentreWindow => ({
  from: '2026-08-01',
  to: '2026-08-01',
  month: null,
  runs_to_now: false,
  ...o,
})

describe('ownerWindowLabel', () => {
  it('names a whole calendar month by its month', () => {
    expect(ownerWindowLabel(w({ month: '2026-05', from: '2026-05-01', to: '2026-05-31' }))).toBe(
      'May 2026',
    )
  })

  it('names a still-running window inside its start month as month-to-date', () => {
    expect(ownerWindowLabel(w({ from: '2026-08-01', to: '2026-08-14', runs_to_now: true }))).toBe(
      'August 2026 to date',
    )
  })

  /*
   * The review finding, exactly. `from=2026-05-01&to=<future>` clamps to
   * `2026-05-01 → today`: still running, starts on a 1st — but it spans May,
   * June, July and August. Labelling it "May 2026 to date" understates the
   * period by three months while the burn figures include all four.
   */
  it('does NOT call a multi-month clamped range month-to-date', () => {
    const label = ownerWindowLabel(w({ from: '2026-05-01', to: '2026-08-01', runs_to_now: true }))
    expect(label).toBe('2026-05-01 → 2026-08-01')
    expect(label).not.toContain('to date')
    expect(label).not.toContain('May')
  })

  it('does not call a mid-month start month-to-date even within one month', () => {
    expect(ownerWindowLabel(w({ from: '2026-08-03', to: '2026-08-14', runs_to_now: true }))).toBe(
      '2026-08-03 → 2026-08-14',
    )
  })

  it('does not call a completed range month-to-date, even starting on a 1st', () => {
    expect(ownerWindowLabel(w({ from: '2026-05-01', to: '2026-05-20', runs_to_now: false }))).toBe(
      '2026-05-01 → 2026-05-20',
    )
  })

  it('renders empty before the response lands, never a stale or invented period', () => {
    expect(ownerWindowLabel(null)).toBe('')
    expect(ownerWindowLabel(undefined)).toBe('')
  })

  it('spans a year boundary without claiming the start month', () => {
    expect(ownerWindowLabel(w({ from: '2025-12-01', to: '2026-02-10', runs_to_now: true }))).toBe(
      '2025-12-01 → 2026-02-10',
    )
  })
})

/*
 * quarterLabel had the SAME defect as ownerWindowLabel, on a sibling surface:
 * it named a period from the window's START alone. Its own comment promised a
 * fallback "for any hand-crafted URL range", but the fallback could not fire
 * for a hand-crafted range starting on a quarter boundary — the exact case it
 * described.
 */
describe('quarterLabel', () => {
  it('names an exact calendar quarter', () => {
    expect(quarterLabel('2026-01-01', '2026-03-31')).toBe('Q1 2026')
    expect(quarterLabel('2026-04-01', '2026-06-30')).toBe('Q2 2026')
    expect(quarterLabel('2026-07-01', '2026-09-30')).toBe('Q3 2026')
    expect(quarterLabel('2026-10-01', '2026-12-31')).toBe('Q4 2026')
  })

  it('returns null for a span of THREE quarters that merely starts on one', () => {
    expect(quarterLabel('2026-04-01', '2026-12-31')).toBeNull()
  })

  it('returns null for a partial quarter, so a short range is never named whole', () => {
    expect(quarterLabel('2026-04-01', '2026-05-15')).toBeNull()
    expect(quarterLabel('2026-04-01', '2026-06-29')).toBeNull()
  })

  it('returns null when the range does not start a quarter', () => {
    expect(quarterLabel('2026-02-01', '2026-04-30')).toBeNull()
    expect(quarterLabel('2026-04-15', '2026-06-30')).toBeNull()
  })

  it('pins the Q4 boundary: it ends 12-31, and January in the upper bound is not Q4', () => {
    expect(quarterLabel('2026-10-01', '2026-12-31')).toBe('Q4 2026')
    expect(quarterLabel('2026-10-01', '2027-01-31')).toBeNull()
  })

  it('accounts for a leap February in Q1', () => {
    expect(quarterLabel('2028-01-01', '2028-03-31')).toBe('Q1 2028')
  })
})

/*
 * monthLabel was duplicated byte-identically in three components and collapsed
 * to one. Nothing tested it directly, so reverting the consolidation left the
 * whole suite green — helper correctness standing in for the dedupe.
 */
describe('monthLabel', () => {
  it("names a month in UTC, never the viewer local zone", () => {
    expect(monthLabel('2026-01')).toBe('January 2026')
    expect(monthLabel('2026-12')).toBe('December 2026')
  })

  it('returns the input unchanged when it is not a month', () => {
    expect(monthLabel('not-a-month')).toBe('not-a-month')
    expect(monthLabel('')).toBe('')
  })
})

describe('malformed and adversarial input', () => {
  it('does not accept a structurally invalid start as a quarter', () => {
    // Slicing plus endsWith is not validation: this once returned "Q2 2026".
    expect(quarterLabel('2026-04garbage-01', '2026-06-30')).toBeNull()
    expect(quarterLabel('', '2026-06-30')).toBeNull()
    expect(quarterLabel('2026-4-01', '2026-06-30')).toBeNull()
  })

  it('matches the WHOLE string, so no prefix or suffix can smuggle a quarter in', () => {
    // An unanchored pattern finds a valid quarter start embedded anywhere.
    expect(quarterLabel('x2026-04-01', '2026-06-30')).toBeNull()
    expect(quarterLabel('2026-04-01extra', '2026-06-30')).toBeNull()
    expect(quarterLabel('junk/2026-04-01', '2026-06-30')).toBeNull()
  })

  it('does not remap low years the way Date.UTC did', () => {
    // Date.UTC(99, ...) means 1999, so the quarter end was computed for the
    // wrong year entirely: this pair once returned "Q1 0099".
    expect(quarterLabel('0099-01-01', '1999-03-31')).toBeNull()
    expect(quarterLabel('0099-01-01', '0099-03-31')).toBe('Q1 0099')
  })

  it('rejects month metadata that contradicts the bounds it came with', () => {
    // A named period is a claim about BOTH bounds — including this path, which
    // used to take the server's `month` on trust and render "May 2026" over two.
    expect(
      ownerWindowLabel({ month: '2026-05', from: '2026-05-01', to: '2026-06-30', runs_to_now: false }),
    ).toBe('2026-05-01 → 2026-06-30')
  })

  it('accepts month metadata that agrees, including a leap February', () => {
    expect(
      ownerWindowLabel({ month: '2028-02', from: '2028-02-01', to: '2028-02-29', runs_to_now: false }),
    ).toBe('February 2028')
    expect(
      ownerWindowLabel({ month: '2026-02', from: '2026-02-01', to: '2026-02-28', runs_to_now: false }),
    ).toBe('February 2026')
    // 1900 is NOT a leap year (century rule); 2000 is (400 rule).
    expect(
      ownerWindowLabel({ month: '1900-02', from: '1900-02-01', to: '1900-02-28', runs_to_now: false }),
    ).toBe('February 1900')
    expect(
      ownerWindowLabel({ month: '2000-02', from: '2000-02-01', to: '2000-02-29', runs_to_now: false }),
    ).toBe('February 2000')
  })

  it('handles a collapsed single-day window', () => {
    expect(
      ownerWindowLabel({ month: null, from: '2026-08-01', to: '2026-08-01', runs_to_now: true }),
    ).toBe('August 2026 to date')
  })
})
