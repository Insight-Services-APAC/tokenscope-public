/*
 * The wire shapes the Across-Regions reporting endpoints return, shared by the
 * ScopeAcrossRegions container (to type its useFetch generics) and the
 * ScopeAcrossRegionsView (its props). Pure types — no runtime.
 */
import type {
  DailyMetric,
  DriverRow,
  Forecast,
  ProviderSplit,
  ChargebackProviderSplit,
  ChargeDailyPoint,
  ChargebackLaneRow,
  ReportMeta,
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

export interface AcrossReport {
  meta: ReportMeta
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
  /** §B per-day Anthropic chargeback series (bill lane) — the Chargeable KPI-tile sparkline. */
  chargeDaily: ChargeDailyPoint[]
  /**
   * §B per-lane chargeback totals over the window (lane-visuals V2) — the
   * ChargebackSplitCard donut. Anthropic lanes day-grained; the three Copilot §B
   * lanes ride along only in validated chargeback mode over a month-aligned window
   * (the KPI's gate). Σ(lanes minus copilot-unclassified) == kpis.chargeableUsd.
   */
  chargebackLanes: ChargebackLaneRow[]
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

export interface ConcentrationStats {
  activeUsers: number
  totalUsd: number
  /** All three are fractions in [0,1]. */
  top1: number
  top5: number
  top10: number
  segments: ConcentrationSegmentStat[]
}

export interface AcrossDriversResp {
  axis: string
  headlineUsd: number
  rows: DriverRow[]
  concentration: ConcentrationStats
}
