/*
 * reports/types — the shared contract the reporting API and the Reporting UI
 * agree on (reporting-consolidation Wave 1, docs/design/reporting-consolidation/
 * 00-build-design.md §3/§5). Lives in `shared/` so the server builds it and the
 * app imports it via `#shared/reports/types`. Pure types + small const arrays —
 * no runtime deps, safe on both sides of the wire.
 */

// ── Scopes ───────────────────────────────────────────────────────────────────
// The four role-gated reporting scopes (build-design §1). URL-synced via `?scope=`.
export const REPORT_SCOPES = ['across', 'regional', 'cost-centre', 'finance'] as const
export type ReportScope = (typeof REPORT_SCOPES)[number]

export function isReportScope(v: string): v is ReportScope {
  return (REPORT_SCOPES as readonly string[]).includes(v)
}

// ── Spend class ──────────────────────────────────────────────────────────────
// How a money figure should be READ (build-design §5, D-Q6 §A/§B separation):
//  - 'estimated'    — inference/run-rate; "emitted, not the billed P&L figure".
//  - 'indicative'   — a usage-lane $ for spend the bill has not (yet) confirmed.
//  - 'pooled-usage' — per-teammate Copilot USD: informational only, billing is
//                     POOLED per cost-centre — NEVER a per-user charge.
export type SpendClass = 'estimated' | 'indicative' | 'pooled-usage'

/**
 * One ranked driver row (region / practice / teammate / model / project / …).
 * Every DriversTable's rows sum back to its headline in the SAME lane (the
 * sum-back invariant, build-design §7(4)); `dims` carries the drill keys
 * (e.g. `{ region_id, org_unit_id }`) and a NULL value renders as the explicit
 * "unattributed" bucket (e.g. NULL model) so the sum-back holds.
 */
export interface DriverRow {
  key: string
  label: string
  usd: number
  /**
   * Share of the scope denominator as a FRACTION in [0,1] (e.g. 0.42 → "42%") —
   * the codebase-wide `pct()`/`signedPct` convention. Format with `fmtPct`/
   * `signedPct` from `useFormat`; do NOT pre-multiply by 100.
   */
  sharePct: number
  spendClass: SpendClass
  dims?: Record<string, string | null>
}

// ── Provider settling state ──────────────────────────────────────────────────
// The settling axes surfaced per report (build-design §5). 'anthropic' + 'github'
// are the BILL lanes; 'usage' is the API-vs-OTel usage lane, which settles on its
// own (longer) reconciliation horizon.
export type ProviderVendor = 'anthropic' | 'github' | 'usage'

// A clock state, NOT a finalisation state (build-design §5, warning 1; owner
// gate-warning fold-in). "finalised" is grep-banned. 'settled' means "past every
// settling horizon" — still provisional, because no month-end close machinery
// (finance_period) exists yet.
export type SettlingState = 'estimated' | 'settling' | 'settled'

export interface ProviderState {
  vendor: ProviderVendor
  state: SettlingState
  /** ISO instant the vendor's settling horizon ends. Absent while `estimated`. */
  settlesAt?: string
  /** Point-in-time the figures were computed (ISO date), when surfaced. */
  asOfDate?: string
  /**
   * GitHub bill lane stays `false` until a real invoice reconciles (owner-decisions
   * gate fold-in — settling honesty). Absent when not applicable to the vendor.
   */
  invoiceReconciled?: boolean
  /**
   * ALWAYS false — no recompute-and-replace close has run (build-design §7(6)).
   * A literal-false field, not a boolean, so any "settled ⇒ finalised" reading is
   * a type error, not a silent copy bug.
   */
  closeRun: false
}

// ── Forecast ─────────────────────────────────────────────────────────────────
// The run-rate projection for the IN-PROGRESS month (build-design §5). Closed
// months carry `forecast: null` at the response level (never a stale forecast).
export interface CopilotPoolProjection {
  /** Month-final Copilot seat license (lands day 1; NOT extrapolated). */
  seatFinalUsd: number
  /** Copilot credit usage MTD (the run-rate operand for overage). */
  creditsMtdUsd: number
  /** creditsMtdUsd × factor — the projected month-end credit usage. */
  projectedCreditsUsd: number
  /** The included pool allowance (0 ⇒ overage projection disabled). */
  poolUsd: number
  /**
   * max(0, projectedCredits − pool) when pool > 0, else 0. ESTIMATE-CLASS ONLY —
   * a forecast-banner projection, NEVER a charge (build-design §5, violation 1;
   * the chargeable overage is the bill's net line, from `copilot_pool_bill`).
   */
  projectedOverageUsd: number
  spendClass: 'estimated'
}

