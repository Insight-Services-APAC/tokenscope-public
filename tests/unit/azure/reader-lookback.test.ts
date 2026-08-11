/*
 * resolveLookbackDays + isoDuration — the OUTER scan bound for Log Analytics reads.
 *
 * Pinned because nothing else in the suite asserts on the emitted query
 * `duration`: R3 proved that setting DEFAULT_LOOKBACK_DAYS to 1 and making
 * isoDuration emit garbage left all 2929 tests green. A silent narrowing here
 * costs unrecoverable history on a first-ever (no-watermark) scan, and a
 * malformed duration 400s every widened recovery read.
 *
 * Context: the bound used to be `opts.lookbackDays === 1 ? 1 : 7`, which clamped
 * EVERY wider request to 7 — turning an app-side constant into an apparent
 * data-loss boundary after the joiner dead-zone incident (the records were still
 * inside workspace retention; the reader just refused to ask for them).
 */
import { describe, it, expect } from 'vitest'
import { resolveLookbackDays, isoDuration } from '../../../server/azure/reader'

// The two aliases the SDK actually exposes (it stops at 7 days); the query API
// itself accepts any ISO-8601 duration string.
const DURATIONS = { oneDay: 'P1D', sevenDays: 'P7D' }

describe('resolveLookbackDays', () => {
  it('defaults to 7 days when unset — the steady-state tick cost must not change', () => {
    expect(resolveLookbackDays(undefined)).toBe(7)
  })

  it('honours a widened recovery window up to the 90-day ceiling', () => {
    expect(resolveLookbackDays(30)).toBe(30) // the case the old code silently clamped to 7
    expect(resolveLookbackDays(90)).toBe(90)
    expect(resolveLookbackDays(1000)).toBe(90) // beyond any retention we provision
  })

  it('keeps the 1-day fast path', () => {
    expect(resolveLookbackDays(1)).toBe(1)
  })

  it('falls back to the default on nonsense rather than narrowing', () => {
    // A narrower-than-intended window silently loses history; the default is the
    // safe landing spot for every unusable input.
    for (const bad of [0, -1, 0.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(resolveLookbackDays(bad)).toBe(7)
    }
  })

  it('treats Infinity as "as wide as possible" — same as the liveBearerHours knob', () => {
    // The two resolvers in this change previously disagreed about the same input.
    expect(resolveLookbackDays(Number.POSITIVE_INFINITY)).toBe(90)
  })

  it('floors a fractional request instead of emitting a fractional duration', () => {
    expect(resolveLookbackDays(7.9)).toBe(7)
    expect(resolveLookbackDays(30.5)).toBe(30)
  })
})

describe('isoDuration', () => {
  it('uses the SDK aliases for the two values that have them', () => {
    expect(isoDuration(1, DURATIONS)).toBe('P1D')
    expect(isoDuration(7, DURATIONS)).toBe('P7D')
  })

  it('emits valid ISO-8601 for values the SDK has no alias for', () => {
    // The alias table stopping at 7d was never the limit — the API takes any
    // ISO-8601 string, which is what makes a widened recovery read possible.
    expect(isoDuration(30, DURATIONS)).toBe('P30D')
    expect(isoDuration(90, DURATIONS)).toBe('P90D')
  })

  it('every value resolveLookbackDays can return produces a well-formed duration', () => {
    for (const raw of [undefined, 0, 1, 7, 7.9, 30, 90, 1000, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isoDuration(resolveLookbackDays(raw), DURATIONS)).toMatch(/^P\d+D$/)
    }
  })
})

describe('LogAnalyticsReader.appliedLookbackDays', () => {
  it('reports the window the reader will actually use, not the raw option', async () => {
    // The joiner result reads this back as evidence of what a recovery run did.
    // Recomputing it at the call site instead would let the reported and applied
    // windows diverge — and the field exists precisely for when a request was
    // silently dropped, so it must come from the reader itself.
    const { LogAnalyticsReader } = await import('../../../server/azure/reader')
    expect(new LogAnalyticsReader('ws', {}).appliedLookbackDays).toBe(7) // default
    expect(new LogAnalyticsReader('ws', { lookbackDays: 90 }).appliedLookbackDays).toBe(90)
    expect(new LogAnalyticsReader('ws', { lookbackDays: 1000 }).appliedLookbackDays).toBe(90) // clamped
    expect(new LogAnalyticsReader('ws', { lookbackDays: 0 }).appliedLookbackDays).toBe(7) // nonsense → default
  })
})
