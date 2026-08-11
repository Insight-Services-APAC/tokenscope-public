/*
 * THE ROLLING TREND WINDOW — one definition, both scopes.
 *
 * `ScopeRegional.vue` and `ScopeAcrossRegions.vue` each carried a BYTE-DUPLICATE
 * `todayMs()` / `daysAgo()` pair and each computed the rolling window's right
 * edge as the BROWSER's today (`clock-rot-audit.md` §B, two HIGH findings). Two
 * consequences, and the second is why this is one module rather than two fixes:
 *
 *   1. the right edge was a wall-clock fact where the chart needs a COVERAGE
 *      fact, so the last bar was a day the pollers may not have covered — drawn
 *      as a real drop. That is the morning dip, client side.
 *   2. being a copy, a fix to one silently leaves the other, and the two trends
 *      a reader compares side by side end up on different x-extents.
 *
 * Pure and clock-free: `clock` is an argument. Same clock in ⇒ same window out,
 * which is what makes "both trend charts share one x-extent" a testable claim
 * rather than a coincidence.
 */
import { shiftUtcDay, type ServerClock } from '#shared/reports/clock'

/**
 * The rolling trend band: `days` days ending at the SETTLED edge.
 *
 * Not at `clock.today`. A window that ends on the still-filling day asks the
 * server for a day it cannot yet answer for, and the response's final point is
 * then padded to zero by whatever draws it.
 */
export function rollingTrendWindow(clock: ServerClock, days: number): { from: string; to: string } {
  const to = clock.settledThrough
  return { from: shiftUtcDay(to, -(days - 1)), to }
}
