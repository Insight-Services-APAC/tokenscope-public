/*
 * freshnessTier — the ONE thresholds module (ops-alerting §A6.1: green ≤ 60
 * min, amber ≤ 6 h, red beyond; absent = unknown, never green).
 *
 * The BOUNDS are pinned inclusive/exclusive on purpose: 60 is fresh and 61 is
 * aging; 360 is aging and 361 is stale. A `<` where a `<=` belongs moves a
 * boundary minute into the worse tier and these go red.
 */
import { describe, it, expect } from 'vitest'
import {
  freshnessTier,
  FRESHNESS_FRESH_MAX_MINUTES,
  FRESHNESS_AGING_MAX_MINUTES,
  FRESHNESS_NEGATIVE_SKEW_TOLERANCE_MINUTES,
} from '../../../shared/observability/freshness'

describe('freshnessTier — the §A6.1 bounds', () => {
  it('green ≤ 60: 0 and 60 are fresh, 61 is not', () => {
    expect(freshnessTier(0)).toBe('fresh')
    expect(freshnessTier(12)).toBe('fresh')
    expect(freshnessTier(60)).toBe('fresh') // inclusive upper bound
    expect(freshnessTier(61)).toBe('aging')
  })

  it('amber ≤ 360: 61 and 360 are aging, 361 is stale', () => {
    expect(freshnessTier(61)).toBe('aging')
    expect(freshnessTier(360)).toBe('aging') // inclusive upper bound
    expect(freshnessTier(361)).toBe('stale')
    expect(freshnessTier(1440)).toBe('stale')
  })

  it('fractional minutes obey the same bounds (60.5 is past the green bound)', () => {
    expect(freshnessTier(59.9)).toBe('fresh')
    expect(freshnessTier(60.5)).toBe('aging')
    expect(freshnessTier(360.5)).toBe('stale')
  })

  it('the exported constants ARE the bounds (one place the numbers live)', () => {
    expect(FRESHNESS_FRESH_MAX_MINUTES).toBe(60)
    expect(FRESHNESS_AGING_MAX_MINUTES).toBe(360)
    expect(freshnessTier(FRESHNESS_FRESH_MAX_MINUTES)).toBe('fresh')
    expect(freshnessTier(FRESHNESS_AGING_MAX_MINUTES)).toBe('aging')
  })
})

describe('freshnessTier — absent is unknown, never a colour (§A6.1)', () => {
  it('null / undefined / NaN classify as unknown', () => {
    expect(freshnessTier(null)).toBe('unknown')
    expect(freshnessTier(undefined)).toBe('unknown')
    expect(freshnessTier(Number.NaN)).toBe('unknown')
  })

  it('non-finite numbers are computation artefacts, not measurements', () => {
    expect(freshnessTier(Number.POSITIVE_INFINITY)).toBe('unknown')
    expect(freshnessTier(Number.NEGATIVE_INFINITY)).toBe('unknown')
  })

  it('a negative age within the skew tolerance is a VALUE — fresh, not unknown', () => {
    expect(freshnessTier(-1)).toBe('fresh')
    expect(freshnessTier(-FRESHNESS_NEGATIVE_SKEW_TOLERANCE_MINUTES)).toBe('fresh') // inclusive bound
  })

  it('a negative age BELOW the skew tolerance is a malformed future timestamp — unknown, never green', () => {
    expect(FRESHNESS_NEGATIVE_SKEW_TOLERANCE_MINUTES).toBe(5)
    expect(freshnessTier(-5.1)).toBe('unknown')
    expect(freshnessTier(-6)).toBe('unknown')
    expect(freshnessTier(-1440)).toBe('unknown')
  })
})
