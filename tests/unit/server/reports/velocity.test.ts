// @vitest-environment node
/*
 * reports/velocity — the single dial-driven velocity definition (D-Q7 / §7(8)):
 * the spike flag tracks the governance dial; there is no numeric multiplier
 * (FLAG_MULT is retired) outside the dial.
 */
import { describe, it, expect } from 'vitest'
import { VELOCITY_SPIKE_DIAL, isVelocitySpike } from '../../../../server/reports/velocity'
import { GOV_VELOCITY_SPIKE_THRESHOLD } from '../../../../server/utils/governance-settings'

describe('VELOCITY_SPIKE_DIAL', () => {
  it('IS the governance dial key (one source of truth)', () => {
    expect(VELOCITY_SPIKE_DIAL).toBe(GOV_VELOCITY_SPIKE_THRESHOLD)
    expect(VELOCITY_SPIKE_DIAL).toBe('velocity.spike_threshold')
  })
})

describe('isVelocitySpike tracks the dial', () => {
  it('flags when the fractional delta ≥ threshold', () => {
    // current 150 vs mean 100 = +50% delta
    expect(isVelocitySpike(150, 100, 0.25)).toBe(true)
    expect(isVelocitySpike(150, 100, 0.5)).toBe(true) // exactly at threshold → flagged (>=)
    expect(isVelocitySpike(150, 100, 0.75)).toBe(false) // dial raised past the delta
  })

  it('a HIGHER dial flags strictly fewer rows (output tracks the dial)', () => {
    const current = 130
    const mean = 100 // +30% delta
    expect(isVelocitySpike(current, mean, 0.2)).toBe(true)
    expect(isVelocitySpike(current, mean, 0.3)).toBe(true)
    expect(isVelocitySpike(current, mean, 0.31)).toBe(false)
  })

  it('zero or absent baseline → never flagged (no divide, no noise)', () => {
    expect(isVelocitySpike(500, 0, 0.25)).toBe(false)
    expect(isVelocitySpike(500, -1, 0.25)).toBe(false)
  })

  it('below baseline → never flagged', () => {
    expect(isVelocitySpike(50, 100, 0.25)).toBe(false)
  })
})
