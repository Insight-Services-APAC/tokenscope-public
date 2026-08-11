/*
 * The wire shapes `/reports/region*` returns at its WHOLE-COMPANY width, shared by
 * the ScopeAcrossRegions container (to type its useFetch generics) and the
 * ScopeAcrossRegionsView (its props). Pure types — no runtime.
 */
import type { SpendLens } from '#shared/usage/lens'
import type { RegionOption } from '../ui/RegionSelector.vue'
import type { ScopePerPerson } from './scope-hero-types'
import type {
  BilledLaneMeta,
  ChargebackCoverage,
  MeasureLanes,
  DailyMetric,
  DriverRow,
  Forecast,
  ProviderSplit,
  ChargebackProviderSplit,
  ChargeDailyPoint,
  ChargebackLaneRow,
  ReportMeta,
  UsageBudgetCoverage,
} from '#shared/reports/types'

export interface AcrossRegionCard {
  /** `null` for the explicit "Unassigned" bucket. */
  regionId: string | null
  code: string | null
  displayName: string
  genuineUsd: number
  anthropicChargeableUsd: number
  copilotChargeableUsd: number
  chargeableUsd: number
  activeUsers: number
  avgPerUserUsd: number
  /** Fraction in [0,1] of company genuine. */
  sharePct: number
}

/**
 * One §B chargeback-by-region ranking row (`v_finance_chargeback_month`) — the
 * chargeback-lane swap for the usage region cards. `regionId` = null → the explicit
 * "Unassigned" bucket. The rows sum back to `kpis.chargeableUsd`.
 */
export interface AcrossChargebackRegion {
  regionId: string | null
  label: string
  chargeableUsd: number
}

/**
 * The §A per-person cohort the KPI row's "Median per person" tile publishes.
 *
 * BOTH widths publish it now, so the shape lives in scope-hero-types.ts beside the
 * hero that reads it; this name is kept because the route and this scope's
 * consumers already spell it that way.
 */
export type AcrossPerPerson = ScopePerPerson

export interface AcrossReport {
  meta: ReportMeta
  /**
   * The WIDTH this payload was computed at — always `'all-regions'` here, because
   * that is the only width this container requests. Carried so a reader never has to
   * infer it from the absence of a region.
   */
  width: 'all-regions'
  /** No effective region: this width answers for no single one. */
  region: null
  /** The regions this caller may narrow to — the selector's options (§6). */
  regionOptions: RegionOption[]
  /** Whether "All regions" is one of the caller's options at all. */
  allRegionsAvailable: boolean
  kpis: {
    genuineUsd: number
    chargeableUsd: number
    anthropicChargeableUsd: number
    tokens: number
    activeUsers: number
    /** (genuine − prev)/prev fraction, or null (no prior month). Usage lane (§A). */
    momDeltaPct: number | null
    /** (chargeable − prevChargeable)/prevChargeable fraction, or null. Bill lane (§B). */
    chargeMomDeltaPct: number | null
    avgPerUserUsd: number
    /** §B — distinct teammates on the Anthropic chargeback bill (per-teammate bill lane). */
    billedTeammates: number
    /** §B — Σ Anthropic bill tokens (bill lane). */
    billedTokens: number
    /** §B — Anthropic charge ÷ billed teammates (Anthropic-only; Copilot is pooled). */
    avgChargePerBilledUser: number
  }
  copilot: {
    mode: 'pool-utilisation' | 'chargeback'
    pending: boolean
    chargeableUsd: number | null
    /**
     * copilot chargeback ON but the window is not month-aligned → the pooled (monthly) net
     * is withheld for this partial-month range (not folded, not $0-faked). The hero caveats it.
     */
    partialMonthUnavailable?: boolean
  }
  forecast: Forecast | null
  actualUsd: number
  /** Whole-company per-provider usage split (spend + active users). Sums back to genuine. */
  providerSplit: ProviderSplit
  /**
   * §B chargeback provider split (bill lane) — Anthropic per-teammate vs Copilot pooled
   * (null while pending). The chargeback-mode swap for `providerSplit`; sums to chargeable.
   */
  chargebackProviderSplit: ChargebackProviderSplit
  /** §A per-day usage series feeding the KPI-tile sparklines (usage / tokens / users). */
  dailyMetrics: DailyMetric[]
  /**
   * §A budget coverage of `kpis.genuineUsd` over the SAME scope and window — how
   * much of that headline is on a budgeted project and how much is outside the
   * budget lens. Σ its four parts IS `kpis.genuineUsd`. Pure §A: it qualifies the
   * attributed-usage total and NEVER the chargeable one (contract C2).
   */
  budgetCoverage: UsageBudgetCoverage
  /** §B per-day Anthropic chargeback series (bill lane) — the Chargeable KPI-tile sparkline. */
  chargeDaily: ChargeDailyPoint[]
  /**
   * §B per-lane chargeback totals over the window (lane-visuals V2) — the
   * ChargebackSplitCard donut. Anthropic lanes day-grained; the three Copilot §B
   * lanes ride along only in validated chargeback mode over a month-aligned window
   * (the KPI's gate). Σ(lanes minus copilot-unclassified) == kpis.chargeableUsd.
   */
  chargebackLanes: ChargebackLaneRow[]
  /**
   * §A per-person cohort over the SAME window as `kpis` — median, percentiles and
   * the emitting split. Optional so a client bundle predating the field still
   * type-checks; the KPI row hides the median tile when it is absent rather than
   * rendering a zero it did not measure.
   */
  perPerson?: AcrossPerPerson
  regionCards: AcrossRegionCard[]
  /**
   * §B chargeback ranked by region (`v_finance_chargeback_month`) — the chargeback-lane
   * swap for `regionCards`. `regionId` = null → "Unassigned". Sums to `kpis.chargeableUsd`.
   */
  chargebackByRegion: AcrossChargebackRegion[]
}

