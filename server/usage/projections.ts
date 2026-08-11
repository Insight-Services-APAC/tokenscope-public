/*
 * Pure spend projections (brief §6.4) — no DB, no clock side-effects
 * beyond the caller-supplied `now`. Shared by the consumption and project
 * endpoints; unit-tested in consumption-runrate.test.ts.
 */
export interface RunRate {
  projected_month_end_usd: string
  days_elapsed: number
  days_in_month: number
  method: 'linear-mtd'
  /**
   * FALSE on the last day of the month, where `days_in_month / days_elapsed`
   * is 1 and the "projection" is the month-to-date figure relabelled. A card
   * that says "on pace for ~$X by month end" on day 31 of 31 is telling the
   * reader nothing they cannot read off the headline; the flag lets the UI
   * withhold the forecast for that day.
   *
   * SCOPE OF THE CLAIM: it says one thing — no useful linear projection today.
   * It goes false at 00:00 UTC on the final day, with that whole day's spend
   * still to land, so copy driven by it may state that no projection is shown
   * and that the figure is month-to-date. Anything stronger (a "month total",
   * a "final" figure, "nothing left to project") is false for ~24 hours.
   */
  is_projection: boolean
}

/** AEUF's run-rate (billing.py:486): mtd × days_in_month / days_elapsed. */
export function runRate(mtdUsd: number, now: Date): RunRate {
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate()
  const daysElapsed = now.getUTCDate()
  const projected = daysElapsed > 0 ? (mtdUsd * daysInMonth) / daysElapsed : mtdUsd
  return {
    projected_month_end_usd: projected.toFixed(2),
    days_elapsed: daysElapsed,
    days_in_month: daysInMonth,
    method: 'linear-mtd',
    is_projection: daysElapsed > 0 && daysElapsed < daysInMonth,
  }
}

/**
 * Where this month's spend stands against a quota — as a STATE, not as a date
 * that has to be read for what it is not.
 *
 * `exhaustionDate` below answers the same question with `string | null`, which
 * forces "already exhausted" to be encoded as TODAY'S date. The UI then renders
 * it through the only copy a date supports — "on pace to exhaust your quota
 * ~2026-07-31" — while the quota was in fact passed weeks ago at 2.2x. It is
 * not on pace to be exhausted; it IS exhausted, and the reader is owed the past
 * tense and the amount they are over by (ADR 0012 defect 3).
 *
 * `exhausted` deliberately carries the OVERAGE and not a back-projected "you
 * passed it around the 14th": the overage is arithmetic on two figures the
 * reader can see, whereas the date would be a linear back-extrapolation dressed
 * up as a fact.
 */
export type QuotaProjection =
  /** No quota to measure against (no allowance, no allocation). */
  | { state: 'no-quota' }
  /** A quota, but nothing spent against it yet — no pace to project from. */
  | { state: 'no-spend' }
  /** Already past the quota. `over_usd` = spend − quota, both visible to the reader. */
  | { state: 'exhausted'; over_usd: string }
  /** On this month's pace the quota runs out on `date`, inside this month. */
  | { state: 'projected'; date: string }
  /** Spending, but this month's pace does not reach the quota before the month ends. */
  | { state: 'not-at-this-pace' }

