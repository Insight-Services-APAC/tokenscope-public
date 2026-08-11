/*
 * Clock-relative dates for the archive/cold-fallback tests.
 *
 * WHY THIS EXISTS. Both suites previously hardcoded `COLD = 2026-04-15` and
 * `HOT = 2026-06-10` against `hotDays: 30`, with a comment conceding the test
 * "relies on now() > ~2026-06". That is a window, and the real clock walks out
 * of it: once the wall clock passed ~2026-07-10 the HOT row was older than 30
 * days, so the worker archived it and the "hot data untouched" assertion read
 * 0 instead of 5. Both suites then failed on `main` and on every branch, every
 * day, until someone edited the constants — and the failure looks like a
 * regression in whatever PR happens to be open.
 *
 * The offsets below are chosen so the classification holds on ANY date:
 *
 *   HOT  = now − 5d   — always well inside a 30-day hot window.
 *   COLD = now − 75d  — always older than 30 days, so its whole month is cold;
 *                       and always inside the rollup's 90-day backfill, which
 *                       the cold assertions depend on.
 *
 * The gap also guarantees COLD and HOT land in different calendar months (75−5
 * = 70 days apart), which the partition assertions require. And COLD's month
 * ENDS between 45 and 75 days before now, so the whole partition is cold rather
 * than merely its first day — the worker archives per partition, not per row.
 */

const DAY_MS = 86_400_000

function iso(d: Date): string {
  return d.toISOString()
}

/** `YYYY-MM-DD` for the first day of that date's month, UTC. */
function monthStart(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

/** `YYYY-MM-DD` for the first day of the FOLLOWING month, UTC — the exclusive upper bound. */
function nextMonthStart(d: Date): string {
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  return monthStart(n)
}

export interface ArchiveWindow {
  /** A cold emit timestamp: older than any sane hot window, inside the 90d backfill. */
  cold: string
  /** A hot emit timestamp: comfortably inside a 30-day hot window. */
  hot: string
  /** The partition the cold rows land in, e.g. `attribution_record_2026_05`. */
  coldPartition: string
  /** Inclusive lower bound of the cold month, `YYYY-MM-DD`. */
  coldMonthStart: string
  /** EXCLUSIVE upper bound of the cold month — also the archive watermark after a drop. */
  coldMonthEnd: string
  /** Inclusive lower bound of the hot month, for "hot data untouched" assertions. */
  hotMonthStart: string
}

export function archiveWindow(now: Date = new Date()): ArchiveWindow {
  const coldDate = new Date(now.getTime() - 75 * DAY_MS)
  const hotDate = new Date(now.getTime() - 5 * DAY_MS)
  const y = coldDate.getUTCFullYear()
  const m = String(coldDate.getUTCMonth() + 1).padStart(2, '0')

  return {
    cold: iso(new Date(Date.UTC(y, coldDate.getUTCMonth(), coldDate.getUTCDate(), 12, 0, 0))),
    hot: iso(
      new Date(
        Date.UTC(hotDate.getUTCFullYear(), hotDate.getUTCMonth(), hotDate.getUTCDate(), 12, 0, 0),
      ),
    ),
    coldPartition: `attribution_record_${y}_${m}`,
    coldMonthStart: monthStart(coldDate),
    coldMonthEnd: nextMonthStart(coldDate),
    hotMonthStart: monthStart(hotDate),
  }
}