export interface Forecast {
  /** MAX(event_date) in the month as `YYYY-MM-DD`; null when the month has no data. */
  asOfDate: string | null
  /** utcDayOfMonth(asOf), floored at 1. */
  daysElapsed: number
  /** Days in the forecast month (28-31). */
  daysInMonth: number
  /** daysInMonth / daysElapsed. */
  factor: number
  /** Σ metered (run-rate-eligible) spend MTD — excludes Copilot seat + overage sources. */
  meteredMtdUsd: number
  /** meteredMtdUsd × factor. */
  meteredProjectedUsd: number
  /** Present only when the scope has Copilot pool spend. */
  copilot?: CopilotPoolProjection
  /**
   * The "on track for $X" headline = metered projection + Copilot seat-final +
   * Copilot overage projection (build-design §5, "Scope total").
   */
  projectedUsd: number
}

// ── Provider split (per-vendor breakdown over a window) ──────────────────────
/**
 * One vendor's aggregate over a reporting window (`v_complete_usage`, §A usage
 * lane): usage-lane spend + distinct active users.
 */
export interface ProviderSplitEntry {
  spendUsd: number
  /**
   * `COUNT(DISTINCT teammate_id) FILTER (WHERE tool = …)`. A teammate active in TWO
   * vendors is counted in BOTH buckets, so the per-vendor `activeUsers` may exceed
   * the whole-window distinct `activeUsers` KPI — they are not additive.
   */
  activeUsers: number
}

/**
 * The per-provider §A usage split (whole company or region-scoped,
 * `v_complete_usage`). The three-lane §A ceiling (lane-visuals V1): the THREE
 * named §A usage lanes — `claude-code` → `claudeCode`, `copilot-cli` →
 * `copilotCli`, `copilot-agent` → `copilotAgent` — PLUS the standing live
 * `other` catch-all (unknown tools, NULL from reconciliation deltas). The four
 * `spendUsd` values SUM BACK to the genuine headline (every record's `tool`
 * lands in exactly one bucket). NOTE: `copilot-agent` is structurally absent
 * from `v_complete_usage` today (mig 0086 owner decision — the coding-agent
 * lane feeds neither union arm), so `copilotAgent` reads 0 until the owner
 * follow-up lands a non-taggable completeness feed; the bucket exists so that
 * spend surfaces under its own lane the day it does, instead of silently
 * folding into `other` (the old 2+catch-all shape's data loss).
 */
export interface ProviderSplit {
  claudeCode: ProviderSplitEntry
  copilotCli: ProviderSplitEntry
  copilotAgent: ProviderSplitEntry
  other: ProviderSplitEntry
}

// ── §B chargeback provider split (bill lane — the §B analogue of ProviderSplit) ─
/**
 * The two §B CHARGEBACK buckets for the chargeback-lane provider split card:
 * Anthropic per-teammate chargeback (`v_finance_bill_chargeback`, month-rolled) vs
 * the Copilot per-org POOLED net (`v_finance_copilot_pool_chargeback`). NEVER the
 * §A usage `spendUsd` — the two lanes are never summed. `copilotUsd` is `null` when
 * the pooled Copilot chargeback is held back (pending validation, `copilotChargeback`
 * off); the two present values SUM BACK to the chargeable headline.
 */
export interface ChargebackProviderSplit {
  /** Anthropic per-teammate chargeback for the window (bill lane). */
  anthropicUsd: number
  /** Copilot per-org pooled net — `null` while pending validation (pooled, not per-user). */
  copilotUsd: number | null
  /**
   * True when copilot chargeback is ON but the active window is NOT month-aligned, so the
   * pooled (monthly) Copilot net is withheld for this partial-month range (`copilotUsd` is
   * `null` for a DIFFERENT reason than pending). The card renders "not shown for
   * partial-month ranges" rather than "Pending validation" or a silent $0.
   */
  partialMonthUnavailable?: boolean
}

// ── §B chargeback daily series (bill lane — the §B analogue of DailyMetric) ────
/**
 * One UTC day's §B ANTHROPIC chargeback over the active window
 * (`v_finance_bill_chargeback`, the per-teammate DAILY bill lane). Feeds the
 * chargeback-mode spend-trend card + the Chargeable KPI-tile sparkline. Copilot is
 * ABSENT here by construction (its chargeback is pooled per cost-centre, MONTH-grained
 * — see `ChargebackProviderSplit.copilotUsd`), so this is a single Anthropic series.
 */