/**
 * Quota-exhaustion projection: at the MTD daily burn rate, does spend reach the
 * quota BEFORE this month ends?
 *
 * DAY SEMANTICS, stated here so the next reader does not re-derive them:
 *
 *   - `daysElapsed` is the DAY OF THE MONTH, so MTD spend is the running total
 *     at the END of that day: after N whole days, spend is N x `dailyRate`.
 *   - The quota is therefore reached DURING day `ceil(daysToExhaust)`. Ten $10
 *     increments against a $100 quota exhaust it on day 10, not day 11.
 *   - Day D of the month begins at `monthStart + (D - 1)` days, so the day the
 *     quota runs out is `monthStart + (ceil(daysToExhaust) - 1)` days. Adding
 *     `daysToExhaust` to `monthStart` directly was the off-by-one: it named the
 *     start of the day AFTER the one the quota is exhausted on.
 *   - `mtdUsd < quotaUsd` by the time the arithmetic runs (the `exhausted`
 *     branch returned above), so `ceil(daysToExhaust) > daysElapsed`: a
 *     `projected` date is always still ahead of the caller's `now`.
 *
 * Capped at month-end deliberately: both the numerator (MTD spend) and the
 * monthly view reset at the month boundary, so a date in a future month is
 * meaningless — projecting an annual budget's "exhaustion" into next quarter
 * read as a confidently-wrong date. `not-at-this-pace` is the honest signal the
 * UI renders as comfortable.
 */
export function quotaProjection(
  mtdUsd: number,
  quotaUsd: number,
  now: Date,
): QuotaProjection {
  if (quotaUsd <= 0) return { state: 'no-quota' }
  if (mtdUsd <= 0) return { state: 'no-spend' }
  if (mtdUsd >= quotaUsd) return { state: 'exhausted', over_usd: (mtdUsd - quotaUsd).toFixed(2) }
  const daysElapsed = now.getUTCDate()
  if (daysElapsed <= 0) return { state: 'not-at-this-pace' }
  const dailyRate = mtdUsd / daysElapsed
  const daysToExhaust = quotaUsd / dailyRate
  /*
   * The day of the month the quota runs out ON — see DAY SEMANTICS above.
   *
   * The half-cent guard is load-bearing, not defensive noise. `daysToExhaust`
   * is a quotient of two quotients, so an answer that is exactly an integer in
   * decimal often is not in binary: 100.23 / (33.41 / 1) evaluates to
   * 3.0000000000000004, and a bare `ceil` turns "the quota is gone at the end
   * of day 3" into day 4 — the exact off-by-one the DAY SEMANTICS block above
   * exists to fix, reintroduced by the fix for it. The same input at
   * 300.60 / (10.02 / 1) pushes the date past the month end and silently
   * downgrades a `projected` warning to `not-at-this-pace`, so the developer
   * is told nothing at all.
   *
   * Tolerance is half a cent because these are 2dp money amounts: any real
   * shortfall is at least a whole cent, and float error at these magnitudes is
   * ~1e-10. So this rounds down only when the previous day's projected spend
   * already covers the quota to a precision finer than money has.
   */
  const ceiled = Math.ceil(daysToExhaust)
  const exhaustDayOfMonth =
    (ceiled - 1) * dailyRate >= quotaUsd - 0.005 ? ceiled - 1 : ceiled
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const projected = monthStart + (exhaustDayOfMonth - 1) * 86_400_000
  // First instant of next month (UTC) — a day at or past it is not a day of
  // this month, and the projection is moot there.
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  if (projected >= nextMonth) return { state: 'not-at-this-pace' }
  return { state: 'projected', date: new Date(projected).toISOString().slice(0, 10) }
}

/**
 * The date-shaped view of {@link quotaProjection}, kept for the surfaces that
 * still render a bare date (the project cards, the project page, the
 * cost-centre cards). It keeps the lossy "already exhausted → today" encoding,
 * which is exactly why the personal consumption surface reads the state instead.
 *
 * One implementation, two projections of it: a second copy of the arithmetic is
 * how the two would come to disagree about the same month. That shared
 * implementation is also why the day-semantics correction above moves the dates
 * these five surfaces render one day earlier — intended, and the point of
 * having one implementation.
 */
export function exhaustionDate(
  mtdUsd: number,
  allocationUsd: number,
  now: Date,
): string | null {
  const p = quotaProjection(mtdUsd, allocationUsd, now)
  if (p.state === 'exhausted') return now.toISOString().slice(0, 10)
  return p.state === 'projected' ? p.date : null
}
