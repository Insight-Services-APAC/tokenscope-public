/*
 * Period labels for the reporting surfaces.
 *
 * Both functions here answer the same question — "what period do the figures
 * below actually cover?" — and both got it wrong the same way: they inferred a
 * named period (a month, a quarter) from the window's START alone, and never
 * checked where it ENDED. An open-ended range beginning on a 1st was named for
 * its first month; a range beginning on a quarter boundary was named for its
 * first quarter. In both cases the label understates the period while the
 * figures beneath it cover the whole span.
 *
 * A named period is a claim about both bounds. They live together so the next
 * one added inherits the rule rather than the bug.
 *
 * Pure, and separate from the components, because the interesting cases are
 * boundary ones that a mounted fetching container makes expensive to reach.
 */
// `#shared`, never a relative ../../../shared path: the relative form typechecks
// and passes CI but fails the production Rollup build, which CI never runs.
import type { CostCentreWindow } from '#shared/schemas/cost-centres'

/** Last day of `YYYY-MM`, as `YYYY-MM-DD`. Table-driven, with the leap rule explicit. */
function monthEnd(month: string): string | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month)
  if (!m) return null
  const year = Number(m[1])
  const mo = Number(m[2])
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!
  return `${m[1]}-${m[2]}-${String(days).padStart(2, '0')}`
}

export function monthLabel(m: string): string {
  const d = new Date(`${m}-01T00:00:00.000Z`)
  return Number.isNaN(d.getTime())
    ? m
    : d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/**
 * @param w the effective window from the response, or null/undefined before it lands
 */
export function ownerWindowLabel(w: CostCentreWindow | null | undefined): string {
  if (!w) return ''
  /*
   * `month` is set by the server only when the window is EXACTLY that whole
   * calendar month — but this module's rule is that a named period is a claim
   * about BOTH bounds, and taking `month` on trust was the one path that did
   * not honour it. A response of
   * `{month: '2026-05', from: '2026-05-01', to: '2026-06-30'}` rendered
   * "May 2026" over two months. Cross-check rather than assert the contract in
   * a comment: if the metadata disagrees with the bounds, the bounds win,
   * because they are what the figures were summed over.
   */
  if (w.month && w.from === `${w.month}-01` && w.to === monthEnd(w.month)) return monthLabel(w.month)
  /*
   * Month-to-date needs all THREE conditions, not two. "Still running and
   * starting on the 1st" is satisfied by any open-ended range that happens to
   * begin on a 1st — `from=2026-05-01&to=<future>` clamps to `2026-05-01 →
   * today`, which would render "May 2026 to date" over a window covering May,
   * June and July. The window must also END in the month it started, or the
   * label names a period the figures beneath it do not cover.
   */
  if (w.runs_to_now && w.from.endsWith('-01') && w.from.slice(0, 7) === w.to.slice(0, 7)) {
    return `${monthLabel(w.from.slice(0, 7))} to date`
  }
  return `${w.from} → ${w.to}`
}

/**
 * "Q2 2026" for a range that is EXACTLY one calendar quarter, else null so the
 * caller falls back to the raw span.
 *
 * Both bounds are checked. The earlier form tested only that `from` was the
 * first day of a quarter-starting month, so a hand-crafted
 * `from=2026-04-01&to=2026-12-31` — three quarters — was labelled "Q2 2026".
 * The period control only ever emits whole quarters, but the label is reached
 * by URL, and the fallback it documents could never fire for exactly the
 * hand-crafted ranges it was meant to catch.
 *
 * @param from inclusive first day, `YYYY-MM-DD`
 * @param to   inclusive last day, `YYYY-MM-DD`
 */
const QUARTER_START = /^(\d{4})-(01|04|07|10)-01$/
/*
 * Quarter ends are constants, not arithmetic. Deriving them with Date.UTC was
 * both unnecessary and wrong at the edges: Date.UTC maps years 0-99 to
 * 1900-1999, so `quarterLabel('0099-01-01', '0099-03-31')` returned null while
 * `('0099-01-01', '1999-03-31')` returned "Q1 0099". A lookup has no such edge.
 */
const QUARTER_END: Record<string, string> = { '01': '03-31', '04': '06-30', '07': '09-30', '10': '12-31' }

export function quarterLabel(from: string, to: string): string | null {
  /*
   * Match the WHOLE string. Slicing plus endsWith is not validation: it
   * accepted '2026-04garbage-01' as the start of Q2 2026, because slice(5,7)
   * read "04" and endsWith('-01') read the tail.
   */
  const m = QUARTER_START.exec(from)
  if (!m) return null
  const [, year, startMonth] = m
  if (to !== `${year}-${QUARTER_END[startMonth!]}`) return null
  return `Q${(Number(startMonth) - 1) / 3 + 1} ${year}`
}
