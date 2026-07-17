/*
 * fold-lanes — the kit-level lane fold (lane-visuals V1 item 2, r1-F3/F4/r2-2).
 * Pins the three design invariants:
 *   1. CONSERVATION: Σ(folded output) == Σ(unfolded input) at every point;
 *   2. RANK-ONCE MEMBERSHIP STABILITY: fold membership is computed over the
 *      WHOLE window — a lane that wins on one day but loses over the window is
 *      folded EVERYWHERE (per-point re-ranking is explicitly rejected);
 *   3. the post-fold series count is ≤ max (the ≤6-stacked-series ceiling; the
 *      remainder is ONE itemised pseudo-lane, kept lanes keep input order).
 */
import { describe, it, expect } from 'vitest'
import {
  foldLaneSeries,
  foldLaneTotals,
  FOLDED_LANE_ID,
  FOLDED_LANE_LABEL,
  MAX_CHART_LANES,
  type LaneSeries,
} from '../../../app/components/reporting/charts/fold-lanes'

const mk = (lane: string, ys: Record<string, number>): LaneSeries => ({
  lane,
  label: lane.toUpperCase(),
  data: Object.entries(ys).map(([x, y]) => ({ x, y })),
})

/** Σ over every point of every series. */
const grandTotal = (series: LaneSeries[]): number =>
  series.reduce((a, s) => a + s.data.reduce((b, p) => b + p.y, 0), 0)

/** Per-x Σ across a series set. */
const totalsByX = (series: LaneSeries[]): Map<string, number> => {
  const m = new Map<string, number>()
  for (const s of series) for (const p of s.data) m.set(p.x, (m.get(p.x) ?? 0) + p.y)
  return m
}

describe('foldLaneSeries', () => {
  const eight = [
    mk('l1', { d1: 100, d2: 100 }),
    mk('l2', { d1: 90 }),
    mk('l3', { d1: 80 }),
    mk('l4', { d1: 70 }),
    mk('l5', { d1: 60 }),
    mk('l6', { d1: 50 }),
    mk('l7', { d1: 2, d2: 3 }),
    mk('l8', { d2: 1 }),
  ]

  it('is the identity when the lane count fits max', () => {
    const input = eight.slice(0, 6)
    const out = foldLaneSeries(input, { max: 6 })
    expect(out.series).toEqual(input)
    expect(out.folded).toEqual([])
  })

  it('folds to ≤ max series: top-(max−1) keep identity + ONE itemised remainder', () => {
    const out = foldLaneSeries(eight, { max: 6 })
    expect(out.series).toHaveLength(6) // the ≤6 stacked-series ceiling holds post-fold
    expect(out.series.map((s) => s.lane)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5', FOLDED_LANE_ID])
    const remainder = out.series.at(-1)!
    expect(remainder.label).toBe(FOLDED_LANE_LABEL)
    // Remainder = per-x Σ of exactly the folded lanes (l6 + l7 + l8).
    expect(remainder.data).toEqual([
      { x: 'd1', y: 52 },
      { x: 'd2', y: 4 },
    ])
    // Itemisation (tooltip contract) lists every folded lane with its window total.
    expect(out.folded).toEqual([
      { lane: 'l6', label: 'L6', total: 50 },
      { lane: 'l7', label: 'L7', total: 5 },
      { lane: 'l8', label: 'L8', total: 1 },
    ])
  })

  it('CONSERVATION: Σ folded == Σ unfolded, per point and overall', () => {
    const out = foldLaneSeries(eight, { max: 6 })
    expect(grandTotal(out.series)).toBeCloseTo(grandTotal(eight), 9)
    const before = totalsByX(eight)
    const after = totalsByX(out.series)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [x, v] of before) expect(after.get(x)!).toBeCloseTo(v, 9)
  })

  it('MEMBERSHIP STABILITY: ranking is whole-window — a lane winning one day but losing the window folds everywhere', () => {
    // 'spiky' dominates d1 (100 vs 10/9) but its WINDOW total (100) loses to the
    // steady lanes (10×30=300, 9×30=270, 8×30=240). Per-point ranking would keep
    // 'spiky' on d1 and fold it elsewhere (colour churn); rank-once folds it at
    // EVERY point, including its winning day.
    const days = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`d${String(i + 1).padStart(2, '0')}`, 10]))
    const series = [
      mk('steady-a', days),
      mk('steady-b', Object.fromEntries(Object.keys(days).map((d) => [d, 9]))),
      mk('steady-c', Object.fromEntries(Object.keys(days).map((d) => [d, 8]))),
      mk('spiky', { d01: 100 }),
    ]
    const out = foldLaneSeries(series, { max: 3 })
    expect(out.series.map((s) => s.lane)).toEqual(['steady-a', 'steady-b', FOLDED_LANE_ID])
    // spiky's winning day sits INSIDE the remainder (spiky 100 + steady-c 8).
    const remainder = out.series.at(-1)!
    expect(remainder.data.find((p) => p.x === 'd01')!.y).toBeCloseTo(108, 9)
    expect(out.folded.map((f) => f.lane)).toEqual(['steady-c', 'spiky'])
  })

  it('kept lanes preserve INPUT order (rank decides membership, never render order)', () => {
    // l-last has the biggest total but was declared last — it keeps its slot order.
    const series = [mk('l-a', { d1: 1 }), mk('l-b', { d1: 50 }), mk('l-c', { d1: 2 }), mk('l-last', { d1: 99 })]
    const out = foldLaneSeries(series, { max: 3 })
    expect(out.series.map((s) => s.lane)).toEqual(['l-b', 'l-last', FOLDED_LANE_ID])
  })

  it('TIE at the fold boundary resolves to the EARLIER input lane — explicit secondary key, not engine sort stability (r3-8)', () => {
    // tie-early and tie-late have IDENTICAL window totals; only one keeps its
    // identity at max 3 (top-2 + remainder). The explicit (total DESC, input
    // index ASC) key keeps tie-early — pinned so the "never flickers" fold
    // membership does not rest on an unstated Array#sort stability assumption.
    const series = [
      mk('big', { d1: 100 }),
      mk('tie-early', { d1: 10 }),
      mk('tie-late', { d1: 10 }),
      mk('small', { d1: 1 }),
    ]
    const out = foldLaneSeries(series, { max: 3 })
    expect(out.series.map((s) => s.lane)).toEqual(['big', 'tie-early', FOLDED_LANE_ID])
    expect(out.folded.map((f) => f.lane)).toEqual(['tie-late', 'small'])
  })
})

