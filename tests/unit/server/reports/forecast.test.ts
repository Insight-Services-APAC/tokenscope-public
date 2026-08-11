// @vitest-environment node
/*
 * reports/forecast — run-rate anchoring truth table (build-design §5 / §7(5)):
 *   - data through day 10 + now = day 20 → the factor uses 10 (asOf), NOT 20 (now)
 *   - Copilot seat + overage sources excluded from the metered operand
 *   - a closed (or future) month → null forecast
 *   - the Copilot overage projection is estimate-class only
 */
import { describe, it, expect } from 'vitest'
import {
  forecastForMonth,
  isMeteredSource,
  meteredMtd,
  projectCopilotOverage,
} from '../../../../server/reports/forecast'

describe('metered-operand exclusion (seat/overage never extrapolated)', () => {
  it('isMeteredSource excludes copilot-seat:* and copilot-overage only', () => {
    expect(isMeteredSource('anthropic-analytics-api')).toBe(true)
    expect(isMeteredSource('api-reconciled')).toBe(true)
    expect(isMeteredSource('copilot-seat:enterprise')).toBe(false)
    expect(isMeteredSource('copilot-seat:business')).toBe(false)
    expect(isMeteredSource('copilot-overage')).toBe(false)
  })

  it('meteredMtd sums only the metered rows', () => {
    const rows = [
      { source: 'anthropic-analytics-api', costUsd: 100 },
      { source: 'copilot-seat:enterprise', costUsd: 39 }, // month-final, excluded
      { source: 'copilot-overage', costUsd: 20 }, // cumulative snapshot, excluded
    ]
    expect(meteredMtd(rows)).toBe(100)
  })
})

describe('forecastForMonth anchoring', () => {
  it('anchors days_elapsed on asOf (day 10), NOT on now (day 20)', () => {
    const f = forecastForMonth({
      requestedMonth: '2026-06',
      now: new Date('2026-06-20T12:00:00Z'),
      asOf: new Date('2026-06-10T08:00:00Z'),
      meteredMtdUsd: 100,
    })
    expect(f).not.toBeNull()
    expect(f!.daysElapsed).toBe(10) // asOf's day, never now's 20
    expect(f!.dayOfMonth).toBe(20) // the clock's day, never asOf's 10
    expect(f!.daysInMonth).toBe(30)
    expect(f!.factor).toBe(3) // 30 / 10
    expect(f!.meteredProjectedUsd).toBe(300) // 100 × 3
    expect(f!.projectedUsd).toBe(300) // no Copilot → scope total = metered projection
    expect(f!.asOfDate).toBe('2026-06-10')
  })

  it('a CLOSED month → null forecast (never a stale projection)', () => {
    const f = forecastForMonth({
      requestedMonth: '2026-05', // last month, relative to a June now
      now: new Date('2026-06-20T12:00:00Z'),
      asOf: new Date('2026-06-10T08:00:00Z'),
      meteredMtdUsd: 100,
    })
    expect(f).toBeNull()
  })

  it('a FUTURE month → null forecast', () => {
    const f = forecastForMonth({
      requestedMonth: '2026-07',
      now: new Date('2026-06-20T12:00:00Z'),
      asOf: new Date('2026-06-10T08:00:00Z'),
      meteredMtdUsd: 100,
    })
    expect(f).toBeNull()
  })

  it('no data yet in the current month → projected 0, asOfDate null, no divide-by-zero', () => {
    const f = forecastForMonth({
      requestedMonth: '2026-06',
      now: new Date('2026-06-03T12:00:00Z'),
      asOf: null,
      meteredMtdUsd: 0,
    })
    expect(f).not.toBeNull()
    expect(f!.daysElapsed).toBe(1) // anchored on month start, floored at 1
    /*
     * …and the CAPTION's day is the CLOCK's, not that fallback. One field used
     * to serve both, so here a scope with no data yet said "day 1 of 30" when
     * it was the 3rd. Harmless for the projection (MTD is 0, so the factor
     * cannot matter); a false statement in the hero.
     */
    expect(f!.dayOfMonth).toBe(3)
    expect(f!.projectedUsd).toBe(0)
    expect(f!.asOfDate).toBeNull()
  })

  it('scope total = metered projection + Copilot seat-final + overage projection', () => {
    const f = forecastForMonth({
      requestedMonth: '2026-06',
      now: new Date('2026-06-20T12:00:00Z'),
      asOf: new Date('2026-06-10T08:00:00Z'), // factor 3
      meteredMtdUsd: 100, // → 300 projected
      copilot: { seatFinalUsd: 39, creditsMtdUsd: 50, poolUsd: 100 },
    })
    expect(f).not.toBeNull()
    expect(f!.copilot!.projectedCreditsUsd).toBe(150) // 50 × 3
    expect(f!.copilot!.projectedOverageUsd).toBe(50) // max(0, 150 − 100)
    expect(f!.copilot!.spendClass).toBe('estimated') // never a charge
    // 300 metered + 39 seat-final + 50 overage projection
    expect(f!.projectedUsd).toBe(389)
  })
})

describe('projectCopilotOverage (estimate-class pool math)', () => {
  it('is max(0, projected − pool) when the pool is positive', () => {
    expect(projectCopilotOverage(150, 100)).toBe(50)
    expect(projectCopilotOverage(80, 100)).toBe(0) // within pool → no overage
  })
  it('is 0 when the pool is not positive (overage disabled — skip pool ≤ 0)', () => {
    expect(projectCopilotOverage(150, 0)).toBe(0)
    expect(projectCopilotOverage(150, -1)).toBe(0)
  })
})