export interface ChargeDailyPoint {
  /** `YYYY-MM-DD` (UTC day). */
  day: string
  /** Σ Anthropic chargeback `bill_usd` that day. */
  chargeUsd: number
}

// ── §B chargeback lane series (bill lane, per-lane — lane-visuals V2) ─────────
/**
 * One `(day, lane)` point of the §B ANTHROPIC chargeback over the window
 * (`v_finance_bill_chargeback` GROUP BY tool, mapped to registry lane ids via
 * `chargeToVendor`). The per-lane widening of {@link ChargeDailyPoint}: carried
 * ALONGSIDE the total `chargeSeries` (which stays zero-filled and authoritative),
 * and cent-exactly conserving — Σ lanes per day == that day's `chargeUsd`
 * (pinned by the reports integration suite). Copilot lanes are structurally
 * ABSENT (the mig-0085 firewall: pooled, MONTH-grained, never in this view).
 */
export interface ChargeLanePoint {
  /** `YYYY-MM-DD` (UTC day). */
  day: string
  /** Registry lane id (`claude`, `claude-ai`, … — never a raw tool literal). */
  lane: string
  /** Σ chargeback `bill_usd` for that (day, lane). */
  chargeUsd: number
}

// ── §B billed showback weekly lanes (bill lane — the usage-view composition hero) ─
/**
 * One `(ISO week, lane)` cell of the BILLED showback over the active window
 * (`v_finance_bill_showback` GROUP BY `date_trunc('week', period_date)` × tool,
 * tools mapped to registry lane ids via `toolToVendor`). Feeds the usage-view
 * "Where the AI spend goes" hero + its pinned "Spend by surface · billed" donut
 * (lane-visuals iter-2 I1). ANTHROPIC surfaces only: the §A GitHub usage tools
 * (`copilot-cli` / `copilot-agent` — telemetry-basis rows riding the showback
 * view) are firewalled OUT (GITHUB_FIREWALL_EXCLUSIONS), so a usage-basis figure
 * can never surface inside a billed-basis element. Σ cells == the window's
 * (GitHub-excluded) showback total, cent-exact (test-pinned). NEVER summed with
 * any §A usage figure.
 */
export interface ShowbackWeeklyLaneCell {
  /** `YYYY-MM-DD` — the ISO week's Monday (UTC `date_trunc('week')`). */
  weekStart: string
  /** Registry lane id (`claude`, `claude-ai`, … — never a raw tool literal). */
  lane: string
  /** Σ showback `bill_usd` for that (week, lane). */
  usd: number
}

/**
 * One lane's §B chargeback total over the active window — the ChargebackSplitCard
 * donut operand (lane-visuals V2). Anthropic lanes come day-grained from
 * `v_finance_bill_chargeback` (Σ == `anthropicChargeableUsd`, cent-exact); the
 * three Copilot §B lanes come pooled-monthly from `v_finance_copilot_pool_chargeback`
 * and are present ONLY when copilot chargeback is validated AND the window is
 * month-aligned (the same gate as the KPI fold — never a partial-month slice).
 * `copilot-unclassified` rides along VISIBLE but is excluded from every
 * chargeable sum (the FinanceCouTable badge convention).
 */
export interface ChargebackLaneRow {
  /** Registry lane id. */
  lane: string
  /** Σ chargeback USD for the lane over the window. */
  chargeUsd: number
}

// ── §B chargeback day-of-week (bill lane — the §B analogue of the seasonality heatmap) ─
/**
 * One day-of-week bucket of §B ANTHROPIC chargeback over the active window
 * (`v_finance_bill_chargeback`, `EXTRACT(ISODOW)`). Seven buckets (Mon..Sun) feed the
 * chargeback-mode "when spend happens" card. Copilot is absent (pooled, monthly).
 */
export interface ChargeDowBucket {
  /** ISO day-of-week, ZERO-BASED: 0 = Monday … 6 = Sunday (matches {@link SeasonalityCell.dow}). */
  dow: number
  /** Σ Anthropic chargeback `bill_usd` on that day-of-week. */
  chargeUsd: number
}

// ── Across trend (day-grain, vendor-stacked) ─────────────────────────────────
/**
 * One point in the Across trend: a `(day, vendor)` cost. `key` is the `tool` id —
 * the three named §A usage lanes + the `other` catch-all (the three-lane §A
 * ceiling, lane-visuals V1). `copilot-agent` is emitted only when it carries
 * spend (structurally absent from `v_complete_usage` today — see ProviderSplit).
 */
