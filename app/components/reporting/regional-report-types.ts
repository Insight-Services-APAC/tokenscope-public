/*
 * The wire shapes the Regional reporting endpoints return, shared by the
 * ScopeRegional container (to type its useFetch generics) and the
 * ScopeRegionalView (its props). Pure types — no runtime.
 */
import type { RegionOption } from '../ui/RegionSelector.vue'
import type {
  DailyMetric,
  DriverRow,
  Forecast,
  ReportMeta,
  SpendClass,
  ChargebackProviderSplit,
  ChargeDailyPoint,
  ChargeLanePoint,
  ChargebackLaneRow,
  ShowbackWeeklyLaneCell,
} from '#shared/reports/types'

export interface RegionalReport {
  meta: ReportMeta
  region: { id: string; code: string; displayName: string } | null
  regionOptions: RegionOption[]
  drill: { ouId: string; code: string; displayName: string } | null
  kpis: {
    genuineUsd: number
    chargeableUsd: number
    anthropicChargeableUsd: number
    tokens: number
    activeUsers: number
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
  /** §B per-day Anthropic chargeback series (bill lane) — the Chargeable KPI-tile sparkline. */
  chargeDaily: ChargeDailyPoint[]
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
  }[]
  velocityThreshold: number
}

export interface RegionalDriversResp {
  axis: string
  headlineUsd: number
  rows: DriverRow[]
}

export interface RegionalTrendResp {
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
   * The BILLED showback weekly lane cells over the SAME window (iter-2 I1, the
   * regional mirror — region-clamped): the usage-view "Where the AI spend goes"
   * hero's series (and, summed per lane, its pinned donut). Billed basis
   * (`v_finance_bill_showback`, GitHub §A tools excluded); never summed with the
   * §A `series`.
   */
  showbackWeeklyLanes: ShowbackWeeklyLaneCell[]
}
