/*
 * chart-utils — the reporting chart kit's pure helpers. Focus: isoWeekLabel, the
 * ISO-week → Monday-date relabel shared by both seasonality heatmaps (review F9/L6).
 * The date math is non-trivial (ISO week 1 = the week containing Jan 4) and the
 * label must be year-unambiguous (a bare "W27" collides across years).
 */
import { describe, it, expect } from 'vitest'
import { isoWeekLabel, shortDay, categoryUnion } from '../../../app/components/reporting/charts/chart-utils'

describe('isoWeekLabel', () => {
  it('relabels an ISO week to its Monday date (UTC, en-US MMM DD)', () => {
    // ISO week 1 of 2026 contains Jan 4 2026 (a Sunday) → its Monday is 2025-12-29.
    expect(isoWeekLabel('2026-W01')).toBe('Dec 29')
  })

  it('returns a MMM DD shape for any valid ISO week', () => {
    expect(isoWeekLabel('2026-W27')).toMatch(/^[A-Z][a-z]{2} \d{2}$/)
    expect(isoWeekLabel('2026-W52')).toMatch(/^[A-Z][a-z]{2} \d{2}$/)
  })

  it('is year-unambiguous — the same week number in different years maps to different Mondays', () => {
    expect(isoWeekLabel('2025-W27')).not.toBe(isoWeekLabel('2026-W27'))
  })

  it('passes non-ISO-week input through unchanged (defensive)', () => {
    expect(isoWeekLabel('not-a-week')).toBe('not-a-week')
    expect(isoWeekLabel('2026-07')).toBe('2026-07')
    expect(isoWeekLabel('')).toBe('')
  })
})

describe('shortDay + categoryUnion (sanity)', () => {
  it('shortDay trims YYYY- from an ISO day, leaves other strings alone', () => {
    expect(shortDay('2026-07-03')).toBe('07-03')
    expect(shortDay('W27')).toBe('W27')
  })

  it('categoryUnion returns the sorted union of x-values', () => {
    expect(categoryUnion([[{ x: '2026-07-02' }, { x: '2026-07-01' }], [{ x: '2026-07-03' }, { x: '2026-07-01' }]])).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
    ])
  })
})
