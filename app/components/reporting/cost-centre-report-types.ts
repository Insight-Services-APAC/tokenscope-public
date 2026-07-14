/*
 * The wire shapes the Cost-Centre reporting endpoints return, shared by the
 * ScopeCostCentre container (to type its useFetch/$fetch generics) and the
 * ScopeCostCentreView (its props). Pure types — no runtime.
 */
import type { DriverRow, Forecast, ReportMeta } from '#shared/reports/types'

/** One CC card — burn (project-CoU usage axis) vs allocation + the two mechanics. */
export interface CostCentreCard {
  id: string
  code: string
  displayName: string
  regionCode: string
  burnUsd: number
  /**
   * §B chargeback for the CC over the window (`v_finance_chargeback_month`) — the
   * chargeback-lane figure the list shows instead of `burnUsd` in chargeback mode.
   * Anthropic always; Copilot pooled net only when validated. NEVER summed with burn.
   */
  chargeUsd: number
  allocationUsd: number
  utilisation: number | null
  /** Mechanic 1 — budget-exhaustion DATE (a date, never a dollar). */
  exhaustionDate: string | null
  /** Mechanic 2 — run-rate dollar projection (null when the month is closed). */
  forecast: Forecast | null
  asOfDate: string | null
}

export interface CostCentreReport {
  meta: ReportMeta
  cards: CostCentreCard[]
  laneNote: string
  /**
   * §B — copilot chargeback ON but the window is not month-aligned → the pooled (monthly)
   * Copilot net is withheld from every card's `chargeUsd` (never a partial slice). The
   * chargeback-mode view shows a "Copilot pooled (monthly) not shown for partial-month
   * ranges" caveat instead of a silent $0. Optional (absent ⇒ false) so pre-existing
   * fixtures need not set it.
   */
  copilotChargebackPartialMonth?: boolean
}

export interface CostCentreDrill {
  meta: ReportMeta
  cc: { id: string; code: string; displayName: string; regionCode: string }
  /**
   * §A usage BURN homed by emit-time cost_owning_unit_id — the SAME lane as the
   * tracker card burn, so the drill reconciles to the tracker row (chargeback /
   * billing for this CC lives in the Finance tab, never mixed in here).
   */
  burnUsd: number
  /** Burn split by vendor (feeds the donut). Copilot pooled NULL-CoU is excluded. */
  vendor: { claudeUsd: number; copilotUsd: number; otherUsd: number }
  /** Current-effective Σ project baseline+top-up allocation for the CC (0 if none). */
  allocationUsd: number
  axis: string
  /** The CC burn — what the driver rows sum back to. */
  headlineUsd: number
  denominatorLabel: string
  rows: DriverRow[]
}