export interface AcrossTrendPoint {
  day: string
  key: 'claude-code' | 'copilot-cli' | 'copilot-agent' | 'other'
  value: number
}

/**
 * The Across-Regions day-grain, vendor-stacked usage trend over the active window
 * (a calendar month by default, or a custom `from`/`to` range). Mirrors the shape
 * of the Regional trend one tier up.
 */
export interface AcrossTrend {
  /** Inclusive window bounds (`YYYY-MM-DD`). */
  window: { from: string; to: string }
  series: AcrossTrendPoint[]
  /**
   * §B ANTHROPIC chargeback per day over the SAME window (`v_finance_bill_chargeback`) —
   * the chargeback-lane series the spend-trend card renders in chargeback mode. Carried
   * alongside the §A `series` (like the index's `regionCards` + `chargebackByRegion`);
   * the two lanes are NEVER summed. Copilot is pooled/monthly, so it is absent here.
   */
  chargeSeries: ChargeDailyPoint[]
  /**
   * The per-LANE widening of `chargeSeries` (lane-visuals V2): the same §B window
   * GROUP BY tool, mapped to registry lane ids. Σ lanes per day == that day's
   * `chargeUsd` (cent-exact, test-pinned); `chargeSeries` remains the zero-filled
   * total the run-rate tail and sparklines bind on.
   */
  chargeLanes: ChargeLanePoint[]
  /**
   * The BILLED showback weekly lane cells over the SAME window (iter-2 I1) — the
   * usage-view composition hero's series (and, summed per lane, its pinned donut).
   * `window` above is the ONE shared window object hero + donut both bind on.
   * Billed basis (`v_finance_bill_showback`, GitHub §A tools excluded); never
   * summed with the §A `series`.
   */
  showbackWeeklyLanes: ShowbackWeeklyLaneCell[]
}

// ── Seasonality (day-of-week × ISO-week heatmap) ─────────────────────────────
/**
 * One cell of the seasonality heatmap — the Σ cost for a single (ISO week, ISO
 * day-of-week) bucket over `v_complete_usage.ts_event`.
 */
export interface SeasonalityCell {
  /** ISO day-of-week, ZERO-BASED: 0 = Monday … 6 = Sunday. */
  dow: number
  /** Index into the enclosing {@link Seasonality.weeks} array (oldest→newest). */
  weekIdx: number
  /** Σ `cost_usd` in that (ISO week × ISO dow) bucket. */
  value: number
}

/**
 * The real day-of-week × ISO-week seasonality grid (the AEUF-exceed "cyclical"
 * visual — actual usage, not a synthesized weekday/weekend curve). Only buckets
 * with a usage row are emitted; the heatmap renders absent (dow, week) pairs as
 * empty. `weeks` is the ordered ISO-week axis; every cell's `weekIdx` indexes it.
 */
export interface Seasonality {
  /** Inclusive window bounds (`YYYY-MM-DD`). */
  window: { from: string; to: string }
  /** ISO week keys (`YYYY-Www`), oldest→newest — the heatmap's week axis. */
  weeks: string[]
  cells: SeasonalityCell[]
  /**
   * §B ANTHROPIC chargeback by day-of-week over the SAME window
   * (`v_finance_bill_chargeback`) — the chargeback-lane "when spend happens" the card
   * renders in chargeback mode. Always seven buckets (Mon..Sun). Carried alongside the
   * §A `cells` (the "response carries both lanes" pattern); the two are NEVER summed.
   */
  chargeDow: ChargeDowBucket[]
}

// ── Active-user trend (distinct active teammates per tool, per day) ──────────
/** One day's distinct-active-teammate counts, split by tool. */
export interface ActiveTrendPoint {
  /** `YYYY-MM-DD` (UTC day). */
  day: string
  /** `COUNT(DISTINCT teammate_id)` with a `claude-code` record that day. */
  claudeCode: number
  /** `COUNT(DISTINCT teammate_id)` with a `copilot-cli` record that day. */
  copilot: number
}

/**
 * The active-users-over-time trend (the AEUF-exceed "how many devs on each tool"
 * as a series, not a point KPI). One point per day with any usage; the per-tool
 * counts are NOT additive (a teammate active in both tools is counted in both).
 */
export interface ActiveTrend {
  /** Inclusive window bounds (`YYYY-MM-DD`). */
  window: { from: string; to: string }
  series: ActiveTrendPoint[]
}

