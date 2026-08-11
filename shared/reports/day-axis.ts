/*
 * THE DRAWING CONTRACT — one pure shaper, consumed by every day-grain chart.
 *
 * Fix-sprint F1 / D4-D5. This module answers exactly one question: **which UTC
 * days appear on the axis, in order.** It is PURE and CLOCK-FREE — every input
 * is an argument, nothing here asks what time it is. That is the whole point:
 * the clock is resolved once by the server (`shared/reports/clock.ts`) and every
 * axis is a function of it, so two charts on one page cannot disagree about
 * where "now" is.
 *
 * WHAT IT REPLACES, AND WHY THAT WAS WRONG. `padDays` zero-filled a trailing
 * window ending at the BROWSER's today, and `StackedBars`' dense axis defaulted
 * the same way. Both therefore emitted a genuine `0` for the current day — a day
 * the server deliberately refuses to claim anything about
 * (`usage-series.ts`: "a FUTURE day is NOT emitted, because nothing has been
 * measured there"). NULL IS NOT 0. The client was undoing the server's care, and
 * the fabricated zero is what draws as the morning dip.
 *
 * THE RULE:
 *   - the axis runs to `endDay` — `settledThrough`, the last COMPLETE UTC day;
 *   - `today` appears BEYOND that edge only when it actually carries data, and
 *     is marked partial so it renders faded, excluded from trend lines,
 *     trailing means and peak labels (D4);
 *   - a settled day with no rows IS zero-filled. We looked and found none, which
 *     is a measured zero and the shape of the month depends on it.
 */

const DAY_MS = 86_400_000

function parseDay(day: string): number {
  const ms = Date.parse(`${day}T00:00:00.000Z`)
  if (Number.isNaN(ms)) throw new Error(`not a YYYY-MM-DD UTC day: ${day}`)
  return ms
}

/**
 * `count` consecutive UTC days ending at `endDay` INCLUSIVE, ascending.
 * `count <= 0` yields `[]` rather than throwing — a chart may not fail to render
 * over a bad prop.
 */
export function denseDays(endDay: string, count: number): string[] {
  if (!Number.isFinite(count) || count <= 0) return []
  const end = parseDay(endDay)
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    out.push(new Date(end - i * DAY_MS).toISOString().slice(0, 10))
  }
  return out
}

export interface DayAxisInput {
  /** The axis' right edge: the last day the chart is willing to claim. */
  endDay: string
  /** How many days the axis spans, ending at `endDay`. */
  days: number
  /**
   * The still-filling day (`clock.today`). Appended BEYOND `endDay` — and only
   * when it is genuinely beyond it and genuinely carries data. Never padded in:
   * an empty partial day is silence, not a zero.
   */
  partialDay?: string | null
  /** The days the data actually carries. Only consulted for `partialDay`. */
  presentDays?: Iterable<string>
}

/**
 * The axis: settled days, plus today when today has something to say.
 *
 * Returns `{ days, partialDay }` — `partialDay` is echoed back as `null` when it
 * was not admitted, so a caller can render the "today partial" key from the same
 * decision that shaped the axis rather than re-deriving it (which is how a key
 * ends up claiming a treatment the chart did not apply).
 */
export function dayAxis(input: DayAxisInput): { days: string[]; partialDay: string | null } {
  const days = denseDays(input.endDay, input.days)
  const p = input.partialDay ?? null
  if (!p || p <= input.endDay) return { days, partialDay: null }
  const present = new Set(input.presentDays ?? [])
  if (!present.has(p)) return { days, partialDay: null }
  return { days: [...days, p], partialDay: p }
}

/**
 * Densify a sparse day-keyed series onto an axis. Days on the axis with no row
 * get `zero(day)` — a MEASURED zero, which is honest because the axis only
 * carries days the caller was willing to claim.
 */
export function padOnto<T extends { day: string }>(
  rows: ReadonlyArray<T>,
  axis: ReadonlyArray<string>,
  zero: (day: string) => T,
): T[] {
  const byDay = new Map(rows.map((r) => [r.day, r]))
  return axis.map((day) => byDay.get(day) ?? zero(day))
}
