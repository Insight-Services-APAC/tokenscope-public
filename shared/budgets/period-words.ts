/*
 * A budget period in words (#632): `[1 Aug, 1 Sep)` reads "1 to 31 Aug 2026".
 *
 * A budget period is a pair of UTC instants with an EXCLUSIVE end. People read
 * days, inclusive. The last day is the exclusive end minus one UTC day when the
 * end falls on midnight (every bound the product writes), else the end's own
 * day. All on the date string and UTC fields, never a local `Date`, so a viewer
 * west of UTC still reads "to 31 Aug" (CLAUDE.md "The clock": a day never
 * converts).
 */

import { monthShort } from '../format/month-words'

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/

/** The first UTC day of a period's start instant, `YYYY-MM-DD`, or null. */
export function firstDayOf(fromIso: string | null | undefined): string | null {
  if (!fromIso) return null
  const ms = Date.parse(fromIso)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 10)
}

/** The last day INCLUDED by an exclusive end instant, `YYYY-MM-DD`, or null when open-ended. */
export function lastDayOf(toIso: string | null | undefined): string | null {
  if (!toIso) return null
  const ms = Date.parse(toIso)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  const atMidnight =
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0
  const last = atMidnight ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1)) : d
  return last.toISOString().slice(0, 10)
}


function parts(day: string): { y: string; m: string; d: number } | null {
  const m = DAY_RE.exec(day)
  if (!m) return null
  const month = monthShort(Number(m[2]))
  if (!month) return null
  return { y: m[1]!, m: month, d: Number(m[3]) }
}

/**
 * "1 to 31 Aug 2026", "15 Aug to 14 Sep 2026", "15 Dec 2026 to 14 Jan 2027",
 * "1 Aug 2026" (one day), "From 1 Aug 2026, no end date", "Until 31 Aug 2026".
 */
export function budgetPeriodWords(fromIso: string | null | undefined, toIso: string | null | undefined): string {
  const first = firstDayOf(fromIso)
  const last = lastDayOf(toIso)
  const a = first ? parts(first) : null
  const b = last ? parts(last) : null
  if (a && !b) return `From ${a.d} ${a.m} ${a.y}, no end date`
  if (!a && b) return `Until ${b.d} ${b.m} ${b.y}`
  if (!a || !b) return 'No period set'
  if (first === last) return `${a.d} ${a.m} ${a.y}`
  if (a.y !== b.y) return `${a.d} ${a.m} ${a.y} to ${b.d} ${b.m} ${b.y}`
  if (a.m !== b.m) return `${a.d} ${a.m} to ${b.d} ${b.m} ${b.y}`
  return `${a.d} to ${b.d} ${b.m} ${b.y}`
}
