/*
 * The wire shapes the Regional reporting endpoints return, shared by the
 * ScopeRegional container (to type its useFetch generics) and the
 * ScopeRegionalView (its props). Pure types — no runtime.
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
  ReportMeta,
  SpendClass,
  ChargebackProviderSplit,
  ChargeDailyPoint,
  ChargeLanePoint,
  ChargebackLaneRow,
  RegionWidth,
  UsageSurfaceWeeklyCell,
  UsageBudgetCoverage,
} from '#shared/reports/types'

export interface RegionalReport {
  meta: ReportMeta
  /**
   * The WIDTH this payload was computed at — always `'region'` here, the clamped
   * one. The whole-company width answers under `AcrossReport`.
   */
  width: 'region'
  region: { id: string; code: string; displayName: string } | null
  regionOptions: RegionOption[]
  /**
   * Whether "All regions" is one of the caller's selector options (§6: the options
   * ARE the grant). Rides on BOTH widths so the control is built the same way from
   * either, and a reader on one region can always get back to the whole company if
   * they hold it.
   */
  allRegionsAvailable: boolean
  drill: { ouId: string; code: string; displayName: string } | null
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
   * §A per-person cohort over the SAME window as `kpis` — median, percentiles and
   * the emitting split. Region-clamped by the SAME engine read the whole-company
   * width uses. Optional so a client bundle predating the field still type-checks;
   * the KPI row hides the median tile when it is absent rather than rendering a
   * zero it did not measure.
   */
  perPerson?: ScopePerPerson
  /**
   * §B per-lane chargeback totals over the window (lane-visuals V2-Regional) — the
   * ChargebackSplitCard donut. Anthropic lanes day-grained; the three Copilot §B
   * lanes ride along only in validated chargeback mode over a month-aligned window
   * (the KPI's gate). Σ(lanes minus copilot-unclassified) == kpis.chargeableUsd.
   */
  chargebackLanes: ChargebackLaneRow[]
  practices: {
    key: string
    label: string
    value: number
    spendClass: SpendClass
    /** True when this bucket is the region's `default` BU (unplaced teammates). */
    isDefault: boolean
  }[]
  /**
   * §B chargeback ranked by cost-owning unit (`v_finance_chargeback_month`) — the
   * chargeback-lane swap for the practice ranking. `key` = cou id (or 'unallocated'
   * for the NULL bucket). Empty in a drill. Sums back to the region chargeable.
   */
  chargebackByCostCentre: { key: string; label: string; value: number }[]
  vendorSplit: { claudeUsd: number; copilotUsd: number; otherUsd: number } | null
  exceptions: {
    teammateId: string
    name: string
    currentWeekUsd: number
    baselineMeanUsd: number
    deltaPct: number
    /*
     * THE DRILL FACTS (D34), carried by `fetchRegionalExceptions`. Declared here
     * because they were on the wire and NOT in this type, which is how
     * `RegionalSignals.vue` came to read `isActive` off an untyped field and to
     * not read `isProvisional` at all (r5-H1).
     */
    isActive: boolean
    isProvisional: boolean
  }[]
  velocityThreshold: number
}

export interface RegionalDriversResp {
  axis: string
  /** The lens this cut was computed for, echoed back (`usage` | `chargeback`). */
  lane?: SpendLens
  /**
   * The WIDTH this cut was computed at, set from the resolved scope by
   * `/reports/region/drivers` (it always has; this declares it).
   *
   * IT IS NOT REDUNDANT WITH `region`, and the case that proves it is the one a
   * region-only guard renders wrong: on a region → "All regions" transition BOTH
   * the heading and a legitimate whole-company payload carry `null`, so the two
   * compare EQUAL and a company-wide ranking draws under a vanishing region's
   * name. `width` is the only field that distinguishes "no region resolved" from
   * "this answer is for no single region, by design".
   */
  width: RegionWidth
  /**
   * The region this cut was COMPUTED for — `resolveRegionalScope`'s effective region,
   * reflected back by `/reports/regional/drivers` the same way `axis` is. Carried for
   * the same reason: a `useFetch` ref holds the PREVIOUS response while the next one
   * is in flight, so the client needs the payload itself to say which region it
   * belongs to. `null` only when the effective region row did not resolve.
   */
  region: { id: string; code: string; displayName: string } | null
  headlineUsd: number
  rows: DriverRow[]
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

export interface RegionalTrendResp {
  /**
   * The WIDTH this trend was computed at — see {@link RegionalDriversResp.width}
   * for why the region alone cannot carry this, and
   * `app/components/reporting/regional/teammate-cut.ts` for the guard that reads it.
   */
  width: RegionWidth
  /**
   * The region this trend was COMPUTED for — `resolveRegionalScope`'s effective
   * region, reflected back by `/reports/regional/trend` (it always has; this
   * declares it). Carried for the same reason `RegionalDriversResp.region` is: the
   * trend resolves its scope in its own request, so after a region switch its
   * `useFetch` ref still holds the PREVIOUS region's series, and only the payload
   * itself can say which region that is. `null` only when the effective region row
   * did not resolve.
   */
  region: { id: string; code: string; displayName: string } | null
  /**
   * Inclusive window bounds (`YYYY-MM-DD`) — the ONE shared window object the
   * usage-view composition hero + its pinned donut both bind on (iter-2 I1).
   */
  window: { from: string; to: string }
  windowDays: number
  /**
   * §A day-grain points. `key` is the tool id — the three named §A usage lanes +
   * the `other` catch-all (the three-lane §A ceiling; the V2-Regional wire
   * widening — the pre-widening display names 'Claude'/'Copilot'/'Other' are gone).
   */
  series: { day: string; key: 'claude-code' | 'copilot-cli' | 'copilot-agent' | 'other'; value: number }[]
  /**
   * §B per-day Anthropic chargeback series (bill lane) — the chargeback-mode spend-trend
   * series, carried alongside the §A `series` (never summed). Copilot pooled/monthly, absent.
   */
  chargeSeries: ChargeDailyPoint[]
  /**
   * The per-LANE widening of `chargeSeries` (lane-visuals V2-Regional): the same §B
   * window GROUP BY tool, mapped to registry lane ids. Σ lanes per day == that day's
   * `chargeUsd` (cent-exact, test-pinned); `chargeSeries` remains the zero-filled
   * total the run-rate tail and sparklines bind on.
   */
  chargeLanes: ChargeLanePoint[]
  /**
   * The §A per-surface weekly usage cells over the SAME window (requirement 1,
   * the regional mirror — region-clamped): the usage-view "Where the AI spend
   * goes" hero's series (and, summed per lane, its pinned donut). Canonical §A
   * basis (`v_complete_usage`); never summed with any §B chargeback figure.
   */
  usageWeeklyLanes: UsageSurfaceWeeklyCell[]
}
