/*
 * build-practice-bill-lanes — the pure builders behind the practice page's §B
 * bill-lane cards (lane-visuals V4, r3-4).
 *
 * BOTH practice bill-lane cards fold with the SAME shared cap
 * (MAX_CHART_LANES — the r3-3 rule: one page, one legend, one cap):
 *   - buildPracticeBillLanes: the "Reconciled bill by surface" MTD segmented
 *     bar — previously UNFOLDED, so a practice with all 8 Claude surfaces live
 *     rendered 8+ slivers while the weekly stack beside it folded at a
 *     different ceiling, and the shared legend listed lanes the weekly stack
 *     never showed as distinct colours.
 *   - buildPracticeBillWeekly: the 14-week weekly stacked bars (fold per V1 —
 *     rank-once over the whole window, conservation-preserving).
 *
 * Folding is conservation-preserving by construction (fold-lanes.ts); the MTD
 * builder additionally nets NEGATIVE lanes into the bar rather than dropping
 * them (`!== 0`, the FinanceBillCompare.foldGroup / r3-2 convention) so
 * Σ segments always equals the lanes' Σ. Pure TS (no Vue, no DOM) so the fold
 * maths is unit-testable; colours/tooltips stay in the page.
 */
import { VENDOR_LABELS } from '#shared/usage/vendor'
import { foldLaneSeries, foldLaneTotals, MAX_CHART_LANES } from './charts/fold-lanes'

/** One MTD per-lane bill row (the endpoint's vendorSplit shape, bill arm). */
export interface PracticeBillLaneRow {
  lane: string
  label: string
  billUsd: number
}

export interface BuiltPracticeBillLanes {
  /** Folded rows (≤ MAX_CHART_LANES, remainder last) with their share of the bill. */
  lanes: Array<{ lane: string; label: string; billUsd: number; shareOfBill: number }>
  /** The lanes folded into the remainder — tooltip itemisation. */
  folded: Array<{ lane: string; label: string; total: number }>
}

/**
 * Fold the MTD "Reconciled bill by surface" lanes to ≤ MAX_CHART_LANES rows.
 * Non-zero lanes only (`!== 0` — a negative/credit lane NETS IN, never silently
 * drops); `billUsd` is the card's headline total the shares are taken against.
 */
export function buildPracticeBillLanes(
  rows: readonly PracticeBillLaneRow[],
  billUsd: number,
): BuiltPracticeBillLanes {
  const live = rows.filter((l) => l.billUsd !== 0)
  const folded = foldLaneTotals(
    live.map((l) => ({ lane: l.lane, label: l.label, value: l.billUsd })),
    { max: MAX_CHART_LANES },
  )
  return {
    lanes: folded.totals.map((t) => ({
      lane: t.lane,
      label: t.label,
      billUsd: t.value,
      shareOfBill: billUsd > 0 ? t.value / billUsd : 0,
    })),
    folded: folded.folded,
  }
}

/** One weekly per-lane §B cell (the endpoint's billWeeklyLanes shape). */
export interface PracticeBillWeeklyCell {
  weekStart: string
  lane: string
  usd: number
}

export interface BuiltPracticeBillWeekly {
  bars: Array<{
    weekStart: string
    totalUsd: number
    segments: Array<{ lane: string; label: string; usd: number }>
  }>
  /** The lane ids actually rendered (kept + the folded remainder) — legend source. */
  laneIds: string[]
}

/**
 * Build the weekly §B bill-by-surface stacked bars: fold per V1 (rank-once over
 * the whole 14-week window, ≤ MAX_CHART_LANES series, conservation-preserving),
 * then slice per week. Zero-value segments are elided per bar (a rendering
 * concern — fold membership is already decided window-wide).
 */
export function buildPracticeBillWeekly(
  rows: readonly PracticeBillWeeklyCell[],
): BuiltPracticeBillWeekly {
  if (!rows.length) return { bars: [], laneIds: [] }
  const weeks = [...new Set(rows.map((r) => r.weekStart))].sort()
  const byLane = new Map<string, Map<string, number>>()
  for (const r of rows) {
    let m = byLane.get(r.lane)
    if (!m) byLane.set(r.lane, (m = new Map()))
    m.set(r.weekStart, (m.get(r.weekStart) ?? 0) + r.usd)
  }
  // Rows arrive in canonical lane order (server contract) — preserve it.
  const folded = foldLaneSeries(
    [...byLane.entries()].map(([lane, m]) => ({
      lane,
      label: (VENDOR_LABELS as Readonly<Record<string, string>>)[lane] ?? lane,
      data: weeks.map((w) => ({ x: w, y: m.get(w) ?? 0 })),
    })),
    { max: MAX_CHART_LANES },
  )
  const bars = weeks.map((w, i) => {
    const segments = folded.series
      .map((s) => ({ lane: s.lane, label: s.label, usd: s.data[i]?.y ?? 0 }))
      // `!== 0`, NEVER `> 0`: a credit/adjustment week must NET into the bar
      // total and tooltip, not silently vanish (same netting convention as the
      // MTD builder above and the chargeback donut — review r2 finding).
      .filter((seg) => seg.usd !== 0)
    return { weekStart: w, totalUsd: segments.reduce((a, seg) => a + seg.usd, 0), segments }
  })
  return { bars, laneIds: folded.series.map((s) => s.lane) }
}
