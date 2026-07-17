/*
 * fold-lanes — kit-level lane folding for every lane-dimensioned chart
 * (lane-visuals design V1 item 2, r1-F3/r1-F4/r2-2).
 *
 * The rule, stated mechanically:
 *   - lane RANKING is computed ONCE over the WHOLE chart window (Σ per lane
 *     across every point) — NEVER per point. Per-point re-ranking would churn
 *     lane membership (and therefore colour) bar-to-bar, so it is explicitly
 *     rejected (r2-2). Lane identity, colour, and fold membership are stable
 *     across every point of a chart.
 *   - when the lane count exceeds `max`, the top-(max−1) lanes keep their
 *     identity and the rest aggregate into ONE remainder pseudo-lane
 *     (`other-lanes` / "Other surfaces", neutral colour, itemised for its
 *     tooltip/legend), so the post-fold series count is always ≤ max — the
 *     dataviz "≤ 6 stacked series" ceiling holds by construction.
 *   - EVERY fold on a page that carries ONE page-level LaneLegend uses the SAME
 *     cap — MAX_CHART_LANES (r3-3): a trend folding at 6 while its sibling donut
 *     folds at 5 keeps a lane as its own coloured series in one card while the
 *     other folds it into "Other surfaces", so the page's single legend entry
 *     maps to a visible mark in some cards but not others — colour-alone
 *     identity, which this design exists to forbid.
 *   - folding is conservation-preserving BY CONSTRUCTION: the remainder is the
 *     per-point Σ of exactly the folded lanes, so Σ(folded output) == Σ(input)
 *     at every point (pinned by tests/unit/components/fold-lanes.test.ts).
 *
 * Kept lanes preserve their INPUT order (callers pass canonical VENDOR_LANES
 * order) — the whole-window ranking decides MEMBERSHIP only, never render
 * order, so a lane never jumps position in the stack when its rank shifts.
 *
 * Pure TS (no Vue, no DOM) so the fold maths is unit-testable.
 */

/** One point of a lane series (mirrors the chart kit's TrendPoint). */
export interface LanePoint {
  x: string
  y: number
}

/** One lane's series: registry lane id, display label, day-keyed points. */
export interface LaneSeries {
  lane: string
  label: string
  data: LanePoint[]
}

/** One lane's scalar total (donut / composition folding). */
export interface LaneTotal {
  lane: string
  label: string
  value: number
}

/**
 * The ONE lane cap for every fold feeding a page-level LaneLegend (r3-3).
 * Both the lane trend AND the lane donut/composition on a page fold with THIS
 * cap so their kept-lane sets are identical — a legend entry always maps to a
 * visible, separately-coloured mark in EVERY card on the page. 5 is the
 * tighter (donut) ceiling; ≤ 5 also satisfies the ≤ 6 stacked-series rule.
 */
export const MAX_CHART_LANES = 5

/** The folded-remainder pseudo-lane id — NOT a registry lane; colour resolves
 *  to the neutral remainder hue (useChartTheme.colorForKey knows it). */
export const FOLDED_LANE_ID = 'other-lanes'
/** The folded-remainder display label (lane-visuals V1 item 2). */
export const FOLDED_LANE_LABEL = 'Other surfaces'

export interface FoldedLaneSeries {
  /** Kept lanes in INPUT order, plus (when folding occurred) the remainder last. ≤ max. */
  series: LaneSeries[]
  /** The lanes that folded into the remainder (whole-window totals) — tooltip itemisation. */
  folded: Array<{ lane: string; label: string; total: number }>
}

export interface FoldedLaneTotals {
  /** Kept rows in INPUT order, plus (when folding occurred) the remainder last. ≤ max. */
  totals: LaneTotal[]
  /** The rows that folded into the remainder — tooltip itemisation. */
  folded: Array<{ lane: string; label: string; total: number }>
}

/** Whole-window Σ per lane — the ONE ranking operand (r2-2). */
function seriesTotal(s: LaneSeries): number {
  let t = 0
  for (const p of s.data) t += p.y
  return t
}

/** The set of lanes that KEEP their identity: the top-(max−1) by whole-window
 *  total (ties resolve to input order — earlier wins, via an EXPLICIT secondary
 *  sort key on the original index, never engine sort stability), or everything
 *  when the input already fits. */
function keptLanes<T>(rows: readonly T[], total: (row: T) => number, max: number): Set<T> {
  if (rows.length <= max) return new Set(rows)
  const ranked = rows
    .map((row, index) => ({ row, index, total: total(row) }))
    .sort((a, b) => b.total - a.total || a.index - b.index)
  return new Set(ranked.slice(0, Math.max(0, max - 1)).map((r) => r.row))
}

/**
 * Fold a lane SERIES set to at most `max` series (default 6 — the stacked-chart
 * ceiling; pages carrying ONE LaneLegend pass MAX_CHART_LANES so every sibling
 * fold keeps the same lane set, r3-3). Rank once over the whole window; the
 * fold's remainder series is the per-x Σ of the folded lanes
 * (conservation-preserving by construction).
 */
export function foldLaneSeries(
  series: readonly LaneSeries[],
  opts: { max?: number } = {},
): FoldedLaneSeries {
  const max = opts.max ?? 6
  const keep = keptLanes(series, seriesTotal, max)
  if (keep.size === series.length) return { series: [...series], folded: [] }

  const kept = series.filter((s) => keep.has(s))
  const foldedSeries = series.filter((s) => !keep.has(s))
  // Remainder = per-x Σ of exactly the folded lanes, over the union of their x's.
  const byX = new Map<string, number>()
  for (const s of foldedSeries) {
    for (const p of s.data) byX.set(p.x, (byX.get(p.x) ?? 0) + p.y)
  }
  const remainder: LaneSeries = {
    lane: FOLDED_LANE_ID,
    label: FOLDED_LANE_LABEL,
    data: [...byX.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([x, y]) => ({ x, y })),
  }
  return {
    series: [...kept, remainder],
    folded: foldedSeries.map((s) => ({ lane: s.lane, label: s.label, total: seriesTotal(s) })),
  }
}

/**
 * Fold lane TOTALS (donut slices / composition rows) to at most `max` rows
 * (donuts cap at 5 == MAX_CHART_LANES, r1-F3/r3-3). Same whole-window (here:
 * whole-value) rank-once rule; the remainder row is the Σ of the folded rows.
 */
export function foldLaneTotals(
  rows: readonly LaneTotal[],
  opts: { max?: number } = {},
): FoldedLaneTotals {
  const max = opts.max ?? 5
  const keep = keptLanes(rows, (r) => r.value, max)
  if (keep.size === rows.length) return { totals: [...rows], folded: [] }

  const kept = rows.filter((r) => keep.has(r))
  const folded = rows.filter((r) => !keep.has(r))
  const remainder: LaneTotal = {
    lane: FOLDED_LANE_ID,
    label: FOLDED_LANE_LABEL,
    value: folded.reduce((a, r) => a + r.value, 0),
  }
  return {
    totals: [...kept, remainder],
    folded: folded.map((r) => ({ lane: r.lane, label: r.label, total: r.value })),
  }
}
