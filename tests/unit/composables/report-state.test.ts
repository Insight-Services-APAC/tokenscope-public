/*
 * useReportState — the pure parse/serialise core (the composable is the SOLE
 * owner of the reporting URL query; these functions are its validated heart).
 */
import { describe, it, expect } from 'vitest'
import {
  parseReportQuery,
  buildReportQuery,
  hasLegacyScope,
  type ReportState,
} from '../../../app/composables/useReportState'

describe('parseReportQuery', () => {
  it('validates scope, falling back to region (or defaults)', () => {
    expect(parseReportQuery({ scope: 'finance' }).scope).toBe('finance')
    expect(parseReportQuery({ scope: 'bogus' }).scope).toBe('region')
    expect(parseReportQuery({}, { scope: 'cost-centre' }).scope).toBe('cost-centre')
  })

  it('accepts a YYYY-MM month and rejects garbage', () => {
    expect(parseReportQuery({ scope: 'finance', month: '2026-05' }).month).toBe('2026-05')
    expect(parseReportQuery({ month: 'May' }).month).toBeNull()
    expect(parseReportQuery({ month: '2026-5' }).month).toBeNull()
  })

  it('passes region/ou/cc through, defaulting to null', () => {
    const s = parseReportQuery({ scope: 'region', region: 'r1', ou: 'o1', cc: 'c1' })
    expect([s.region, s.ou, s.cc]).toEqual(['r1', 'o1', 'c1'])
    const empty = parseReportQuery({})
    expect([empty.region, empty.ou, empty.cc]).toEqual([null, null, null])
  })

  it('takes the first value when a query key repeats (array)', () => {
    expect(parseReportQuery({ scope: ['finance', 'cost-centre'] }).scope).toBe('finance')
  })

  it('parses the lane lens (chargeback), defaulting to undefined (= usage) for absent/garbage', () => {
    expect(parseReportQuery({ lane: 'chargeback' }).lane).toBe('chargeback')
    expect(parseReportQuery({ lane: 'usage' }).lane).toBe('usage')
    expect(parseReportQuery({ lane: 'bogus' }).lane).toBeUndefined()
    expect(parseReportQuery({}).lane).toBeUndefined()
  })
})

/*
 * The retired `?scope=` values (04-prototype-delta.md §6 acceptance).
 *
 * A saved URL is the one artefact of a scope that outlives it: bookmarks, Slack
 * links, a runbook. Falling back to the default scope would be worse than a 404 —
 * `?scope=across` would silently land on ONE region's figures under the same
 * headline, and nothing on the page would say the width had changed.
 */
describe('parseReportQuery — retired scopes map, they do not fall back', () => {
  it('?scope=across → ?scope=region AND region=all (the whole-company width)', () => {
    const s = parseReportQuery({ scope: 'across' })
    expect(s.scope).toBe('region')
    expect(s.region).toBe('all')
  })

  it('?scope=regional → ?scope=region, keeping the region it carried', () => {
    const s = parseReportQuery({ scope: 'regional', region: 'r1' })
    expect(s.scope).toBe('region')
    expect(s.region).toBe('r1')
  })

  it('?scope=regional with no region stays region-less (the caller default)', () => {
    expect(parseReportQuery({ scope: 'regional' }).region).toBeNull()
  })

  it('a stray region beside ?scope=across does NOT narrow it — across meant whole-company', () => {
    // The Across scope never had a region param, so a `region` riding along is a
    // stale key from another scope. Honouring it would clamp an export/report whose
    // whole point was that it was not clamped.
    expect(parseReportQuery({ scope: 'across', region: 'r1' }).region).toBe('all')
  })

  it('carries the rest of the state across the mapping (month, range, lens, drill)', () => {
    const s = parseReportQuery({
      scope: 'across',
      month: '2026-05',
      lane: 'chargeback',
      cc: 'c1',
    })
    expect(s).toMatchObject({ scope: 'region', region: 'all', month: '2026-05', lane: 'chargeback', cc: 'c1' })
  })

  it('the mapped state round-trips to a CANONICAL url — the retired value does not survive', () => {
    const q = buildReportQuery(parseReportQuery({ scope: 'across' }))
    expect(q).toEqual({ scope: 'region', region: 'all' })
    expect(buildReportQuery(parseReportQuery({ scope: 'regional' }))).toEqual({ scope: 'region' })
  })
})

describe('hasLegacyScope — what tells the shell to rewrite the URL', () => {
  it('is true for exactly the two retired values', () => {
    expect(hasLegacyScope({ scope: 'across' })).toBe(true)
    expect(hasLegacyScope({ scope: 'regional' })).toBe(true)
  })

  it('is false for every live scope and for garbage', () => {
    for (const scope of ['region', 'cost-centre', 'finance', 'bogus', undefined]) {
      expect(hasLegacyScope({ scope })).toBe(false)
    }
  })
})

describe('buildReportQuery', () => {
  it('emits scope always and drops null keys', () => {
    const state: ReportState = { scope: 'region', month: null, region: 'r1', ou: null, cc: null }
    expect(buildReportQuery(state)).toEqual({ scope: 'region', region: 'r1' })
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
    const cb: ReportState = { scope: 'region', month: null, lane: 'chargeback', region: null, ou: null, cc: null }
    expect(buildReportQuery(cb)).toEqual({ scope: 'region', lane: 'chargeback' })
    // 'usage' + undefined both stay out of the URL.
    const usage: ReportState = { scope: 'region', month: null, lane: 'usage', region: null, ou: null, cc: null }
    expect(buildReportQuery(usage)).toEqual({ scope: 'region' })
    expect(parseReportQuery(buildReportQuery(cb)).lane).toBe('chargeback')
  })
})
