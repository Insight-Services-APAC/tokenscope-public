/*
 * useReportState — the `from`/`to` date-range URL keys (added alongside `month`).
 * The DateRangeControl binds `rs.from`/`rs.to`; these pin the pure parse/serialise
 * behaviour (the reactive computeds are covered in report-state-sync.test.ts).
 */
import { describe, it, expect } from 'vitest'
import {
  parseReportQuery,
  buildReportQuery,
  type ReportState,
} from '../../../app/composables/useReportState'

describe('parseReportQuery — from/to', () => {
  it('accepts YYYY-MM-DD from/to and rejects garbage (dropped → undefined)', () => {
    const ok = parseReportQuery({ scope: 'across', from: '2026-07-03', to: '2026-07-20' })
    expect([ok.from, ok.to]).toEqual(['2026-07-03', '2026-07-20'])

    const bad = parseReportQuery({ from: '2026-7-3', to: 'soon' })
    expect(bad.from).toBeUndefined()
    expect(bad.to).toBeUndefined()
  })

  it('leaves from/to absent (undefined, not null) when unset — month-only stays clean', () => {
    const s = parseReportQuery({ scope: 'across', month: '2026-05' })
    expect(s.from).toBeUndefined()
    expect(s.to).toBeUndefined()
    expect(s.month).toBe('2026-05')
  })

  it('takes the first value when from repeats (array query key)', () => {
    expect(parseReportQuery({ from: ['2026-07-01', '2026-08-01'] }).from).toBe('2026-07-01')
  })
})

describe('buildReportQuery — from/to', () => {
  it('emits from/to when set and drops them when unset', () => {
    const withRange: ReportState = {
      scope: 'across',
      month: null,
      from: '2026-07-03',
      to: '2026-07-20',
      region: null,
      ou: null,
      cc: null,
    }
    expect(buildReportQuery(withRange)).toEqual({
      scope: 'across',
      from: '2026-07-03',
      to: '2026-07-20',
    })

    const noRange: ReportState = { scope: 'across', month: '2026-05', region: null, ou: null, cc: null }
    expect(buildReportQuery(noRange)).toEqual({ scope: 'across', month: '2026-05' })
  })

  it('round-trips a range-populated state through build → parse', () => {
    const state: ReportState = {
      scope: 'across',
      month: null,
      from: '2026-07-03',
      to: '2026-07-20',
      region: null,
      ou: null,
      cc: null,
    }
    const parsed = parseReportQuery(buildReportQuery(state))
    expect([parsed.from, parsed.to]).toEqual(['2026-07-03', '2026-07-20'])
  })
})
