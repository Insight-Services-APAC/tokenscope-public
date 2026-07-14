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
  }
}

/**
 * Allocation-exhaustion projection: at the MTD daily burn rate, does spend
 * reach the allocation BEFORE this month ends? Returns the projected date,
 * or null when it won't exhaust this month.
 *
 * Capped at month-end deliberately: both the numerator (MTD spend) and the
 * monthly view reset at the month boundary, so a date in a future month is
 * meaningless — projecting an annual budget's "exhaustion" into next quarter
 * read as a confidently-wrong date. null past month-end is the honest "not
 * at this pace" signal the UI renders as comfortable.
 */
export function exhaustionDate(
  mtdUsd: number,
  allocationUsd: number,
  now: Date,
): string | null {
  if (allocationUsd <= 0 || mtdUsd <= 0) return null
  if (mtdUsd >= allocationUsd) return now.toISOString().slice(0, 10) // already exhausted
  const daysElapsed = now.getUTCDate()
  if (daysElapsed <= 0) return null
  const dailyRate = mtdUsd / daysElapsed
  const daysToExhaust = allocationUsd / dailyRate
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const projected = monthStart + daysToExhaust * 86_400_000
  // First instant of next month (UTC) — beyond it the projection is moot.
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  if (projected >= nextMonth) return null
  return new Date(projected).toISOString().slice(0, 10)
}

