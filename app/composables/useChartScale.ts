/*
 * Chart scale helpers for the SVG chart primitives (brief §6.6) — shared
 * by TrendArea / StackedBars / DonutChart so axis math and the series
 * colour palette live in ONE place.
 */

/** Brand palette order for categorical series (CSS custom properties). */
export const CHART_PALETTE = [
  'var(--brand-harmony)',
  'var(--brand-vision)',
  'var(--brand-zeal)',
  'var(--brand-hunger)',
  'var(--brand-heart)',
  'var(--carbon-3)',
] as const

export function seriesColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length]!
}

/** A "nice" axis maximum: 1/2/5 × 10ⁿ at or above the data max. */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1
  const pow = 10 ** Math.floor(Math.log10(max))
  for (const m of [1, 2, 5, 10]) {
    if (max <= m * pow) return m * pow
  }
  return 10 * pow
}

/**
 * Pad a sparse day-keyed series (gap days absent in the aggregate) into a
 * dense, ordered run covering the trailing `windowDays` ending today (UTC).
 */
export function padDays<T>(
  rows: ReadonlyArray<T & { day: string }>,
  windowDays: number,
  zero: (day: string) => T & { day: string },
): Array<T & { day: string }> {
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const out: Array<T & { day: string }> = []
  const today = new Date()
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  for (let i = windowDays - 1; i >= 0; i--) {
    const day = new Date(start - i * 86_400_000).toISOString().slice(0, 10)
    out.push(byDay.get(day) ?? zero(day))
  }
  return out
}

export function useChartScale() {
  return { CHART_PALETTE, seriesColor, niceMax, padDays }
}
