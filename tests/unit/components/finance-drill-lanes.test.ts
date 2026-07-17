/*
 * drill-lanes — the pure dominant-lane pick behind FinanceDrill's per-teammate
 * badge (lane-visuals V3, r1-F7/r2-5). Pins the design semantics: largest lane
 * wins, ties resolve to canonical (input) order so the badge never flickers,
 * the share is a fraction of the ROW's charge, the others itemise largest-first,
 * and a $0/credit-only row gets NO badge (null, never NaN).
 */
import { describe, it, expect } from 'vitest'
import { dominantLaneOf } from '../../../app/components/reporting/finance/drill-lanes'

const lane = (id: string, usd: number) => ({ lane: id, label: id, usd })

describe('dominantLaneOf', () => {
  it('picks the largest lane and shares it against the ROW charge', () => {
    const b = dominantLaneOf([lane('claude', 30), lane('claude-ai', 10)], 40)!
    expect(b.lane).toBe('claude')
    expect(b.sharePct).toBeCloseTo(0.75, 9)
    expect(b.othersCount).toBe(1)
    expect(b.others).toEqual([lane('claude-ai', 10)])
  })

  it('ties resolve to the EARLIER (canonical-order) lane — no badge flicker', () => {
    const b = dominantLaneOf([lane('claude', 10), lane('claude-ai', 10)], 20)!
    expect(b.lane).toBe('claude')
    expect(b.sharePct).toBeCloseTo(0.5, 9)
  })

  it('others itemise largest-first regardless of input order', () => {
    const b = dominantLaneOf([lane('claude', 50), lane('claude-ai', 5), lane('claude-slack', 20)], 75)!
    expect(b.others.map((l) => l.lane)).toEqual(['claude-slack', 'claude-ai'])
    expect(b.othersCount).toBe(2)
  })

  it('a single-lane row badges at 100% with no others affordance', () => {
    const b = dominantLaneOf([lane('claude', 12)], 12)!
    expect(b.sharePct).toBeCloseTo(1, 9)
    expect(b.othersCount).toBe(0)
  })

  it('no lanes / non-positive charge → null (no NaN share, no badge)', () => {
    expect(dominantLaneOf([], 10)).toBeNull()
    expect(dominantLaneOf([lane('claude', 0)], 0)).toBeNull()
    expect(dominantLaneOf([lane('claude', -3)], -3)).toBeNull()
  })

  it('MIXED-sign lanes (a credit/adjustment) suppress the share — badge keeps lane + $, sharePct null (r3-5)', () => {
    // top.usd (100) / chargeUsd (70) would read "143%" — not a share. The badge
    // still names the dominant lane and carries its $; the tooltip still itemises.
    const b = dominantLaneOf([lane('claude', 100), lane('claude-ai', -30)], 70)!
    expect(b.lane).toBe('claude')
    expect(b.usd).toBe(100)
    expect(b.sharePct).toBeNull()
    expect(b.othersCount).toBe(1)
    expect(b.others).toEqual([lane('claude-ai', -30)])
  })

  it('all-positive rows keep a REAL share in [0,1] (never suppressed, never clamped)', () => {
    const b = dominantLaneOf([lane('claude', 30), lane('claude-ai', 10)], 40)!
    expect(b.sharePct).not.toBeNull()
    expect(b.sharePct!).toBeGreaterThan(0)
    expect(b.sharePct!).toBeLessThanOrEqual(1)
  })
})
