/*
 * chart-utils — tiny helpers shared by the reporting chart kit.
 *
 * `escapeHtml` matters: ECharts HTML tooltips are built by returning a string
 * that ECharts injects as innerHTML. Series / slice names can originate from
 * provider output, so any name interpolated into a tooltip string MUST be
 * escaped (dataviz interaction.md: labels are untrusted data). Numeric values
 * come from our own formatters and are safe.
 */

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Sorted union of the x-values across a set of {x} point arrays. String sort
 *  is correct for the `YYYY-MM-DD` day keys these charts plot. */
export function categoryUnion(seriesData: ReadonlyArray<ReadonlyArray<{ x: string }>>): string[] {
  const set = new Set<string>()
  for (const arr of seriesData) for (const p of arr) set.add(p.x)
  return [...set].sort()
}

/** Trim a leading `YYYY-` from an ISO day so axis ticks read `MM-DD`; anything
 *  that isn't a `YYYY-MM-DD` string is returned unchanged. */
export function shortDay(x: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(x) ? x.slice(5) : x
}

/** Relabel an ISO week key `YYYY-Www` → its Monday date `DD MMM` (UTC) for a
 *  legible, year-unambiguous seasonality x-axis (`W27` collides across years);
 *  anything that isn't an ISO week is returned unchanged. Jan 4th is always in
 *  ISO week 1. Shared so both scopes' heatmaps label weeks identically. */
export function isoWeekLabel(isoWeek: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek)
  if (!m) return isoWeek
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4))
  const jan4Dow = (jan4.getUTCDay() + 6) % 7 // 0 = Monday
  const week1Monday = jan4.getTime() - jan4Dow * 86_400_000
  const monday = new Date(week1Monday + (Number(m[2]) - 1) * 7 * 86_400_000)
  return monday.toLocaleString('en-US', { day: '2-digit', month: 'short', timeZone: 'UTC' })
}
