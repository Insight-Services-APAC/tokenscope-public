/*
 * build-trend — turn the raw Across trend payload into ChartTrend series, plus a
 * run-rate DASHED continuation for the in-progress month.
 *
 * The `/across-regions/trend` endpoint returns ACTUAL day-grain points only (one
 * per (day, vendor) with positive cost). To honour the dashboard's "forecast
 * dashed continuation" the pure builder appends a projected tail for the days
 * after `asOf` through month-end, each at the provider's average daily run-rate
 * (MTD spend ÷ days elapsed). `forecastFrom` marks the first projected day so
 * ChartTrend renders that segment dashed + muted under the "projected" band. The
 * projection is explicitly a RUN-RATE estimate — clearly styled as provisional,
 * never a settled figure.
 *
 * Kept pure (no Vue, no DOM) so the projection maths is unit-testable and the
 * component stays declarative.
 */
import type { AcrossTrendPoint, Forecast } from '#shared/reports/types'

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

export interface BuiltTrend {
  series: TrendSeries[]
  /** First projected day (`YYYY-MM-DD`); undefined when there is no in-progress projection. */
  forecastFrom?: string
  /** Per-day ACTUAL company total (ordered by day) — feeds the KPI sparkline. */
  dailyTotals: number[]
}

const VENDOR_META: Array<{ key: AcrossTrendPoint['key']; name: string }> = [
  { key: 'claude-code', name: 'Claude Code' },
  { key: 'copilot-cli', name: 'GitHub Copilot' },
  { key: 'other', name: 'Other' },
]

/** Zero-padded `${month}-${dd}` for a day-of-month (month is a `YYYY-MM` key). */
function dayKey(month: string, dom: number): string {
  return `${month}-${String(dom).padStart(2, '0')}`
}

/**
 * Build ChartTrend series (+ optional projected tail) from the raw trend points.
 *
 * @param points   raw `(day, vendor, value)` rows from the trend endpoint
 * @param forecast the in-progress-month forecast, or null (closed month / custom range)
 * @param month    the window's `YYYY-MM` key (used to synth the projected day labels);
 *                 null in custom-range mode ⇒ no projection regardless of forecast
 */
export function buildAcrossTrend(
  points: AcrossTrendPoint[],
  forecast: Forecast | null,
  month: string | null,
): BuiltTrend {
  // Per-vendor day→value maps + the sorted set of ACTUAL days.
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

  // Only surface a vendor series when it carries any spend in the window — a flat
  // zero "Other" line would be noise. Claude + Copilot are the requested pair.
  const vendorTotal = (key: string): number => {
    let t = 0
    for (const v of byVendor.get(key)?.values() ?? []) t += v
    return t
  }
  const activeVendors = VENDOR_META.filter((m) => m.key !== 'other' || vendorTotal('other') > 0)

  // Projected tail — in-progress month only. daysElapsed drives the run-rate; the
  // tail spans (asOf + 1 … daysInMonth). Guarded so a closed month / range / a
  // month with no elapsed days simply yields no tail.
  let forecastFrom: string | undefined
  const projectedDays: string[] = []
  if (forecast && month && forecast.asOfDate && forecast.daysElapsed > 0) {
    const asOfDom = Number(forecast.asOfDate.slice(8, 10))
    if (Number.isFinite(asOfDom) && asOfDom < forecast.daysInMonth) {
      for (let d = asOfDom + 1; d <= forecast.daysInMonth; d++) projectedDays.push(dayKey(month, d))
      forecastFrom = projectedDays[0]
    }
  }

  const series: TrendSeries[] = activeVendors.map((m) => {
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

  return { series, forecastFrom, dailyTotals }
}