describe('MAX_CHART_LANES (the shared page cap, r3-3)', () => {
  it('is 5 — the tighter donut ceiling, ≤ the 6-stacked-series rule', () => {
    expect(MAX_CHART_LANES).toBe(5)
    expect(MAX_CHART_LANES).toBeLessThanOrEqual(6)
  })
})

describe('foldLaneTotals (donut cap, r1-F3)', () => {
  const rows = [
    { lane: 'a', label: 'A', value: 50 },
    { lane: 'b', label: 'B', value: 40 },
    { lane: 'c', label: 'C', value: 30 },
    { lane: 'd', label: 'D', value: 20 },
    { lane: 'e', label: 'E', value: 10 },
    { lane: 'f', label: 'F', value: 5 },
    { lane: 'g', label: 'G', value: 1 },
  ]

  it('caps at max slices with a conservation-preserving remainder', () => {
    const out = foldLaneTotals(rows, { max: 5 })
    expect(out.totals).toHaveLength(5)
    expect(out.totals.map((r) => r.lane)).toEqual(['a', 'b', 'c', 'd', FOLDED_LANE_ID])
    expect(out.totals.at(-1)!.value).toBeCloseTo(10 + 5 + 1, 9)
    const sum = (xs: Array<{ value: number }>) => xs.reduce((s, r) => s + r.value, 0)
    expect(sum(out.totals)).toBeCloseTo(sum(rows), 9)
    expect(out.folded.map((f) => f.lane)).toEqual(['e', 'f', 'g'])
  })

  it('is the identity when the rows fit', () => {
    const out = foldLaneTotals(rows.slice(0, 5), { max: 5 })
    expect(out.totals).toEqual(rows.slice(0, 5))
    expect(out.folded).toEqual([])
  })
})
