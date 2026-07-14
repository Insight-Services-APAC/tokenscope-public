/*
 * Velocity baseline rule — unit test for the pure math.
 *
 * The SQL in server/api/v1/rollups/practice/[ouId]/velocity.get.ts
 * computes (current - rolling_mean) / rolling_mean and flags ≥ 25 %.
 * This test pins the rule as a pure function so future tweaks
 * (different threshold, different rolling window) can be reasoned
 * about without spinning up Postgres.
 */
import { describe, it, expect } from 'vitest'

const THRESHOLD = 0.25

function isFlagged(current: number, rollingMean: number): boolean {
  if (rollingMean <= 0) return false
  return (current - rollingMean) / rollingMean >= THRESHOLD
}

function deltaPct(current: number, rollingMean: number): number | null {
  if (rollingMean <= 0) return null
  return (current - rollingMean) / rollingMean
}

describe('velocity baseline rule', () => {
  it('flags at the 25% threshold boundary', () => {
    expect(isFlagged(125, 100)).toBe(true)
    expect(isFlagged(125.01, 100)).toBe(true)
  })

  it('does not flag just below the threshold', () => {
    expect(isFlagged(124.99, 100)).toBe(false)
    expect(isFlagged(120, 100)).toBe(false)
  })

  it('does not flag when current is below the mean', () => {
    expect(isFlagged(80, 100)).toBe(false)
    expect(isFlagged(0, 100)).toBe(false)
  })

  it('treats zero or missing mean as un-flaggable', () => {
    expect(isFlagged(500, 0)).toBe(false)
    expect(deltaPct(500, 0)).toBeNull()
  })

  it('computes the delta percentage as a signed ratio', () => {
    expect(deltaPct(120, 100)).toBeCloseTo(0.2, 5)
    expect(deltaPct(80, 100)).toBeCloseTo(-0.2, 5)
    expect(deltaPct(150, 100)).toBeCloseTo(0.5, 5)
  })
})
