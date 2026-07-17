/*
 * shared/usage/allocate-cents — largest-remainder cent allocation (#142 review
 * finding 3: displayed finance lanes must sum EXACTLY to the displayed total).
 *
 * Pins:
 *   - THE DRIFT CASE: independent toFixed(2) turns [3.334, 3.334, 3.332] into
 *     3.33×3 = 9.99 while the total shows 10.00; allocateCentsFixed hands the
 *     leftover cent to the largest remainder so Σ lanes == '10.00';
 *   - already-exact parts pass through unchanged;
 *   - degenerate shapes (single part, empty array) behave;
 *   - non-finite parts are treated as 0, never NaN-poison the allocation;
 *   - an explicit `total` overrides the parts' own sum (the finance.get.ts
 *     call site allocates lanes against agg.total_cost_usd, not Σ lanes);
 *   - a NEGATIVE leftover (total rounds below the parts' floors) removes cents
 *     from the SMALLEST remainders;
 *   - property loop: for random 5-part arrays, Σ allocateCents(parts) equals
 *     round(Σ parts, 2) to the cent — the conservation invariant the finance
 *     surfaces display.
 */
import { describe, it, expect } from 'vitest'
import { allocateCents, allocateCentsFixed } from '../../../shared/usage/allocate-cents'

/** Sum a result in INTEGER cents (summing the floats back up would reintroduce
 * the FP drift the helper exists to eliminate). */
const sumCents = (vals: readonly number[]): number => vals.reduce((a, v) => a + Math.round(v * 100), 0)

describe('allocateCents / allocateCentsFixed — largest-remainder allocation (#142)', () => {
  it('THE DRIFT CASE: [3.334, 3.334, 3.332] allocates to strings summing to exactly 10.00', () => {
    const fixed = allocateCentsFixed([3.334, 3.334, 3.332])
    // Independent toFixed(2) would give ['3.33','3.33','3.33'] = 9.99 vs a 10.00 total.
    expect(fixed).toHaveLength(3)
    const totalCents = fixed.reduce((a, s) => a + Math.round(Number(s) * 100), 0)
    expect(totalCents).toBe(1000) // Σ == '10.00' exactly
    // The extra cent lands on a LARGEST-remainder part (.334), never the .332 one.
    expect(fixed[2]).toBe('3.33')
    expect(fixed.filter((s) => s === '3.34')).toHaveLength(1)
    expect(fixed.filter((s) => s === '3.33')).toHaveLength(2)
  })

  it('already-cent-exact parts pass through unchanged', () => {
    expect(allocateCents([1.25, 2.5, 0.01])).toEqual([1.25, 2.5, 0.01])
    expect(allocateCentsFixed([1.25, 2.5, 0.01])).toEqual(['1.25', '2.50', '0.01'])
  })

  it('a single part rounds to the rounded total', () => {
    expect(allocateCents([7.777])).toEqual([7.78])
    expect(allocateCentsFixed([7.777])).toEqual(['7.78'])
  })

  it('an empty array yields an empty allocation (and never loops)', () => {
    expect(allocateCents([])).toEqual([])
    expect(allocateCentsFixed([])).toEqual([])
  })

  it('non-finite parts are treated as 0 — one NaN cannot poison the lanes', () => {
    expect(allocateCents([Number.NaN, 1.0])).toEqual([0, 1])
    expect(allocateCents([Number.POSITIVE_INFINITY, 2.5])).toEqual([0, 2.5])
    expect(allocateCentsFixed([Number.NaN, 1.005, 1.005])).toEqual(['0.00', '1.01', '1.00'])
  })

  it('an explicit total OVERRIDES the parts sum (the finance.get.ts shape: lanes vs agg total)', () => {
    // Parts sum to 2.00 but the caller's total is 3.00 — the missing dollar is
    // distributed in cents across the parts, conserving the DISPLAYED total.
    const alloc = allocateCents([1.0, 1.0], 3.0)
    expect(sumCents(alloc)).toBe(300)
    expect(alloc).toEqual([1.5, 1.5])
    // A non-finite explicit total falls back to the parts' own sum.
    expect(allocateCents([1.0, 1.0], Number.NaN)).toEqual([1, 1])
  })

  it('a NEGATIVE leftover (total rounds below the floors) removes cents from the SMALLEST remainders', () => {
    // exact cents [199.9, 200.1] floor to [199, 200] (Σ 399); total 3.98 → 398,
    // leftover -1. The SMALLEST remainder (the .1) gives the cent back.
    const alloc = allocateCents([1.999, 2.001], 3.98)
    expect(sumCents(alloc)).toBe(398)
    expect(alloc).toEqual([1.99, 1.99])
    // Two cents short: both parts give one back.
    const alloc2 = allocateCents([1.3, 2.4], 3.68)
    expect(sumCents(alloc2)).toBe(368)
    expect(alloc2).toEqual([1.29, 2.39])
  })

  it('PROPERTY: for random 5-part arrays, Σ allocateCents(parts) == round(Σ parts, 2) to the cent', () => {
    // Deterministic LCG so a failure is reproducible from the seed.
    let seed = 0xc0ffee
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    for (let iter = 0; iter < 500; iter++) {
      // 5 sub-cent-precision USD parts in [0, 20) — the finance-lane shape.
      const parts = Array.from({ length: 5 }, () => Math.round(rand() * 200000) / 10000)
      const rawTotal = parts.reduce((a, b) => a + b, 0)
      const alloc = allocateCents(parts)
      expect(alloc).toHaveLength(5)
      // Every allocated value is cent-exact…
      for (const v of alloc) {
        expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6)
      }
      // …and the allocation conserves the rounded total EXACTLY.
      expect(sumCents(alloc)).toBe(Math.round(rawTotal * 100))
      // No part drifts more than a cent from its exact value (largest-remainder
      // never moves more than one cent per part for a sub-cent leftover).
      for (let i = 0; i < parts.length; i++) {
        expect(Math.abs(alloc[i]! - parts[i]!)).toBeLessThan(0.011)
      }
    }
  })
})
