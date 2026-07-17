/*
 * build-regional-trend — turn the raw Regional trend payload into ChartTrend
 * series, plus a run-rate DASHED continuation for the in-progress month.
 *
 * The `/reports/regional/trend` endpoint returns ACTUAL day-grain points only
 * (one per (day, lane) with positive cost), keyed by the §A TOOL id — the three
 * named §A usage lanes + the live 'other' catch-all (the V2-Regional wire
 * widening; the pre-widening display names 'Claude'/'Copilot'/'Other' are gone).
 * colorForKey resolves the keys through the lane registry, so Claude Code
 * paints brand-hunger MAGENTA and Copilot brand-vision blue.
 *
 * To honour the dashboard's "forecast dashed continuation" the pure builder
 * appends a projected tail for the days after `asOf` through month-end, each at
 * the provider's average daily run-rate (MTD spend ÷ days elapsed).
 * `forecastFrom` marks the first projected day so ChartTrend renders that segment
 * dashed + muted under the "projected" band — a RUN-RATE estimate, clearly
 * provisional, never a settled figure.
 *
 * Kept pure (no Vue, no DOM) so the projection maths is unit-testable and the
 * component stays declarative — mirrors the sibling across/build-trend.ts.
 */
import type { Forecast } from '#shared/reports/types'
import { SECTION_A_USAGE_TOOLS } from '#shared/usage/vendor'
import { CLAUDE_CODE_TOOL } from '#shared/usage/surface'
import { COPILOT_CLI_TOOL, COPILOT_AGENT_TOOL } from '#shared/usage/github-surface'
import { foldLaneSeries } from '../charts/fold-lanes'

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

/** The §A trend keys the Regional endpoint emits (mirrors AcrossTrendPoint['key']). */
export type RegionalTrendKey = 'claude-code' | 'copilot-cli' | 'copilot-agent' | 'other'

/** One raw row from the Regional trend endpoint (`{ day, key, value }`). */
export interface RegionalTrendRow {
  day: string
  /** §A tool id (registry lane key) — the V2-Regional widened wire key. */
  key: RegionalTrendKey
  value: number
}

export interface BuiltRegionalTrend {
  series: TrendSeries[]
  /** First projected day (`YYYY-MM-DD`); undefined when there is no in-progress projection. */
  forecastFrom?: string
  /** Per-day ACTUAL region total (ordered by day) — feeds the Genuine KPI sparkline. */
  dailyTotals: number[]
}

/*
 * Display names per §A trend key. Keyed by the FULL RegionalTrendKey union — a
 * compile-time exhaustiveness pin (r1-F9): widening the wire union without a
 * label here is a type error, not a silent legend gap. 'GitHub Copilot' (not
 * the registry's bare 'Copilot') matches the sibling Across labelling.
 */
const LANE_NAMES: Record<RegionalTrendKey, string> = {
  [CLAUDE_CODE_TOOL]: 'Claude Code',
  [COPILOT_CLI_TOOL]: 'GitHub Copilot',
  [COPILOT_AGENT_TOOL]: 'Copilot Coding Agent',
  other: 'Other',
}

/*
 * The §A lane set, registry-driven (lane-visuals V1 item 3): the three named §A
 * usage tools + the live 'other' catch-all, in canonical order. The `satisfies`
 * pins the derived set to the wire union — the two can never drift.
 */
const SECTION_A_KEYS = [...SECTION_A_USAGE_TOOLS, 'other'] as const satisfies readonly RegionalTrendKey[]

const VENDOR_META: Array<{ key: RegionalTrendKey; name: string }> = SECTION_A_KEYS.map((key) => ({
  key,
  name: LANE_NAMES[key],
}))

/*
 * The requested §A pair is ALWAYS surfaced; the optional lanes (copilot-agent —
 * structurally absent from v_complete_usage today — and the 'other' catch-all)
 * only when they carry spend: a permanently flat zero line would be noise.
 */
