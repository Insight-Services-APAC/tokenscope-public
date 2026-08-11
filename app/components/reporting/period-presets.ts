/*
 * PERIOD PRESETS — "this month", "last complete month", "this quarter", all as
 * PURE functions of a server-resolved UTC day.
 *
 * `clock-and-day-boundary.md` names `DateRangeControl` as the origin of the
 * whole clock question: it held four independent `new Date()` reads, and
 * `FinancePeriodControl` / `ScopeFinance` / two admin pages each carried their
 * own copy of `lastCompleteMonth`. Six definitions of "this month", agreeing by
 * luck, none of them testable.
 *
 * The defect was never the arithmetic — it is already UTC. It is OWNERSHIP: a
 * control that answers "what month is it" on its own can label a period the
 * server is not serving. Click "This month" a second after UTC midnight and you
 * request a month the pollers have no data for, under a pill that says the month
 * is current.
 *
 * Everything here takes `today` (`YYYY-MM-DD`, from `useServerClock`). No
 * function in this file reads a clock, which is what makes the presets pinnable
 * in a test and identical across every control that shows them.
 */
import { shiftUtcDay, utcMonthOf } from '#shared/reports/clock'

/** The UTC month `today` sits in (`YYYY-MM`) — "This month" as a `?month=`. */
export function currentMonth(today: string): string {
  return utcMonthOf(today)
}

/**
 * The last COMPLETE calendar month (`YYYY-MM`).
 *
 * Complete means ended, not "the previous one": on 2026-01-14 that is 2025-12.
 * The month before `today`'s, found by stepping to the first of this month and
 * back one day — no month arithmetic, so no December wrap to get wrong.
 */
export function lastCompleteMonth(today: string): string {
  return utcMonthOf(shiftUtcDay(`${utcMonthOf(today)}-01`, -1))
}

/**
 * The current quarter TO DATE, or `null` when the quarter has no settled day yet.
 *
 * `to` is the SETTLED edge, not `today`: a quarter-to-date window that runs to
 * the still-filling day asks for a day the report cannot answer for, and its
 * final point comes back padded to zero.
 *
 * WHICH IS WHY IT CAN RETURN NULL (external review). On 1 Jan / 1 Apr / 1 Jul /
 * 1 Oct the settled edge is the LAST day of the PREVIOUS quarter, so this
 * returned `from = 2026-10-01`, `to = 2026-09-30` — an inverted range that
 * `resolveReportRange` rejects with a 400, taking every report on the page down
 * with it. Four days a year, "This quarter" simply broke.
 *
 * There is no honest range to return on those days: the quarter has begun and
 * nothing in it has settled. So the preset is UNAVAILABLE rather than wrong, and
 * `DateRangeControl` disables the pill and says why — the same posture it
 * already takes for a preset whose clock has not landed. Clamping `to` up to
 * `from` was the alternative and it is worse: it would quote the still-filling
 * day as a settled window and draw its padded zero as a quarter.
 */
export function currentQuarterRange(
  today: string,
  settledThrough: string,
): { from: string; to: string } | null {
  const year = today.slice(0, 4)
  const month = Number(today.slice(5, 7)) // 1-12
  const qStartMonth = Math.floor((month - 1) / 3) * 3 + 1
  const from = `${year}-${String(qStartMonth).padStart(2, '0')}-01`
  // String compare is safe and total on `YYYY-MM-DD` — same width, same order.
  if (settledThrough < from) return null
  return { from, to: settledThrough }
}

/** A trailing band of `days` days ending at the SETTLED edge (inclusive). */
export function trailingRange(settledThrough: string, days: number): { from: string; to: string } {
  return { from: shiftUtcDay(settledThrough, -(days - 1)), to: settledThrough }
}
