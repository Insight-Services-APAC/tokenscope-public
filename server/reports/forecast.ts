/*
 * reports/forecast — the ONE run-rate projection primitive for every reporting
 * scope (reporting-consolidation, docs/design/reporting-consolidation/
 * 00-build-design.md §5; PRD §5). Pure math — no DB, no clock beyond the
 * caller-supplied `now`/`asOf` — so the endpoints inject their aggregates and the
 * math is unit-testable without a database.
 *
 * Anchoring (build-design §5):
 *   asOf        = MAX(event_date) in the month (data-anchored, NEVER calendar today)
 *   daysElapsed = max(1, utcDayOfMonth(asOf))
 *   factor      = daysInMonth / daysElapsed
 *   projected   = mtd × factor
 *
 * METERED LANES ONLY. The MTD operand EXCLUDES the two non-metered Copilot
 * `actual_spend.source`s — extrapolating either double-counts:
 *   - 'copilot-seat:%'  — the month-final seat license, lands day 1.
 *   - 'copilot-overage' — a cumulative snapshot; linear extrapolation re-projects it.
 * The Copilot pool projection is estimate-class ONLY (rendered `estimated`, never a
 * charge — the chargeable overage is always the bill's net line, Wave 0).
 *
 * The forecast is ALWAYS computed on the in-progress month regardless of the page's
 * `month` filter; a CLOSED (past) month → `null` (banner shows the actual + chip).
 */
import { daysInMonthUtc, monthKeyUtc, utcDayOfMonth } from '../utils/period'
import type { CopilotPoolProjection, Forecast } from '../../shared/reports/types'

/** A raw `actual_spend`-shaped row for the metered-operand filter. */
export interface SpendSourceRow {
  source: string
  costUsd: number
}

/**
 * Is this `actual_spend.source` a METERED lane (run-rate eligible)? False for the
 * two non-metered Copilot sources that must never be extrapolated.
 */
export function isMeteredSource(source: string): boolean {
  return !(source.startsWith('copilot-seat:') || source === 'copilot-overage')
}

/** Σ costUsd over the metered rows only (seat/overage excluded from the operand). */
export function meteredMtd(rows: SpendSourceRow[]): number {
  return rows.reduce((sum, r) => (isMeteredSource(r.source) ? sum + r.costUsd : sum), 0)
}

/**
 * The estimate-class Copilot overage projection: `max(0, projectedCredits − pool)`
 * when the pool is positive, else 0 (build-design §5). NEVER a charge.
 */
export function projectCopilotOverage(projectedCreditsUsd: number, poolUsd: number): number {
  return poolUsd > 0 ? Math.max(0, projectedCreditsUsd - poolUsd) : 0
}

export interface ForecastInput {
  /** The page's requested month (`YYYY-MM`). */
  requestedMonth: string
  /** The clock — decides current-vs-closed month ONLY (never anchors the run-rate). */
  now: Date
  /** MAX(event_date) in the CURRENT month; null when the current month has no data. */
  asOf: Date | null
  /** Σ metered spend MTD (seat/overage already excluded — use {@link meteredMtd}). */
  meteredMtdUsd: number
  /** Copilot pool inputs; omit when the scope has no Copilot spend. */
  copilot?: {
    seatFinalUsd: number
    creditsMtdUsd: number
    poolUsd: number
  }
}

/**
 * Build the forecast for the requested month, or `null` when that month is not the
 * in-progress month (closed OR future) — the banner then shows the actual total.
 */
export function forecastForMonth(input: ForecastInput): Forecast | null {
  const { requestedMonth, now, asOf, meteredMtdUsd, copilot } = input

  // Forecast is only meaningful for the in-progress month (build-design §5 / PRD §5:
  // "always computed on the in-progress month regardless of the page's month filter").
  if (requestedMonth !== monthKeyUtc(now)) return null

  // Anchor the run-rate on the DATA (asOf), not the clock. With no data yet, MTD is 0
  // so the projection is 0 regardless of factor; anchor daysElapsed on the month start.
  const anchor = asOf ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const daysInMonth = daysInMonthUtc(anchor)
  const daysElapsed = Math.max(1, utcDayOfMonth(anchor))
  const factor = daysInMonth / daysElapsed

  const meteredProjectedUsd = meteredMtdUsd * factor

  let copilotProjection: CopilotPoolProjection | undefined
  if (copilot) {
    const projectedCreditsUsd = copilot.creditsMtdUsd * factor
    const projectedOverageUsd = projectCopilotOverage(projectedCreditsUsd, copilot.poolUsd)
    copilotProjection = {
      seatFinalUsd: copilot.seatFinalUsd,
      creditsMtdUsd: copilot.creditsMtdUsd,
      projectedCreditsUsd,
      poolUsd: copilot.poolUsd,
      projectedOverageUsd,
      spendClass: 'estimated',
    }
  }

  // Scope total = Σ metered projection + seat-final + overage projection (build-design §5).
  const projectedUsd =
    meteredProjectedUsd +
    (copilotProjection ? copilotProjection.seatFinalUsd + copilotProjection.projectedOverageUsd : 0)

  return {
    asOfDate: asOf ? asOf.toISOString().slice(0, 10) : null,
    daysElapsed,
    // The CLOCK, not the data — see the field's note in shared/reports/types.ts.
    dayOfMonth: utcDayOfMonth(now),
    daysInMonth,
    factor,
    meteredMtdUsd,
    meteredProjectedUsd,
    ...(copilotProjection ? { copilot: copilotProjection } : {}),
    projectedUsd,
  }
}
