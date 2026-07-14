/*
 * useReportState — the pure parse/serialise core (the composable is the SOLE
 * owner of the reporting URL query; these functions are its validated heart).
 */
import { describe, it, expect } from 'vitest'
import {
  parseReportQuery,
  buildReportQuery,
  type ReportState,
} from '../../../app/composables/useReportState'

describe('parseReportQuery', () => {
  it('validates scope, falling back to across (or defaults)', () => {
    expect(parseReportQuery({ scope: 'finance' }).scope).toBe('finance')
    expect(parseReportQuery({ scope: 'bogus' }).scope).toBe('across')
    expect(parseReportQuery({}, { scope: 'regional' }).scope).toBe('regional')
  })

  it('accepts a YYYY-MM month and rejects garbage', () => {
    expect(parseReportQuery({ scope: 'finance', month: '2026-05' }).month).toBe('2026-05')
    expect(parseReportQuery({ month: 'May' }).month).toBeNull()
    expect(parseReportQuery({ month: '2026-5' }).month).toBeNull()
  })

  it('passes region/ou/cc through, defaulting to null', () => {
    const s = parseReportQuery({ scope: 'regional', region: 'r1', ou: 'o1', cc: 'c1' })
    expect([s.region, s.ou, s.cc]).toEqual(['r1', 'o1', 'c1'])
    const empty = parseReportQuery({})
    expect([empty.region, empty.ou, empty.cc]).toEqual([null, null, null])
  })

  it('takes the first value when a query key repeats (array)', () => {
    expect(parseReportQuery({ scope: ['finance', 'regional'] }).scope).toBe('finance')
  })

  it('parses the lane lens (chargeback), defaulting to undefined (= usage) for absent/garbage', () => {
    expect(parseReportQuery({ lane: 'chargeback' }).lane).toBe('chargeback')
    expect(parseReportQuery({ lane: 'usage' }).lane).toBe('usage')
    expect(parseReportQuery({ lane: 'bogus' }).lane).toBeUndefined()
    expect(parseReportQuery({}).lane).toBeUndefined()
  })
})

describe('buildReportQuery', () => {
  it('emits scope always and drops null keys', () => {
    const state: ReportState = { scope: 'regional', month: null, region: 'r1', ou: null, cc: null }
    expect(buildReportQuery(state)).toEqual({ scope: 'regional', region: 'r1' })
  })

  it('round-trips a populated state', () => {
    const state: ReportState = { scope: 'cost-centre', month: '2026-05', region: 'r1', ou: 'o1', cc: 'c1' }
    expect(buildReportQuery(state)).toEqual({
      scope: 'cost-centre',
      month: '2026-05',
      region: 'r1',
      ou: 'o1',
      cc: 'c1',
    })
    expect(parseReportQuery(buildReportQuery(state))).toEqual(state)
  })

  it('emits lane only for chargeback (usage is the default → dropped from the URL)', () => {
    const cb: ReportState = { scope: 'across', month: null, lane: 'chargeback', region: null, ou: null, cc: null }
    expect(buildReportQuery(cb)).toEqual({ scope: 'across', lane: 'chargeback' })
    // 'usage' + undefined both stay out of the URL.
    const usage: ReportState = { scope: 'across', month: null, lane: 'usage', region: null, ou: null, cc: null }
    expect(buildReportQuery(usage)).toEqual({ scope: 'across' })
    expect(parseReportQuery(buildReportQuery(cb)).lane).toBe('chargeback')
  })
})
