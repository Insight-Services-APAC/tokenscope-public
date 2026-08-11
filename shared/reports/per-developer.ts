/*
 * reports/per-developer — spend per ACTIVE developer, and the three deltas that
 * make it readable (docs/design/reporting-consolidation/04-prototype-delta.md §5,
 * "Everything else composes").
 *
 * WHAT THIS IS FOR. Total spend rising tells you nothing on its own. If per-head
 * is flat, the line is headcount and there is no problem to solve; if per-head is
 * climbing on flat headcount, something changed in how people work and THAT is
 * the conversation. The product has shown the numerator (spend trend) and the
 * denominator (active developers) on two separate cards for months and never
 * divided them.
 *
 * THE ONE PRINCIPLE: this creates NO query. `fetchDailyMetrics`
 * (`server/reporting/engine/usage-series.ts`) already returns daily spend AND
 * daily distinct active developers over any scope and window; this module
 * divides two figures that already exist. Keeping the division here — pure,
 * shared, dependency-free — is what makes the CSV export byte-identical to the
 * screen (build-design §2): the export calls this same function rather than
 * re-deriving the ratio.
 */

/**
 * One day of the series. `perDeveloperUsd` is `null`, never 0, on a day with no
 * active developer — a gap in the line rather than a claimed zero. Nobody spent
 * nothing per head that day; there was nobody.
 */
export interface PerDeveloperPoint {
  /** `YYYY-MM-DD` (UTC day). */
  day: string
  /** Σ §A `cost_usd` that day. */
  spendUsd: number
  /** `COUNT(DISTINCT teammate_id)` active that day. NOT additive across days. */
  activeDevelopers: number
  /** `spendUsd ÷ activeDevelopers`; `null` when nobody was active. */
  perDeveloperUsd: number | null
}

/** One delta: the trailing half against the half before it. */
export interface PerDeveloperDelta {
  /** The trailing-half figure. */
  recent: number
  /** The preceding-half figure. */
  prior: number
  /**
   * `(recent − prior) / prior` as a FRACTION (the codebase `pct()` convention —
   * do NOT pre-multiply by 100). `null` when `prior` is 0: a change from nothing
   * has no percentage, and both ∞ and 0% would be a lie about it.
   */
  deltaPct: number | null
}

/**
 * The three deltas — ONE window, THREE numerators.
 *
 * That is the whole point of stating them together. Three figures computed over
 * three different periods cannot be compared with each other, so the reader
 * could not tell which of headcount or behaviour moved. Over one window they can.
 */
export interface PerDeveloperDeltas {
  /** Σ spend ÷ Σ daily actives, each half — the same ratio the line draws. */
  perDeveloperUsd: PerDeveloperDelta
  /** MEAN distinct daily actives, each half (see {@link ACTIVE_DEVELOPERS_NOTE}). */
  activeDevelopers: PerDeveloperDelta
  /** Σ spend, each half. */
  totalSpendUsd: PerDeveloperDelta
}

export interface PerDeveloperSeries {
  /** Inclusive window bounds (`YYYY-MM-DD`) — echoed from the caller's window. */
  window: { from: string; to: string }
  points: PerDeveloperPoint[]
  /**
   * `null` when the series is shorter than the two full halves the deltas need.
   * A half computed over four days beside a half computed over thirty is not a
   * delta, and stating one anyway is the failure this guard exists to prevent.
   */
  deltas: PerDeveloperDeltas | null
  /** Days each half of {@link deltas} covers — echoed so a reader of the CSV
   *  knows what "recent" and "prior" span without re-deriving it. */
  deltaDays: number
}

/** The trailing window each half of the delta pair covers. */
export const PER_DEVELOPER_DELTA_DAYS = 30

/**
 * The caveat that MUST travel with any half-window `activeDevelopers` figure.
 *
 * Each point is that DAY's distinct count. A half-window figure is therefore a
 * MEAN of daily counts and NOT a distinct count over the half — the two are
 * different numbers (the distinct count over 30 days is larger), and only the
 * daily one is the denominator that divides the daily spend. Publishing the mean
 * under the word "developers" without this is how a reader concludes the
 * population halved when only attendance did.
 */
export const ACTIVE_DEVELOPERS_NOTE =
  'Each point is that day’s distinct active developers, so a period figure is the mean of daily counts — not the number of distinct people over the period.'

/** The `fetchDailyMetrics` row shape this module consumes (structural, so the
 *  shared layer never imports a server type). */
export interface DailyMetricLike {
  day: string
  genuineUsd: number
  activeUsers: number
}

function delta(recent: number, prior: number): PerDeveloperDelta {
  return { recent, prior, deltaPct: prior > 0 ? (recent - prior) / prior : null }
}

/**
 * Divide a `fetchDailyMetrics` series into per-head spend, and state the three
 * deltas over the SAME series.
 *
 * The halves are taken from the END of the series (`points.slice(-2n, -n)` and
 * `points.slice(-n)`), so the "recent" half is always the trailing one whatever
 * the caller's window length. Fewer than `2 × deltaDays` points ⇒ `deltas: null`
 * rather than two halves of unequal length compared as though they were equal.
 *
 * `perDeveloperUsd` per half is `Σ spend ÷ Σ daily actives`, which is the
 * quantity the daily line averages to — NOT the mean of the daily ratios, which
 * would weight a quiet day with two developers the same as a busy one with sixty.
 */
export function buildPerDeveloperSeries(
  daily: readonly DailyMetricLike[],
  window: { from: string; to: string },
  deltaDays: number = PER_DEVELOPER_DELTA_DAYS,
): PerDeveloperSeries {
  const points: PerDeveloperPoint[] = daily.map((d) => ({
    day: d.day,
    spendUsd: d.genuineUsd,
    activeDevelopers: d.activeUsers,
    perDeveloperUsd: d.activeUsers > 0 ? d.genuineUsd / d.activeUsers : null,
  }))

  if (points.length < deltaDays * 2) {
    return { window, points, deltas: null, deltaDays }
  }

  const recent = points.slice(-deltaDays)
  const prior = points.slice(-deltaDays * 2, -deltaDays)
  const sumSpend = (rows: PerDeveloperPoint[]) => rows.reduce((a, r) => a + r.spendUsd, 0)
  const sumActive = (rows: PerDeveloperPoint[]) => rows.reduce((a, r) => a + r.activeDevelopers, 0)
  const perHead = (rows: PerDeveloperPoint[]) => {
    const active = sumActive(rows)
    return active > 0 ? sumSpend(rows) / active : 0
  }

  return {
    window,
    points,
    deltaDays,
    deltas: {
      perDeveloperUsd: delta(perHead(recent), perHead(prior)),
      activeDevelopers: delta(
        sumActive(recent) / recent.length,
        sumActive(prior) / prior.length,
      ),
      totalSpendUsd: delta(sumSpend(recent), sumSpend(prior)),
    },
  }
}
