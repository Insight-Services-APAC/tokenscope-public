/*
 * build-surface-hero — the pure builder behind the usage-view composition hero
 * "Where the AI spend goes" (Across + Regional usage views).
 *
 * The `donut` output NO LONGER FEEDS A CARD. "Spend by surface" was deleted: it
 * restated this hero's own legend as three unlabelled arcs around a total, so a
 * reader could not tell which arc was which surface without looking at the card
 * it duplicated. The field is retained because its test is a real conservation
 * check — `donut.totalUsd` must equal `hero.totalUsd` over the same cells and
 * window — which is worth keeping whether or not anything renders it.
 *
 * AXIS RULE: everything here is canonical §A USAGE basis (requirement 1) — the
 * input cells come from `v_complete_usage` ONLY (weekly, every surface —
 * including `copilot`/`copilot-agent` — native, no firewall). No §B chargeback
 * figure ever enters a series, sum, stack, or delta here; the §B chargeback
 * figures live in the chargeback-mode cards (one card one basis, r1-F6). This
 * REPLACES the former billed-showback basis (`v_finance_bill_showback`) that
 * fed this SAME usage-mode hero — the exact "Surface Hero uses billed
 * showback" mixed-lens defect this file now closes: Σ(this hero's cells) sums
 * back to the canonical §A usage headline for the SAME window (test-pinned).
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
import type { UsageSurfaceWeeklyCell } from '#shared/reports/types'
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
  /**
   * SAME cells, SAME window, SAME fold membership as the bars above — which is
   * now its only job. No component reads this; it is the conservation check
   * (see the file header), not a card.
   */
  donut: BuiltSurfaceHeroDonut
}

/**
 * Build the composition hero from the endpoint's weekly showback lane cells
 * over the trend's shared window (`from`/`to` inclusive; `today` = UTC today,
 * identifying the partial current week).
 */
export function buildSurfaceHero(
  cells: readonly UsageSurfaceWeeklyCell[],
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

/*
 * `heroLegendLanes` USED TO LIVE HERE — it fed the page-level LaneLegend in the
 * usage lens. That legend is gone: SurfaceHeroCard now renders its own totals
 * bar from `donut.slices`, which names the same lanes AND carries each one's
 * dollars, under the bars it describes rather than at the top of the page. The
 * helper had no remaining caller, and an exported function whose only consumer
 * is its own test certifies nothing while implying the page still has a legend
 * it does not.
 */

/** True when the hero has anything to show (some non-zero week in some lane). */
export function heroHasData(built: BuiltSurfaceHero | null): boolean {
  return Boolean(built && built.series.some((s) => s.data.some((p) => p.y !== 0)))
}
