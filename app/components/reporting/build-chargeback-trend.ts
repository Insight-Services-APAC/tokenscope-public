/*
 * build-chargeback-trend — the pure builders behind the §B chargeback-lane cards
 * (lane-visuals design V2, Across scope first).
 *
 * AXIS RULE (the firewall): everything here is §B — the inputs come from the
 * chargeback views ONLY (`v_finance_bill_chargeback` daily lanes; the pooled
 * Copilot lane totals). No §A usage figure, forecast operand, or dimension ever
 * enters a series, sum, stack, or annotation here; the run-rate tail's MTD
 * operand is the §B total series itself.
 *
 *   - buildChargebackLaneTrend: folded per-lane STACKED series over the
 *     zero-filled total axis + a run-rate tail on the TOTAL (per V2: the tail
 *     continues the total, never a per-lane guess). Fold per V1 (rank-once
 *     whole-window, ≤ MAX_CHART_LANES series, conservation-preserving).
 *   - buildChargebackDonut: the split-card donut — capped at MAX_CHART_LANES
 *     slices + fold (r1-F3/r3-3 — the SAME cap as the trend, so both cards keep
 *     the same lane set for the one page legend); copilot-unclassified is
 *     EXCLUDED from the slices (never in a chargeable sum) and surfaced
 *     separately for its badge (the shipped FinanceCouTable convention).
 *   - chargebackLegendLanes: the page-level legend union (V1 item 5) — the
 *     lanes actually rendered by the scope's chargeback cards this period, in
 *     canonical order, the folded remainder as its single entry.
 *
 * Kept pure (no Vue, no DOM) so the fold/tail maths is unit-testable and the
 * cards stay declarative — mirrors the sibling across/build-trend.ts.
 */
import type { ChargeDailyPoint, ChargeLanePoint, ChargebackLaneRow } from '#shared/reports/types'
import { VENDOR_LANES, VENDOR_LABELS } from '#shared/usage/vendor'
import { COPILOT_UNCLASSIFIED_LANE } from '#shared/usage/github-surface'
import {
  foldLaneSeries,
  foldLaneTotals,
  FOLDED_LANE_ID,
  FOLDED_LANE_LABEL,
  MAX_CHART_LANES,
} from './charts/fold-lanes'
import { buildWeeklyLanes, groupLaneDaysToWeeks, type BuiltWeeklyLanes } from './charts/weekly-lanes'

/** Mirrors LaneLegend's entry shape (structural — no cross-.vue type import). */
export interface LaneLegendEntry {
  lane: string
  label: string
}

/** Mirrors ChartTrend's TrendPoint / TrendSeries (structural — no cross-.vue type import). */
export interface TrendPoint {
  x: string
  y: number
}
export interface TrendSeries {
  name: string
  key: string
  data: TrendPoint[]
}

export interface BuiltChargebackTrend {
  /** Folded per-lane series (≤ MAX_CHART_LANES), aligned to the zero-filled total axis — stack these. */
  series: TrendSeries[]
  /** Run-rate continuation of the TOTAL: the as-of day's actual total, then the
   *  projected days at the §B MTD daily rate. Empty when there is no projection. */
  totalTail: TrendPoint[]
  /** First projected day (`YYYY-MM-DD`); undefined when there is no projection. */
  forecastFrom?: string
  /** The lane ids actually rendered (kept + the folded remainder) — legend source. */
  laneIds: string[]
  /** Whole-window totals of the folded-away lanes — tooltip itemisation. */
  folded: Array<{ lane: string; label: string; total: number }>
}

/** Display label for a registry lane id (falls back to the raw id). */
function laneLabel(lane: string): string {
  return (VENDOR_LABELS as Readonly<Record<string, string>>)[lane] ?? lane
}

/** Zero-padded `${month}-${dd}` for a day-of-month (month is a `YYYY-MM` key). */
function dayKey(month: string, dom: number): string {
  return `${month}-${String(dom).padStart(2, '0')}`
}

