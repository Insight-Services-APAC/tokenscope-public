/*
 * The operand ScopeHero reads — the fields BOTH Region widths publish.
 *
 * WHY A STRUCTURAL TYPE AND NOT ONE SCOPE'S RESPONSE TYPE. The whole-company and
 * single-region widths answer different questions below the fold (region cards vs
 * practices, concentration vs exceptions) and their response types are
 * deliberately discriminated on `width` rather than flattened into a false union.
 * But the HEADLINE and the KPI row are the same four figures over a different
 * clamp, so the hero binds on the intersection: everything here rides both
 * payloads, and nothing here is width-specific.
 *
 * This is what stops the two heroes drifting again. The previous pair diverged
 * badly — the whole-company row got the prototype's fix 2 / 2a / 2b / 2c / 6 and
 * the region row kept a standalone MoM tile, a Tokens tile, an avg-per-user tile
 * and no median at all — because each width had its own component computing its
 * own row. One component that cannot see which width it is on cannot repeat that.
 */
import type { ChargeDailyPoint, DailyMetric, Forecast, UsageBudgetCoverage } from '#shared/reports/types'

/**
 * The §A per-person cohort the KPI row's "Median per person" tile publishes —
 * the median AND the three concentration percentiles, because they are one
 * question (what does a typical person spend, and how lopsided is it) and a
 * separate Concentration band that answered it again disagreed with this one.
 *
 * Server shape: `PerPersonKpi` in server/reporting/engine/per-person.ts, computed
 * from ONE scope-clamped query for both widths.
 */
export interface ScopePerPerson {
  /** Median of the per-teammate window totals, over the WHOLE cohort. */
  medianUsd: number
  /** Cohort shares of the window total, FRACTIONS in [0,1]. */
  top1: number
  top5: number
  top10: number
  /**
   * Active people with at least one OTel-emitted record this window — people
   * EMITTING through TokenScope, against the people who spent. NOT an enrolment
   * count (nothing here reads `instance_attestation`).
   */
  emittingPeople: number
  /** Active people minus the paced previous month's — an ABSOLUTE count. */
  peopleMomDelta: number | null
  /** (median − prevMedian)/prevMedian, a FRACTION, or null. */
  medianMomDeltaPct: number | null
}

/** The §A/§B figures the hero's headline and four tiles are built from. */
export interface ScopeHeroReport {
  meta: {
    month: string
    range?: { from: string; to: string } | null
    /**
     * `ReportMeta.settledThrough` — the last SETTLED UTC day the response's day
     * series were cut on. The hero's sparks need it to say whether their last
     * point is a finished day; absent ⇒ they make no claim (see MonthSpark).
     */
    settledThrough?: string
  }
  kpis: {
    genuineUsd: number
    chargeableUsd: number
    activeUsers: number
    /** §A (genuine − prev)/prev, day-paced. */
    momDeltaPct: number | null
    /** §B (chargeable − prevChargeable)/prevChargeable, month-grained. Never mixed with §A. */
    chargeMomDeltaPct: number | null
  }
  copilot: { pending: boolean; partialMonthUnavailable?: boolean }
  /** Non-null EXACTLY when the viewed month is the in-progress one — the pacing signal. */
  forecast: Forecast | null
  /** §A per-day usage series feeding the tile sparklines, over the KPI window. */
  dailyMetrics?: DailyMetric[]
  /** §B per-day Anthropic chargeback series — the Chargeable tile's sparkline. */
  chargeDaily?: ChargeDailyPoint[]
  /** §A budget coverage of `kpis.genuineUsd`; its `scopeLabel` names the clamp. */
  budgetCoverage: UsageBudgetCoverage
  perPerson?: ScopePerPerson
}
