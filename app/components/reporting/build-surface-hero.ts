/*
 * build-surface-hero — the pure builder behind the usage-view composition hero
 * "Where the AI spend goes" and its PINNED "Spend by surface · billed" donut
 * (lane-visuals iter-2 I1; Across + Regional usage views).
 *
 * AXIS RULE (the firewall): everything here is BILLED showback basis — the
 * input cells come from `v_finance_bill_showback` ONLY (weekly, GitHub §A tools
 * already firewalled out server-side). No §A usage figure ever enters a series,
 * sum, stack, or delta here; the §A attributed figures live in the KPI strip
 * (one card one basis, r1-F6).
 *
 *   - the weekly stack (+ its 100%-share twin, partial-week rules, disclosure,
 *     unfolded delta) is the kit-level buildWeeklyLanes (charts/weekly-lanes.ts);
 *   - the DONUT is derived from the SAME fold membership and the SAME cells over
 *     the SAME window (one shared window object, r2-2), so donut Σ == hero Σ
 *     cent-exact by construction (and test-pinned);
 *   - the remainder wears the hero's DISCLOSURE label ("Other surfaces
 *     (composition varies)", r2-1) — its per-week composition is itemised.
 *
 * Kept pure (no Vue, no DOM) so the maths is unit-testable — mirrors the
 * sibling build-chargeback-trend.ts.
 */
import type { ShowbackWeeklyLaneCell } from '#shared/reports/types'
import { buildWeeklyLanes, type BuiltWeeklyLanes } from './charts/weekly-lanes'

/** The hero remainder's disclosure label (r2-1): composition varies week-to-week,
 *  so the label says so and the tooltip itemises each week's exact contents. */
export const HERO_REMAINDER_LABEL = 'Other surfaces (composition varies)'

export interface BuiltSurfaceHeroDonut {
  /** ≤ MAX_CHART_LANES slices — the hero's kept lanes (whole-window totals) +
   *  the remainder; exact-zero slices elided. */
  slices: Array<{ lane: string; label: string; value: number }>
  /** Σ slices == the hero's window total (cent-exact by construction). */
  totalUsd: number
  /** The lane ids actually rendered — legend source. */
  laneIds: string[]
}

export interface BuiltSurfaceHero extends BuiltWeeklyLanes {
  /** The pinned composition donut — SAME cells, SAME window, SAME fold membership. */
  donut: BuiltSurfaceHeroDonut
}

/**
 * Build the composition hero from the endpoint's weekly showback lane cells
 * over the trend's shared window (`from`/`to` inclusive; `today` = UTC today,
 * identifying the partial current week).
 */
export function buildSurfaceHero(
  cells: readonly ShowbackWeeklyLaneCell[],
  opts: { from: string; to: string; today: string },
): BuiltSurfaceHero {
  const built = buildWeeklyLanes(cells, { ...opts, remainderLabel: HERO_REMAINDER_LABEL })

  // Donut = the SAME folded series summed per lane over the SAME window (incl.
  // the partial week — it is rendered in the bars, so it is in the donut too;
  // Σ slices == built.totalUsd cent-exact because both sum the same points).
  const slices = built.series
    .map((s) => ({
      lane: s.key,
      label: s.name,
      value: s.data.reduce((a, p) => a + p.y, 0),
    }))
    .filter((s) => s.value !== 0)
  return {
    ...built,
    donut: {
      slices,
      totalUsd: slices.reduce((a, s) => a + s.value, 0),
      laneIds: slices.map((s) => s.lane),
    },
  }
}

/** The hero/donut legend entries (page LaneLegend input) — the union is just the
 *  hero's rendered series (the donut's lanes are a subset by construction). */
export function heroLegendLanes(
  built: BuiltSurfaceHero | null,
): Array<{ lane: string; label: string }> {
  if (!built) return []
  return built.series.map((s) => ({ lane: s.key, label: s.name }))
}

/** True when the hero has anything to show (some non-zero week in some lane). */
export function heroHasData(built: BuiltSurfaceHero | null): boolean {
  return Boolean(built && built.series.some((s) => s.data.some((p) => p.y !== 0)))
}