/** Days in a `YYYY-MM` month (UTC). */
function daysInMonth(month: string): number {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * Build the §B chargeback-lane stacked series (+ the total's run-rate tail).
 *
 * @param lanePoints  per-(day, lane) §B points (`AcrossTrend.chargeLanes`)
 * @param totalSeries the zero-filled §B TOTAL series (`AcrossTrend.chargeSeries`)
 *                    — the axis of record and the tail's MTD operand
 * @param month       the in-progress month (`YYYY-MM`) to project to month-end;
 *                    null (closed month / custom range) ⇒ no tail
 */
export function buildChargebackLaneTrend(
  lanePoints: ChargeLanePoint[],
  totalSeries: ChargeDailyPoint[],
  month: string | null,
): BuiltChargebackTrend {
  const days = totalSeries.map((p) => p.day)
  const totalByDay = new Map(totalSeries.map((p) => [p.day, p.chargeUsd]))

  // Group the lane points (canonical VENDOR_LANES order; unknown lanes last).
  const byLane = new Map<string, Map<string, number>>()
  for (const p of lanePoints) {
    let m = byLane.get(p.lane)
    if (!m) byLane.set(p.lane, (m = new Map()))
    m.set(p.day, (m.get(p.day) ?? 0) + p.chargeUsd)
  }
  const order = new Map<string, number>(VENDOR_LANES.map((l, i) => [l, i]))
  const lanes = [...byLane.keys()].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99))

  // Fold per V1 (rank-once over the whole window) on the zero-filled axis.
  // MAX_CHART_LANES — the SAME cap as buildChargebackDonut (r3-3): both cards
  // feed the ONE page legend, so their kept-lane sets must be identical.
  const folded = foldLaneSeries(
    lanes.map((lane) => ({
      lane,
      label: laneLabel(lane),
      data: days.map((x) => ({ x, y: byLane.get(lane)?.get(x) ?? 0 })),
    })),
    { max: MAX_CHART_LANES },
  )
  const series: TrendSeries[] = folded.series.map((s) => ({
    name: s.label,
    key: s.lane,
    data: s.data,
  }))

  // Run-rate tail on the TOTAL — in-progress month only. §B-pure: the MTD
  // operand and the as-of anchor both come from the §B total series itself
  // (the bill lane has its own settling clock; never borrow the §A forecast's).
  let forecastFrom: string | undefined
  const totalTail: TrendPoint[] = []
  if (month) {
    const monthDays = days.filter((d) => d.startsWith(`${month}-`))
    const charged = monthDays.filter((d) => (totalByDay.get(d) ?? 0) > 0)
    const asOfDay = charged.at(-1)
    if (asOfDay) {
      const asOfDom = Number(asOfDay.slice(8, 10))
      const dim = daysInMonth(month)
      if (Number.isFinite(asOfDom) && asOfDom > 0 && asOfDom < dim) {
        let mtd = 0
        for (const d of monthDays) if (d <= asOfDay) mtd += totalByDay.get(d) ?? 0
        const avgDaily = mtd / asOfDom
        // Overlap the as-of day at its ACTUAL total so the dashed line connects.
        totalTail.push({ x: asOfDay, y: totalByDay.get(asOfDay) ?? 0 })
        for (let d = asOfDom + 1; d <= dim; d++) totalTail.push({ x: dayKey(month, d), y: avgDaily })
        forecastFrom = totalTail[1]?.x
      }
    }
  }

  return {
    series,
    totalTail,
    forecastFrom,
    laneIds: series.map((s) => s.key),
    folded: folded.folded,
  }
}

// ── Weekly regrouping (iter-2 I2/I4 — the chargeback lane trend's default grain) ─
/**
 * The WEEKLY regrouping of the §B chargeback lane trend (iter-2 I2): the same
 * daily `chargeLanes` cells summed into ISO weeks (UTC Mondays), then folded
 * with the kit-level weekly rules — partial current week rendered but excluded
 * from fold ranking and stats, a 100%-share twin per the '$'/'share %' switch,
 * and the composition delta from the UNFOLDED weekly cells. Σ(weekly) ==
 * Σ(daily) by construction (the grain-conservation test pins it). The weekly
 * grain absorbs single-day outliers arithmetically (I4) — nothing is clipped,
 * clamped, or rendered at a false position. Still §B-pure: the inputs are the
 * chargeback views' series only.
 *
 * The week AXIS derives from the zero-filled daily TOTAL series (the axis of
 * record), so the weekly chart spans exactly the window the daily chart does.
 * No run-rate tail at this grain: the tail is a daily-mode affordance (the
 * in-progress WEEK is the honest "partial" marker here).
 */
