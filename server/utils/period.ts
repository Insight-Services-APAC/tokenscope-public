/*
 * period — UTC reporting-period boundaries shared across the rollup / worker /
 * notification surfaces. Centralised so the MTD anchor is computed ONE way; the
 * inline `new Date(Date.UTC(y, m, 1)).toISOString()` had drifted across a dozen
 * call-sites (org-tree, practice, manager, workers, notifications) and a single
 * off-by-one there silently re-windows every spend sum.
 *
 * ── TWO MONTH WINDOWS, AND THEY ARE NOT THE SAME QUESTION ────────────────────
 * `monthToDateWindow` ends at NOW. `calendarMonthWindow` ends at the first
 * instant of the next month. Confusing them is not a rounding error: it is the
 * difference between "what have we spent" and "what could the month hold", and
 * the callers that got it wrong quoted future-dated rows inside a figure
 * labelled month-to-date. The functions are named for the answer they give, not
 * for the boundary they compute, so a call site reads as the question it is
 * asking.
 */

/**
 * The UTC month-start of `now` (default: the current instant) as an ISO string,
 * e.g. `2026-06-01T00:00:00.000Z`. The lower bound both windows below share.
 */
export function monthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

/**
 * The first instant of the month AFTER `now`'s UTC month — the exclusive upper
 * bound of the WHOLE CALENDAR MONTH.
 *
 * NOT a month-to-date bound. Named for what it is because the previous name
 * (`monthEndIso`) read like one, and every caller that paired it with
 * {@link monthStartIso} to build an "MTD" window was counting rows dated LATER
 * THAN NOW — future-dated telemetry, a reconciliation row written ahead of the
 * clock, a hand-seeded row — inside a figure labelled "month to date".
 *
 * Use it for CALENDAR-month questions: a completed month's report, or "does
 * this allocation overlap the month" (a top-up effective on the 28th is real
 * budget for the month even on the 3rd). Use {@link monthToDateWindow} for
 * anything that says "so far".
 */
export function nextMonthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
}

/** A half-open `[startIso, endIso)` UTC instant range. */
export interface IsoWindow {
  /** Inclusive lower bound. */
  startIso: string
  /** EXCLUSIVE upper bound. */
  endIso: string
}

/**
 * MONTH TO DATE: `[month start, now)`. The window every "so far this month"
 * figure reads — project spend at every grain, the budget alert's trigger, the
 * cost-centre burn on the P&L card, untagged pressure.
 *
 * The upper bound is `now`, not the month end, and that is the whole point: a
 * row dated later today or later this month has not been spent yet at the
 * instant the figure is quoted, so counting it makes "month to date" mean
 * "month, plus whatever the future holds". Half-open so an event at exactly
 * `now` lands in the NEXT read rather than being counted twice.
 */
export function monthToDateWindow(now: Date = new Date()): IsoWindow {
  return { startIso: monthStartIso(now), endIso: now.toISOString() }
}

/**
 * The WHOLE calendar month `[month start, next month start)` — every instant the
 * month can hold, whether or not it has happened yet.
 *
 * The sibling of {@link monthToDateWindow}, and the two are NOT interchangeable:
 * this one is for questions about the month as a period (budget coverage, a
 * closed month's report), never for "how much have we spent so far".
 */
export function calendarMonthWindow(now: Date = new Date()): IsoWindow {
  return { startIso: monthStartIso(now), endIso: nextMonthStartIso(now) }
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
