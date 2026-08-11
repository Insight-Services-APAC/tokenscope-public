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

/**
 * ONE WEEK, and the reason every daily reporting trend smooths over exactly this
 * many days. Shared so the number in the chart and the number in the key line
 * beside it cannot drift — a key reading "7-day mean" over a 5-day mean is a
 * false claim about the picture, and two independent literals is how that
 * happens.
 */
export const TRAILING_MEAN_DAYS = 7

/*
 * The w-point TRAILING MEAN of a daily series, aligned index-for-index with it.
 *
 * WHY SEVEN, WHEREVER THIS IS CALLED WITH 7. A daily working-week signal is a
 * sawtooth: the eye reads the weekend dips rather than the direction, so a
 * reader cannot tell whether spend is climbing. Seven days is exactly one week,
 * so the mean CANCELS the weekday cycle instead of blurring it — a 5- or 10-day
 * mean would still carry part of the cycle through.
 *
 * NULL UNTIL A FULL WINDOW SITS BEHIND THE POINT. The first w-1 indices get
 * `null`, and so does any index whose trailing window contains a null or a
 * non-finite value. A mean drawn from four points is inventing a trend out of
 * fewer observations than the label claims, and a partial window at the start of
 * every series is exactly where a spurious ramp appears. `w < 1` yields all
 * nulls rather than throwing: a chart may not fail to render over a bad prop.
 */
export function trailingMean(
  values: ReadonlyArray<number | null>,
  w: number,
): Array<number | null> {
  const out: Array<number | null> = []
  for (let i = 0; i < values.length; i++) {
    if (w < 1 || i < w - 1) {
      out.push(null)
      continue
    }
    let sum = 0
    let full = true
    for (let j = i - w + 1; j <= i; j++) {
      const v = values[j]
      if (v == null || !Number.isFinite(v)) {
        full = false
        break
      }
      sum += v
    }
    out.push(full ? sum / w : null)
  }
  return out
}

/*
 * The w-day trailing mean of a RATIO series, taken as Σnumerator ÷ Σdenominator
 * over the window rather than as the mean of the daily ratios.
 *
 * WHY NOT `trailingMean` OVER THE RATIOS. Spend per active developer is a ratio
 * whose denominator is zero on any day nobody worked, so the daily series has
 * genuine HOLES (`perDeveloperUsd: null`, never 0 — nobody spent nothing per
 * head; there was nobody). Averaging the daily ratios would have to either drop
 * those days, which makes a "7-day" window span more than seven days, or treat
 * them as zero, which is the claimed-zero the series deliberately refuses.
 * Summing both sides has neither problem: an empty day contributes nothing to
 * either sum and the window stays seven CALENDAR days.
 *
 * It is also the same basis the card's own deltas use (Σ spend ÷ Σ daily
 * actives, shared/reports/per-developer.ts), so the line and the figures under
 * it cannot tell different stories.
 *
 * `null` before a full window (i < w-1), and `null` for a window whose
 * denominators sum to zero — a week with nobody active has no per-head figure,
 * and 0 would assert one.
 */
export function trailingRatioMean(
  numerators: ReadonlyArray<number>,
  denominators: ReadonlyArray<number>,
  w: number,
): Array<number | null> {
  const out: Array<number | null> = []
  for (let i = 0; i < numerators.length; i++) {
    if (w < 1 || i < w - 1) {
      out.push(null)
      continue
    }
    let num = 0
    let den = 0
    for (let j = i - w + 1; j <= i; j++) {
      num += numerators[j] ?? 0
      den += denominators[j] ?? 0
    }
    out.push(den > 0 ? num / den : null)
  }
  return out
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