export function buildChargebackLaneTrendWeekly(
  lanePoints: ChargeLanePoint[],
  totalSeries: ChargeDailyPoint[],
  today: string,
): BuiltWeeklyLanes {
  const from = totalSeries[0]?.day
  const to = totalSeries.at(-1)?.day
  if (!from || !to) {
    return buildWeeklyLanes([], { from: today, to: today, today })
  }
  return buildWeeklyLanes(groupLaneDaysToWeeks(lanePoints), { from, to, today })
}

// ── Split-card donut (capped + folded, unclassified badged out) ───────────────
export interface BuiltChargebackDonut {
  /** ≤ MAX_CHART_LANES chargeable slices (folded per r1-F3/r3-3); copilot-unclassified excluded. */
  slices: Array<{ lane: string; label: string; value: number }>
  /** Σ slices — the chargeable window total (== kpis.chargeableUsd, cent-exact). */
  chargeableUsd: number
  /** The copilot-unclassified $ (visible, badged, NEVER chargeable); 0 when absent. */
  unclassifiedUsd: number
  /** The lane ids actually rendered — legend source. */
  laneIds: string[]
  /** Whole-window totals of the folded-away lanes — tooltip itemisation. */
  folded: Array<{ lane: string; label: string; total: number }>
}

/**
 * Build the ChargebackSplitCard donut from the endpoint's per-lane window
 * totals. copilot-unclassified never enters the slices or the chargeable sum —
 * it surfaces as its badge (`unclassifiedUsd`), the FinanceCouTable convention.
 */
export function buildChargebackDonut(rows: ChargebackLaneRow[]): BuiltChargebackDonut {
  const unclassifiedUsd = rows
    .filter((r) => r.lane === COPILOT_UNCLASSIFIED_LANE)
    .reduce((a, r) => a + r.chargeUsd, 0)
  // Elide only EXACT-zero lanes (`!== 0`, never `> 0`, r3-2): a negative window
  // total (credit / refund month) NETS INTO the slices and the chargeable sum —
  // the FinanceBillCompare.foldGroup convention — so Σ slices == chargeableUsd
  // == kpis.chargeableUsd stays cent-exact, and the donut can never disagree
  // with the (unfiltered) lane trend for the same window.
  const chargeable = rows.filter((r) => r.lane !== COPILOT_UNCLASSIFIED_LANE && r.chargeUsd !== 0)
  const folded = foldLaneTotals(
    chargeable.map((r) => ({ lane: r.lane, label: laneLabel(r.lane), value: r.chargeUsd })),
    { max: MAX_CHART_LANES },
  )
  return {
    slices: folded.totals,
    chargeableUsd: chargeable.reduce((a, r) => a + r.chargeUsd, 0),
    unclassifiedUsd,
    laneIds: folded.totals.map((t) => t.lane),
    folded: folded.folded,
  }
}

// ── Page-level legend union (V1 item 5) ───────────────────────────────────────
/**
 * The UNION of lanes actually rendered by the scope's chargeback cards this
 * period, in canonical VENDOR_LANES order with the folded remainder as its
 * single last entry — computed by the scope view/container from the card data
 * it already owns (no provide/inject, no registration; r2-3).
 */
export function chargebackLegendLanes(laneIdSets: ReadonlyArray<readonly string[]>): LaneLegendEntry[] {
  const union = new Set<string>()
  for (const set of laneIdSets) for (const lane of set) union.add(lane)
  const hasRemainder = union.delete(FOLDED_LANE_ID)
  const order = new Map<string, number>(VENDOR_LANES.map((l, i) => [l, i]))
  const entries: LaneLegendEntry[] = [...union]
    .sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99))
    .map((lane) => ({ lane, label: laneLabel(lane) }))
  if (hasRemainder) entries.push({ lane: FOLDED_LANE_ID, label: FOLDED_LANE_LABEL })
  return entries
}
