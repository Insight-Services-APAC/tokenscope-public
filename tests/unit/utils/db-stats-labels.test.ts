// @vitest-environment node
/*
 * The db-performance panel's statistics labels.
 *
 * The UNHAPPY paths are the point: the happy one reads fine by inspection, and
 * it is the null, unavailable and unparseable branches that reach an operator
 * as a malformed sentence. Every case asserts the EXACT string, because the
 * template adds nothing and a length check cannot see a broken clause.
 */
import { describe, it, expect } from 'vitest'
import { statsWindowLabel, analyzeLabel } from '../../../app/utils/db-stats-labels'

const NOW = '2026-08-29T12:00:00.000Z'

describe('statsWindowLabel', () => {
  it('says the age could not be read when the read failed', () => {
    // A failed read and a never-reset database are the same null. Only
    // `available` separates "we could not find out" from "it has not happened".
    expect(statsWindowLabel({ databaseSince: null, available: false }, NOW)).toBe(
      'The age of these counters could not be read.',
    )
  })

  it('says never reset when the database genuinely has not been', () => {
    expect(statsWindowLabel({ databaseSince: null, available: true }, NOW)).toBe(
      'These counters have never been reset.',
    )
  })

  it('returns a WHOLE, well-formed sentence in every state', () => {
    // Shape, not length: a sentence starts capitalised, ends in a full stop,
    // and carries no dangling connective. A length check cannot see a break.
    const states = [
      undefined,
      { databaseSince: null, available: false },
      { databaseSince: null, available: true },
      { databaseSince: '2026-08-29T11:30:00.000Z', available: true },
      { databaseSince: '2026-08-19T12:00:00.000Z', available: true },
      { databaseSince: 'not-a-date', available: true },
    ]
    for (const st of states) {
      const out = statsWindowLabel(st, NOW)
      const why = JSON.stringify(st)
      // A sentence: starts capitalised, ends with a full stop.
      expect(out, why).toMatch(/^[A-Z]/)
      expect(out, why).toMatch(/\.$/)
      expect(out, why).not.toMatch(/undefined|NaN|Invalid/)
      // And no double-space or dangling connective from a half-built clause.
      expect(out, why).not.toMatch(/ {2}|to\s*$|,\s*$/)
    }
  })

  it('scales the age from minutes to days', () => {
    // Exact, so a change to the wording is a decision rather than a surprise.
    expect(statsWindowLabel({ databaseSince: '2026-08-29T11:30:00.000Z', available: true }, NOW)).toBe(
      'Counts below run back to the last database-wide reset, 30 min ago.',
    )
    expect(statsWindowLabel({ databaseSince: '2026-08-29T02:00:00.000Z', available: true }, NOW)).toBe(
      'Counts below run back to the last database-wide reset, 10 h ago.',
    )
    expect(statsWindowLabel({ databaseSince: '2026-08-19T12:00:00.000Z', available: true }, NOW)).toBe(
      'Counts below run back to the last database-wide reset, 10 days ago.',
    )
  })

  it('never renders a negative age', () => {
    // generatedAt is captured BEFORE the reads, so a reset landing mid-request
    // is legitimately newer than it.
    const out = statsWindowLabel({ databaseSince: '2026-08-29T12:00:05.000Z', available: true }, NOW)
    // A negative NUMBER, not any hyphen — "database-wide" legitimately has one.
    expect(out).not.toMatch(/-\d/)
    expect(out).toContain('ago')
  })

  it('calls it the DATABASE-WIDE reset, because a single table can be newer', () => {
    // pg_stat_reset_single_table_counters re-zeroes one relation without moving
    // this timestamp, so the copy must not promise it governs every row.
    expect(statsWindowLabel({ databaseSince: '2026-08-27T12:00:00.000Z', available: true }, NOW)).toContain(
      'database-wide',
    )
  })
})

describe('analyzeLabel', () => {
  it('renders nothing when the server did not report the fields', () => {
    // An older server, or a failed read — better blank than a confident "never".
    expect(analyzeLabel({}, NOW)).toBe('')
  })

  it('names members that were never analysed at all', () => {
    expect(analyzeLabel({ neverAnalyzed: 3, lastAnalyzed: null }, NOW)).toBe('NEVER analysed (3)')
  })

  it('reports drift only when there is drift', () => {
    expect(analyzeLabel({ lastAnalyzed: '2026-08-29T02:00:00.000Z', rowsChangedSinceAnalyze: 0 }, NOW)).toBe(
      'analysed 10h ago',
    )
    expect(analyzeLabel({ lastAnalyzed: '2026-08-29T02:00:00.000Z', rowsChangedSinceAnalyze: 4210 }, NOW)).toBe(
      'analysed 10h ago · 4,210 rows since',
    )
  })

  it('never renders a negative age', () => {
    const out = analyzeLabel({ lastAnalyzed: '2026-08-29T12:00:05.000Z', rowsChangedSinceAnalyze: 0 }, NOW)
    expect(out).toBe('analysed 0h ago')
  })

  it('degrades to ? on an unparseable instant rather than NaN', () => {
    expect(analyzeLabel({ lastAnalyzed: 'nonsense' }, NOW)).toBe('analysed ? ago')
  })
})
