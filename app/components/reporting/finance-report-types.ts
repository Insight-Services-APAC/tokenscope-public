/*
 * The wire shapes the Finance reporting endpoints return (Wave 5), shared by the
 * ScopeFinance container (to type its useFetch/$fetch generics) and the
 * ScopeFinanceView (its props). Pure types — no runtime.
 */
import type { DriverRow, ReportMeta } from '#shared/reports/types'

export type CopilotMode = 'pool-utilisation' | 'chargeback'

/** One provider's bill total in the Σ=bill check row. */
export interface FinanceBillProvider {
  provider: string
  billUsd: number
  unsettled: boolean
}

/** The VISIBLE Σ=bill reconciliation (green matched / RED unsettled). */
export interface FinanceBillCheck {
  chargebackUsd: number
  billUsd: number
  deltaUsd: number
  matched: boolean
  unsettled: boolean
  /** Copilot pooled-net portion of the whole-company chargeback — Σ of the three §B
   * chargeback lanes; the held-back delta the pool-utilisation caption reconciles the
   * Σ=bill headline against the Chargeable column (M1). */
  copilotChargebackUsd: number
  /** The Copilot chargeback split by §B lane (copilot-license / copilot-usage /
   * copilot-unclassified, registry order, zero lanes included — render elides).
   * copilot-unclassified is badged "needs mapping" and never chargeable. */
  copilotLanes: FinanceCouLane[]
  /** The ANTHROPIC chargeback split by surface lane (lane-visuals V3) — registry
   * order, zero lanes elided. Σ == chargebackUsd − copilotChargebackUsd, cent-exact.
   * The card folds it (r1-F3); the wire carries every lane. */
  anthropicLanes: FinanceCouLane[]
  providers: FinanceBillProvider[]
}

/** One per-surface chargeback lane of a CoU's charge (#142). Lane ids match
 * shared/usage/vendor.ts VENDOR_LANES; colours are FIXED per lane id. */
export interface FinanceCouLane {
  lane: string
  label: string
  usd: number
}

/** One per-CoU chargeback row (per-provider chips). */
export interface FinanceCouRow {
  /** null = the VISIBLE unallocated bucket. */
  couId: string | null
  code: string | null
  displayName: string
  regionCode: string | null
  anthropicUsd: number
  copilotUsd: number
  copilotPending: boolean
  chargeableUsd: number
  /** Per-surface split, VENDOR_LANES order, zero lanes elided (#142). */
  lanes: FinanceCouLane[]
}

/** The exempt-gap card (indicative usage lane − chargeback). */
export interface FinanceExemptGap {
  indicativeUsageUsd: number
  chargebackUsd: number
  gapUsd: number
  /** Copilot pooled-net portion of this (region-scoped) chargeback — the caption figure that
   * keeps the card mode-consistent with the per-CoU Chargeable column in pool-utilisation mode (M1). */
  copilotChargebackUsd: number
}

export interface FinanceReport {
  meta: ReportMeta
  billCheck: FinanceBillCheck
  cous: FinanceCouRow[]
  copilot: {
    mode: CopilotMode
    pending: boolean
    /** ADVISORY: chargeback mode is ON while the window carries unclassified Copilot
     * spend (runbook says classify + re-run first). Never blocks data — the view
     * banners it; unclassified stays excluded from every chargeable figure. */
    unclassifiedWarning: boolean
  }
  exemptGap: FinanceExemptGap
  region: string | null
  homingNote: string
}

// ── Drill ─────────────────────────────────────────────────────────────────────
export interface AnthropicCharge {
  teammateId: string
  label: string
  chargeUsd: number
  /** Per-surface lane split of this teammate's charge (lane-visuals V3) —
   * VENDOR_LANES order, zero lanes elided; Σ lanes == chargeUsd by construction.
   * Feeds the dominant-lane badge + "+N surfaces" tooltip (r1-F7/r2-5). */
  lanes: FinanceCouLane[]
}

export interface CopilotPooledLine {
  orgId: string | null
  label: string
  licenseUsd: number
  overageUsd: number
  /** Lines matching neither SKU classifier — badged "needs mapping", never in netUsd. */
  unclassifiedUsd: number
  /** license + overage — the CHARGEABLE net (unclassified excluded by design). */
  netUsd: number
  unsettled: boolean
}

export interface CopilotPoolUtilisation {
  usageGrossUsd: number
  poolUsd: number
  utilisation: number | null
  /** Σ unclassified NET — visible in every mode, chargeable in none. */
  unclassifiedNetUsd: number
}

/** The Overage Drivers panel — INFORMATIONAL proportional shares (never a charge). */
export interface OverageDrivers {
  overageNetUsd: number
  perSeatShareUsd: number
  rows: DriverRow[]
}

export interface FinanceDrill {
  meta: ReportMeta
  cou: { id: string; code: string; displayName: string; regionCode: string | null }
  anthropicCharges: AnthropicCharge[]
  anthropicChargeableUsd: number
  copilot: {
    mode: CopilotMode
    pending: boolean
    /** chargeback mode → the per-org pooled lines; pool-utilisation → null. */
    pooledLines: CopilotPooledLine[] | null
    /** pool-utilisation mode → the utilisation card; chargeback → null. */
    poolUtilisation: CopilotPoolUtilisation | null
    /** pooled net (chargeback mode) or null (pending). NEVER includes unclassified. */
    chargeableUsd: number | null
    licenseNetUsd: number
    overageNetUsd: number
    /** unclassified NET (mig 0085) — badged "needs mapping", excluded from chargeable. */
    unclassifiedNetUsd: number
    /** true in chargeback mode when a pooled line is unsettled (usage but no read license SKU):
     * chargeableUsd silently drops the unread license — the view caveats it + shows amber (M2). */
    unsettled: boolean
  }
  chargeableUsd: number
  projectOverlay: DriverRow[]
  projectHeadlineUsd: number
  /** Present only when the CoU has PAID overage in chargeback mode (D-Q6). */
  overageDrivers: OverageDrivers | null
  homingNote: string
}
