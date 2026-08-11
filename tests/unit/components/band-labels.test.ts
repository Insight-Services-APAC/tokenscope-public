/*
 * band-labels — the strings the reporting page's two band headers carry.
 *
 * WHY THIS FILE EXISTS AT ALL. The bands are the fix for a page that contradicted
 * itself: a 60-day $409 donut sat under a $12,855 month-to-date headline with
 * nothing on screen naming either window. The header is therefore not decoration —
 * it is the only thing telling the reader which of two windows a figure belongs
 * to, and a header that names the wrong one is worse than the interleaved page it
 * replaced, because it is now confidently wrong.
 *
 * So these pin the three ways it could be wrong: naming a range after the month it
 * starts in, claiming "month to date" over a closed month, and telling a reader two
 * IDENTICAL windows do not sum into each other.
 */
import { describe, it, expect } from 'vitest'
import {
  periodBandWindow,
  periodBandBasis,
  rollingBandNote,
} from '../../../app/components/reporting/band-labels'

const JULY = { month: '2026-07' }
const RANGE = { month: '2026-06', range: { from: '2026-06-14', to: '2026-08-02' } }

describe('periodBandWindow', () => {
  it('names a whole-month window for the month', () => {
    expect(periodBandWindow(JULY)).toBe('July 2026')
  })

  it('PRINTS a custom range rather than naming it after its start month', () => {
    /*
     * `meta.month` in range mode is only the window's start-month representative
     * (shared/reports/types.ts, ReportMeta.range). Labelling a 14 Jun → 2 Aug
     * window "June 2026" names a period the cards beneath it do not cover — the
     * bug window-labels.ts carries a header comment about, arriving here through
     * a different door.
     */
    expect(periodBandWindow(RANGE)).toBe('2026-06-14 → 2026-08-02')
    expect(periodBandWindow(RANGE)).not.toContain('June')
  })
})

describe('periodBandBasis', () => {
  it('says "month to date" only while the server says the month is running', () => {
    const running = periodBandBasis(JULY, { scopeLabel: 'APAC', lane: 'usage', inProgress: true })
    const closed = periodBandBasis(JULY, { scopeLabel: 'APAC', lane: 'usage', inProgress: false })
    expect(running).toBe('attributed usage · APAC · month to date')
    expect(closed).toBe('attributed usage · APAC · full month')
  })

  it('names the RANGE span rather than a month word, in range mode', () => {
    expect(periodBandBasis(RANGE, { scopeLabel: 'APAC', lane: 'usage', inProgress: false })).toBe(
      'attributed usage · APAC · the selected range',
    )
  })

  it('names the lane, so the band cannot inherit the wrong one', () => {
    /*
     * §A and §B are never summed and never interchangeable (contract C2). The
     * band sits above cards that re-lens wholesale, so the word it uses is the
     * reader's only fixed statement of which lane the group is on.
     */
    const billed = periodBandBasis(JULY, { scopeLabel: 'APAC', lane: 'chargeback', inProgress: true })
    expect(billed).toContain('chargeback · billed')
    expect(billed).not.toContain('attributed usage')
  })

  it('OMITS the scope rather than inventing one when the server named none', () => {
    /*
     * Contract C11. A manager and a region admin both hold `regional:
     * 'own-region'`, but the manager's §A clamp is their org SUBTREE, so a label
     * guessed here would print a region's name over one unit's numbers. A band
     * with no scope word still states its window, which is what it is for.
     */
    const basis = periodBandBasis(JULY, { scopeLabel: null, lane: 'usage', inProgress: true })
    expect(basis).toBe('attributed usage · month to date')
    expect(basis).not.toContain('· ·')
  })
})

describe('rollingBandNote', () => {
  it('names the month the rolling figures do NOT sum into', () => {
    // The whole reason the band exists: the reader has just left a month-to-date
    // headline, and every figure below is over a different window.
    expect(rollingBandNote(JULY, false)).toBe('does not sum into July')
  })

  it('does NOT claim two identical windows are incomparable', () => {
    /*
     * In custom-range mode the SAME from/to drives both bands (the containers'
     * `trendWindowQuery` returns the caller's range verbatim). "Does not sum into
     * June" there would be false in the most damaging direction — telling a
     * reader two identical windows cannot be compared.
     */
    expect(rollingBandNote(RANGE, true)).toBe('same window as the band above')
  })

  it('trusts the RENDERED comparison over the month/range shape', () => {
    /*
     * `trendWindowLabel` is optional, and a caller that supplies none puts the
     * period's own label on both headers — month mode, two identical headers, and
     * a "does not sum into July" between them would contradict what is on screen.
     * The two-header comparison is the one that decides.
     */
    expect(rollingBandNote(JULY, true)).toBe('same window as the band above')
  })

  it('says nothing at all rather than quoting an unparseable month back', () => {
    // `monthLabel` returns its input unchanged when it cannot parse it, and a
    // note reading "does not sum into 2026-13" is worse than no note.
    expect(rollingBandNote({ month: '2026-13' }, false)).toBeNull()
  })
})
