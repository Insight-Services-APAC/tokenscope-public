// @vitest-environment node
/*
 * S10 (B) — computeCopilotCost is bounded the same way the Claude lane is
 * bounded by MAX_COST_MICROS: nano_aiu is CLIENT-ASSERTED
 * (github.copilot.nano_aiu), same threat model as every other emitter-
 * controlled value this sprint bounds, and unlike the Claude lane there is
 * no rate card to fall back to. A figure the NUMERIC(14,6) column cannot
 * store must be rejected (returns null) rather than attempted — the caller
 * (server/workers/azure-monitor-reader.ts) folds every null outcome into the
 * EXISTING skippedNoCard counter, so this pins the boundary condition only;
 * the counting itself is exercised by the joiner's existing "nano_aiu
 * absent" behaviour, unchanged.
 */
import { describe, it, expect } from 'vitest'
import { computeCopilotCost } from '../../../server/workers/azure-monitor-reader'

describe('computeCopilotCost — (B) storability bound', () => {
  it('prices a normal nano_aiu unchanged (regression pin)', () => {
    // 9.11 credits ⇒ $0.0911 — the cross-check value from the module's own doc comment.
    expect(computeCopilotCost(9_111_525_000)).toBe('0.091115')
  })

  it('rejects an out-of-range nano_aiu that would overflow attribution_record.cost_usd (NUMERIC(14,6))', () => {
    // cost_usd = nano_aiu * 1e-11. 2e19 -> cost = 2e8 ($200,000,000), far past
    // the column's 99,999,999.999999 ceiling (span-costing.ts MAX_COST_MICROS).
    expect(computeCopilotCost(2e19)).toBeNull()
  })

  it('accepts a large-but-legitimate nano_aiu comfortably inside the ceiling (the bound must not clip real heavy usage)', () => {
    // cost_usd = nano_aiu * 1e-11. 5e18 -> cost = $50,000,000 — a lot of spend
    // for one span, but well under the $99,999,999.999999 column ceiling, and
    // real Copilot spans are billions, not quintillions — this is the
    // "ordinary large value" the bound must let through untouched.
    expect(computeCopilotCost(5e18)).toBe('50000000.000000')
  })

  it('still returns null for the pre-existing absent/non-finite/non-positive/rounds-to-zero cases (unchanged)', () => {
    expect(computeCopilotCost(undefined)).toBeNull()
    expect(computeCopilotCost(Number.NaN)).toBeNull()
    expect(computeCopilotCost(0)).toBeNull()
    expect(computeCopilotCost(-5)).toBeNull()
    expect(computeCopilotCost(1)).toBeNull() // rounds to "0.000000" at 6dp
  })
})