const ALWAYS_SHOWN = new Set<RegionalTrendKey>([CLAUDE_CODE_TOOL, COPILOT_CLI_TOOL])

/** Zero-padded `${month}-${dd}` for a day-of-month (month is a `YYYY-MM` key). */
function dayKey(month: string, dom: number): string {
  return `${month}-${String(dom).padStart(2, '0')}`
}

/**
 * Build ChartTrend series (+ optional projected tail) from the raw trend points.
 *
 * @param points   raw `(day, key, value)` rows from the regional trend endpoint
 * @param forecast the in-progress-month forecast, or null (closed month / custom range)
 * @param month    the window's `YYYY-MM` key (used to synth the projected day labels);
 *                 null in custom-range mode ⇒ no projection regardless of forecast
 */
export function buildRegionalTrend(
  points: RegionalTrendRow[],
  forecast: Forecast | null,
  month: string | null,
): BuiltRegionalTrend {
  // Per-vendor day→value maps + the sorted set of ACTUAL days (keyed by lane key).
  const byVendor = new Map<string, Map<string, number>>()
  const days = new Set<string>()
  for (const m of VENDOR_META) byVendor.set(m.key, new Map())
  for (const p of points) {
    const vm = byVendor.get(p.key)
    if (!vm) continue
    vm.set(p.day, (vm.get(p.day) ?? 0) + p.value)
    days.add(p.day)
  }
  const actualDays = [...days].sort()

  const dailyTotals = actualDays.map((d) =>
    VENDOR_META.reduce((a, m) => a + (byVendor.get(m.key)?.get(d) ?? 0), 0),
  )

  const vendorTotal = (key: string): number => {
    let t = 0
    for (const v of byVendor.get(key)?.values() ?? []) t += v
    return t
  }
  const activeVendors = VENDOR_META.filter((m) => ALWAYS_SHOWN.has(m.key) || vendorTotal(m.key) > 0)

  // Projected tail — in-progress month only (guarded so a closed month / range /
  // a month with no elapsed days simply yields no tail).
  let forecastFrom: string | undefined
  const projectedDays: string[] = []
  if (forecast && month && forecast.asOfDate && forecast.daysElapsed > 0) {
    const asOfDom = Number(forecast.asOfDate.slice(8, 10))
    if (Number.isFinite(asOfDom) && asOfDom < forecast.daysInMonth) {
      for (let d = asOfDom + 1; d <= forecast.daysInMonth; d++) projectedDays.push(dayKey(month, d))
      forecastFrom = projectedDays[0]
    }
  }

  const built: TrendSeries[] = activeVendors.map((m) => {
    const vm = byVendor.get(m.key) ?? new Map<string, number>()
    const data: TrendPoint[] = actualDays.map((x) => ({ x, y: vm.get(x) ?? 0 }))
    if (forecastFrom && forecast && forecast.daysElapsed > 0 && month) {
      // Run-rate = THIS-MONTH MTD spend for this vendor ÷ days elapsed. Must NOT
      // divide the whole (rolling, up-to-60-day) window total by the current
      // month's elapsed days — that inflates the projected daily rate ~20×.
      let mtd = 0
      for (const [d, val] of vm) if (d.startsWith(`${month}-`)) mtd += val
      const avgDaily = mtd / forecast.daysElapsed
      for (const x of projectedDays) data.push({ x, y: avgDaily })
    }
    return { name: m.name, key: m.key, data }
  })

  // Kit-level fold (lane-visuals V1 item 2) — applied uniformly by every trend
  // builder. The §A ceiling is 4 lanes (≤ the max of 6), so this is an identity
  // today; it guards the invariant if the lane set ever grows.
  const folded = foldLaneSeries(built.map((s) => ({ lane: s.key, label: s.name, data: s.data })))
  const series: TrendSeries[] = folded.series.map((s) => ({ name: s.label, key: s.lane, data: s.data }))

  return { series, forecastFrom, dailyTotals }
}
