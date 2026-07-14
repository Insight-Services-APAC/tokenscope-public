/*
 * reports/settling — a PURE clock function mapping (month, vendor, now) → the
 * settling state a reporting number should carry (reporting-consolidation,
 * docs/design/reporting-consolidation/00-build-design.md §5; owner gate-warning
 * fold-ins in 02-owner-decisions.md).
 *
 * There is NO recompute behind this — it is a clock, not a close. The canonical
 * finance_period month-end recompute-and-replace ("close") is deferred, so every
 * state is provisional and `closeRun` is ALWAYS false. The string "finalised" is
 * grep-banned and appears nowhere here.
 *
 * Horizons (build-design §5), measured from the first instant AFTER the month:
 *   anthropic → `settling` until +30d  (rolling revision window)
 *   github    → `settling` until +settleDays (config on provider_enterprise; default 7)
 *   usage     → `settling` until +35d  (usage-reconciliation TRAILING_DAYS)
 * Open month (still in progress) → `estimated`. Past every horizon → `settled`
 * (still provisional — "past settling horizon — provisional, no close run").
 */
import { monthRangeUtc } from '../utils/period'
import type { ProviderState, ProviderVendor, SettlingState } from '../../shared/reports/types'

/** Default GitHub settle horizon (days after month close) when unconfigured. */
export const DEFAULT_GITHUB_SETTLE_DAYS = 7
const ANTHROPIC_SETTLE_DAYS = 30
const USAGE_SETTLE_DAYS = 35

export interface SettleConfig {
  /** provider_enterprise-configured GitHub settle window; defaults to 7. */
  githubSettleDays?: number
}

/** Horizon length (days after the month closes) for a vendor's settling window. */
function horizonDays(vendor: ProviderVendor, config?: SettleConfig): number {
  switch (vendor) {
    case 'anthropic':
      return ANTHROPIC_SETTLE_DAYS
    case 'github':
      return config?.githubSettleDays ?? DEFAULT_GITHUB_SETTLE_DAYS
    case 'usage':
      return USAGE_SETTLE_DAYS
  }
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000)
}

/**
 * The settling state for one vendor's numbers in `month` as of `now`.
 * `settlesAt` (the horizon end) is present once the month has closed; while the
 * month is still open the state is `estimated` with no horizon.
 */
export function settlingState(
  month: string,
  vendor: ProviderVendor,
  now: Date,
  config?: SettleConfig,
): ProviderState {
  const { nextMonthStartUtc } = monthRangeUtc(month)

  // Still in progress (or a future month) → estimated, no horizon.
  if (now < nextMonthStartUtc) {
    return { vendor, state: 'estimated', closeRun: false }
  }

  const settlesAt = addDays(nextMonthStartUtc, horizonDays(vendor, config))
  const state: SettlingState = now < settlesAt ? 'settling' : 'settled'
  return { vendor, state, settlesAt: settlesAt.toISOString(), closeRun: false }
}

/** The three settling axes for a month — the `ReportMeta.providerStates` payload. */
export function providerStatesForMonth(
  month: string,
  now: Date,
  config?: SettleConfig,
): ProviderState[] {
  const vendors: ProviderVendor[] = ['anthropic', 'github', 'usage']
  return vendors.map((v) => settlingState(month, v, now, config))
}

/**
 * `providerStates` for a resolved reporting WINDOW (month OR custom `from`/`to`). The
 * honest whole-window settling state is the LEAST settled month it spans; settling is
 * MONOTONIC (a later month is less settled, having had less time to close), so that is
 * the window's LAST month. Using the start month for a multi-month range would over-
 * claim — e.g. a Q2 view reading "settled" off April while June is still settling. In
 * month mode this is identical to `providerStatesForMonth(win.monthStr, now)`.
 */
export function providerStatesForWindow(
  win: { monthStr: string | null; endIso: string },
  now: Date,
  config?: SettleConfig,
): ProviderState[] {
  // endIso is the EXCLUSIVE upper bound; the last DAY in the window is the day before.
  const lastMonth =
    win.monthStr ?? new Date(new Date(win.endIso).getTime() - 86_400_000).toISOString().slice(0, 7)
  return providerStatesForMonth(lastMonth, now, config)
}
