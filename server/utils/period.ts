/*
 * period — UTC reporting-period boundaries shared across the rollup / worker /
 * notification surfaces. Centralised so the MTD anchor is computed ONE way; the
 * inline `new Date(Date.UTC(y, m, 1)).toISOString()` had drifted across a dozen
 * call-sites (org-tree, practice, manager, workers, notifications) and a single
 * off-by-one there silently re-windows every spend sum.
 */

/**
 * The UTC month-start of `now` (default: the current instant) as an ISO string,
 * e.g. `2026-06-01T00:00:00.000Z`. This is the canonical MTD anchor: every
 * `ar.ts_event >= monthStart` filter and `month_to_date` label derives from it.
 */
export function monthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

// ── Reporting month navigation (reporting-consolidation Wave 1) ──────────────
//
// The reporting endpoints accept a `month=YYYY-MM` param and window every query
// by a HALF-OPEN UTC range `[monthStartUtc, nextMonthStartUtc)` so a row lands in
// exactly one month (the month-boundary-invariance invariant, build-design §7(3)).
// One place computes the range — the same reason `monthStartIso` exists.

/**
 * Zod-friendly `YYYY-MM` shape. Anchored, month 01-12 only, so it drops straight
 * into `z.string().regex(MONTH_REGEX)`.
 */
export const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/

/** True when `month` is a well-formed `YYYY-MM` (year ≥ 0000, month 01-12). */
export function isValidMonth(month: string): boolean {
  return MONTH_REGEX.test(month)
}

export interface MonthRangeUtc {
  /** The input, echoed back (`YYYY-MM`). */
  month: string
  /** Inclusive lower bound — first instant of the month (UTC). */
  monthStartUtc: Date
  /** EXCLUSIVE upper bound — first instant of the NEXT month (UTC). */
  nextMonthStartUtc: Date
  /** `monthStartUtc.toISOString()` — convenience for SQL binds. */
  startIso: string
  /** `nextMonthStartUtc.toISOString()`. */
  endIso: string
}

/**
 * Parse `month` (`YYYY-MM`) into its half-open UTC range. Explicit UTC — never
 * the server's local zone. Throws on a malformed month (callers validate with
 * {@link MONTH_REGEX} first; this is the belt-and-braces guard).
 */
export function monthRangeUtc(month: string): MonthRangeUtc {
  if (!isValidMonth(month)) {
    throw new Error(`monthRangeUtc: invalid month '${month}' — expected YYYY-MM`)
  }
  const year = Number(month.slice(0, 4))
  const mon = Number(month.slice(5, 7)) // 1-12
  const monthStartUtc = new Date(Date.UTC(year, mon - 1, 1))
  const nextMonthStartUtc = new Date(Date.UTC(year, mon, 1))
  return {
    month,
    monthStartUtc,
    nextMonthStartUtc,
    startIso: monthStartUtc.toISOString(),
    endIso: nextMonthStartUtc.toISOString(),
  }
}

/** The `YYYY-MM` key of a date's UTC month (e.g. asOf → its month). */
export function monthKeyUtc(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0')
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  return `${y}-${m}`
}

/** UTC day-of-month, 1-31 (the forecast's `days_elapsed` anchor on `asOf`). */
export function utcDayOfMonth(date: Date): number {
  return date.getUTCDate()
}

/** Number of days in the UTC month that `date` falls in (28-31). */
export function daysInMonthUtc(date: Date): number {
  // Day 0 of the next month = the last day of this month.
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
}
