/*
 * Chart scale helpers for the SVG chart primitives (brief §6.6) — shared
 * by TrendArea / StackedBars / DonutChart so axis math and the series
 * colour palette live in ONE place.
 */
import { denseDays, padOnto } from '#shared/reports/day-axis'
import type { Vendor } from '#shared/usage/vendor'
import type { ModelTierBand } from '#shared/reports/types'

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

/*
 * FIXED colour per MODEL COST TIER — the same rule as the vendor lanes above:
 * colour follows the band id, never its position, so a person with no frontier
 * usage does not repaint everyone else's mix bar.
 *
 * Ordered hottest-to-coolest across the three SEEDED bands (frontier / mid /
 * economy) so the mix bar reads as a cost gradient rather than an arbitrary
 * categorical set. `specialised` and `unclassified` take the neutral kit hue:
 * neither is a point on that gradient, and colouring "we don't know" like a cost
 * band would state a cost we do not have.
 */
export const MODEL_TIER_COLORS: Readonly<Record<ModelTierBand, string>> = {
  frontier: 'var(--brand-hunger)',
  workhorse: 'var(--brand-harmony)',
  lightweight: 'var(--brand-vision)',
  specialised: 'var(--carbon-3)',
  unclassified: 'var(--carbon-3)',
}

export function modelTierColor(band: ModelTierBand): string {
  return MODEL_TIER_COLORS[band]
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
 * Pad a sparse day-keyed series into a dense, ordered run of `windowDays` days
 * ending at `endDay` INCLUSIVE.
 *
 * `endDay` IS REQUIRED, AND THAT IS THE FIX (F1/D4). This function used to
 * anchor the run on the BROWSER's today, which meant it emitted a genuine `0`
 * for the current day — a day the server deliberately refuses to claim anything
 * about ("a FUTURE day is NOT emitted, because nothing has been measured
 * there", `usage-series.ts`). The client was undoing the server's care, and the
 * fabricated zero is what draws as the morning dip. NULL IS NOT 0.
 *
 * Callers pass the SETTLED edge (`clock.settledThrough`) or their own window's
 * `to`. There is no default, because a default would be a second clock.
 *
 * Pure: the shaping lives in `shared/reports/day-axis.ts` so the two chart
 * primitives cannot drift apart on what days an axis holds.
 */
export function padDays<T>(
  rows: ReadonlyArray<T & { day: string }>,
  windowDays: number,
  endDay: string,
  zero: (day: string) => T & { day: string },
): Array<T & { day: string }> {
  return padOnto(rows, denseDays(endDay, windowDays), zero)
}

export function useChartScale() {
  return { CHART_PALETTE, seriesColor, niceMax, padDays, VENDOR_LANE_COLORS, vendorLaneColor }
}
