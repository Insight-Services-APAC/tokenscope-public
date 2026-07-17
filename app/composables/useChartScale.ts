/*
 * Chart scale helpers for the SVG chart primitives (brief §6.6) — shared
 * by TrendArea / StackedBars / DonutChart so axis math and the series
 * colour palette live in ONE place.
 */
import type { Vendor } from '#shared/usage/vendor'

/*
 * FIXED colour per billing vendor lane (#142) — colour follows the lane id,
 * never its position, so a practice missing a lane doesn't repaint the others.
 * Tokens defined + derivation documented in assets/css/brand-tokens.css.
 */
export const VENDOR_LANE_COLORS: Readonly<Record<Vendor, string>> = {
  'claude': 'var(--lane-claude)',
  'claude-ai': 'var(--lane-claude-ai)',
  'claude-cowork': 'var(--lane-claude-cowork)',
  'claude-office': 'var(--lane-claude-office)',
  'claude-chrome': 'var(--lane-claude-chrome)',
  'claude-design': 'var(--lane-claude-design)',
  'claude-slack': 'var(--lane-claude-slack)',
  'claude-other': 'var(--lane-claude-other)',
  'copilot': 'var(--lane-copilot)',
  'copilot-agent': 'var(--lane-copilot-agent)',
  'copilot-license': 'var(--lane-copilot-license)',
  'copilot-usage': 'var(--lane-copilot-usage)',
  'copilot-unclassified': 'var(--lane-copilot-unclassified)',
  'other': 'var(--lane-other)',
}

export function vendorLaneColor(lane: Vendor): string {
  return VENDOR_LANE_COLORS[lane]
}

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
  return { CHART_PALETTE, seriesColor, niceMax, padDays, VENDOR_LANE_COLORS, vendorLaneColor }
}