export type ConcentrationSegmentKey = 'power' | 'heavy' | 'typical' | 'light'

export interface ConcentrationSegmentStat {
  key: ConcentrationSegmentKey
  label: string
  count: number
  totalUsd: number
  /** Fraction in [0,1] of company total. */
  sharePct: number
  avgUsd: number
  medianUsd: number
}

/**
 * One band of the decile partition the Concentration card renders. Mirrors
 * `ConcentrationCohortStat` in server/reporting/across-regions.ts.
 */
export interface ConcentrationCohortStat {
  /**
   * The stable machine name. Selectors and test ids bind to THIS, never to
   * `label` — the label is copy, it has already been re-worded once, and
   * "Top 1%" carries a space and a '%' that make an awkward selector besides.
   */
  key: 'top1' | 'next9' | 'next40' | 'bottom50'
  /** "Top 1%" / "Next 9%" / "Next 40%" / "Bottom 50%" — display copy only. */
  label: string
  count: number
  totalUsd: number
  /** Fraction in [0,1] of the cohort total. */
  sharePct: number
}

export interface ConcentrationStats {
  activeUsers: number
  totalUsd: number
  /** All three are fractions in [0,1]. */
  top1: number
  top5: number
  top10: number
  segments: ConcentrationSegmentStat[]
  /**
   * The decile partition (Top 1% / Next 9% / Next 40% / Bottom 50%). Cut at the
   * same indices as `top1`/`top10`, so cohort[0] IS the top-1% share and the
   * first two cohorts sum to the top-10% share exactly — the card and the
   * Median-per-person KPI publish ONE distribution.
   *
   * Optional so a client bundle predating the field still type-checks; the card
   * renders nothing rather than a partition it did not receive.
   */
  cohorts?: ConcentrationCohortStat[]
}

export interface AcrossDriversResp {
  axis: string
  /** The lens this cut was computed for, echoed back (`usage` | `chargeback`). */
  lane?: SpendLens
  headlineUsd: number
  rows: DriverRow[]
  /** ALWAYS attributed — a §A cohort statistic, in both lanes. See `measureLanes`. */
  concentration: ConcentrationStats
  /**
   * WHICH LANE each money measure above was computed on — the response's own
   * statement, never inferred from `?lane=`. `rows`/`headlineUsd` follow the
   * selected lane EXCEPT on the budget axis, which is `attributed` in both
   * lanes because `provider_usage_fact` has no project column. Read this before
   * comparing or combining any two figures here: the lanes measure different
   * populations and do not reconcile (target-state-data-architecture.md §2).
   *
   * Optional so a cached client bundle predating the field still type-checks;
   * every current route populates it.
   */
  measureLanes?: MeasureLanes
  /** Present only when `rows` is the billed lane — see {@link BilledLaneMeta}. */
  billedLane?: BilledLaneMeta
  /**
   * Present only under `?lane=chargeback`: WHOSE charge these rows are, and which
   * provider's charge this axis structurally cannot carry
   * ({@link ChargebackCoverage}).
   *
   * Read it before labelling ANY figure here "billed spend". Copilot's charge is
   * one pooled invoice per cost centre, so on the teammate and model axes the
   * headline is Anthropic's alone — and a label that does not say so is the
   * defect this field exists to make unspellable. Never hard-code WHICH axes:
   * `providers` and `gaps` are the answer, and the set has already moved once
   * (the surface axis carries the Copilot charge, by the bill's own lane).
   */
  chargebackCoverage?: ChargebackCoverage
  /**
   * Present only on the budget axis: the part of `headlineUsd` carrying no
   * budget claim. ATTRIBUTED money — see `measureLanes`.
   */
  unallocatedUsd?: number
}