// ── Cost-centre summary (KPI strip + RAG rollup) ─────────────────────────────
/**
 * The whole-scope Cost-Centre rollup, computed from the visible cards — the KPI
 * strip (totals) + a RAG count breakdown (over / near / on-track / no-allocation).
 * The four counts partition the visible cards exactly (Σ counts = card count).
 */
export interface CostCentreSummary {
  /** Σ burn across the visible cards (project-CoU usage axis). */
  totalBurnUsd: number
  /** Σ current-effective allocation across the visible cards. */
  totalAllocationUsd: number
  /** Cards at/over budget (utilisation ≥ 1). */
  countOverBudget: number
  /** Cards near budget (CC_NEAR_BUDGET_THRESHOLD ≤ utilisation < 1). */
  countNearBudget: number
  /** Cards on track (utilisation < CC_NEAR_BUDGET_THRESHOLD). */
  countOnTrack: number
  /** Cards with no allocation (utilisation null). */
  countNoAllocation: number
  /** MAX(ts_event) across the visible cards (`YYYY-MM-DD`), or null. */
  asOfDate: string | null
}

/** The near-budget (amber) RAG threshold — a card ≥ this fraction of its allocation is "warn". */
export const CC_NEAR_BUDGET_THRESHOLD = 0.8

/**
 * Classify a cost-centre's utilisation (burn ÷ allocation) into a RAG state the
 * card grid + summary rollup both key on (one definition, no drift): `none` (no
 * allocation) · `ok` (< threshold) · `warn` (near) · `over` (≥ 100%).
 */
export function costCentreBudgetState(
  utilisation: number | null,
): 'over' | 'warn' | 'ok' | 'none' {
  if (utilisation == null) return 'none'
  if (utilisation >= 1) return 'over'
  if (utilisation >= CC_NEAR_BUDGET_THRESHOLD) return 'warn'
  return 'ok'
}

// ── Daily metrics (§A usage sparkline series) ────────────────────────────────
/**
 * One UTC day's §A usage aggregate over the active window (`v_complete_usage`) —
 * the per-tile KPI sparkline series (Attributed usage / Tokens / Active users /
 * Avg usage). PURE usage lane: never a chargeback figure. `activeUsers` is
 * `COUNT(DISTINCT teammate_id)` for that day (not additive across days).
 */
export interface DailyMetric {
  /** `YYYY-MM-DD` (UTC day). */
  day: string
  /** Σ `cost_usd` that day (the §A attributed-usage sparkline operand). */
  genuineUsd: number
  /** Σ `tokens` that day. */
  tokens: number
  /** `COUNT(DISTINCT teammate_id)` active that day. */
  activeUsers: number
}

// ── Report meta (bootstraps every reporting response) ────────────────────────
export interface ReportMeta {
  /** The requested month (`YYYY-MM`); in custom-range mode, the window's start-month. */
  month: string
  /** Earliest month with data for this scope (`YYYY-MM`) — the picker floor. */
  monthFloor: string
  /** MAX(event_date) surfaced (`YYYY-MM-DD`); null when the month has no data. */
  asOfDate: string | null
  /** Per-vendor settling states for the month. */
  providerStates: ProviderState[]
  scope: ReportScope
  /**
   * true when the response's org dims are point-in-time "as at emit" (usage lane,
   * historical months); false when re-homed to current org structure (build-design
   * §5 disclosure copy).
   */
  pointInTimeDims: boolean
  /**
   * Present ONLY when the active window is a custom `from`/`to` date range (both
   * `YYYY-MM-DD`, inclusive `to`). Absent in the default month mode. When present,
   * `month`/`monthFloor` are the window's start-month representative and the
   * month-anchored figures (forecast, momDeltaPct) are null.
   */
  range?: { from: string; to: string }
}

// ── Vendor vocabulary ────────────────────────────────────────────────────────
/**
 * Human vendor label for the reporting area (reporting-domain vocabulary, not a
 * generic formatter — kept here alongside the canonical types rather than in
 * `useFormat`). Pure: no runtime deps, safe on both sides of the wire.
 */
export function vendorLabel(vendor: string | null | undefined): string {
  const v = (vendor ?? '').toLowerCase()
  if (v.includes('anthropic') || v === 'claude') return 'Anthropic'
  if (v.includes('github') || v.includes('copilot')) return 'GitHub Copilot'
  return vendor ? vendor.charAt(0).toUpperCase() + vendor.slice(1) : 'Provider'
}
