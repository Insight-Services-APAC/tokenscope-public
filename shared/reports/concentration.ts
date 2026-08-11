/*
 * concentration — the pure spend-concentration maths, shared by every width.
 *
 * WHY IT IS IN `shared/` RATHER THAN BESIDE THE WHOLE-COMPANY QUERY. Both
 * reporting widths draw a Concentration card, and they get their per-teammate
 * costs from different places: the whole-company width from a server block on
 * the drivers response, the Region width computed CLIENT-SIDE from the
 * `axis=teammate` driver rows (the regional drivers endpoint returns no
 * concentration block).
 *
 * While the maths lived server-side, the client had to reimplement it — and it
 * had already diverged: the regional path cut its cohorts with `Math.ceil` where
 * this one uses `Math.max(1, Math.round(...))`, so the two widths answered "what
 * share does the top 10% hold" with different arithmetic. Nobody could see it,
 * because the two cards also had different shapes and different labels.
 *
 * One definition, imported by both. That is the whole point of the file.
 */
export type ConcentrationSegmentKey = 'power' | 'heavy' | 'typical' | 'light'

export interface ConcentrationSegmentStat {
  key: ConcentrationSegmentKey
  label: string
  /** Users in the segment. */
  count: number
  /** Σ cost held by the segment. */
  totalUsd: number
  /** Segment total ÷ company total, a FRACTION in [0,1]. */
  sharePct: number
  /** totalUsd ÷ count. */
  avgUsd: number
  /** The segment's median per-teammate cost. */
  medianUsd: number
}

/**
 * One band of the DECILE partition the Concentration card renders — "Top 1%",
 * "Next 9%", "Next 40%", "Bottom 50%".
 *
 * DISTINCT FROM {@link ConcentrationSegmentStat}, which is the AEUF 5/15/55/25
 * cut with people-nouns ("Power users"). These two are not interchangeable and
 * neither is redundant: the AEUF segments answer "what kind of user is this",
 * the deciles answer "how few people does the spend sit with". The card that
 * asks the second question cannot be built from the first, because 5/15/55/25
 * cannot be re-cut into 1/9/40/50 after the fact.
 */
/** The stable machine name of a cohort band — never the display copy. */
export type ConcentrationCohortKey = 'top1' | 'next9' | 'next40' | 'bottom50'

export interface ConcentrationCohortStat {
  /**
   * Bind selectors, test ids and any persistence to THIS, not to `label`.
   * The label is copy and has already been re-worded once; a machine name that
   * changes when the wording does is not an identifier.
   */
  key: ConcentrationCohortKey
  /** "Top 1%" / "Next 9%" / "Next 40%" / "Bottom 50%" — display copy only. */
  label: string
  /** Teammates in this cohort. The four counts PARTITION `activeUsers` exactly. */
  count: number
  /** Σ cost held by the cohort. The four totals sum to `totalUsd` exactly. */
  totalUsd: number
  /** Cohort total ÷ `totalUsd`, a FRACTION in [0,1]. */
  sharePct: number
}

export interface ConcentrationStats {
  activeUsers: number
  totalUsd: number
  /** Share of company spend held by the top 1% of teammates, a FRACTION in [0,1]. */
  top1: number
  /** Top 5% cohort share. */
  top5: number
  /** Top 10% cohort share. */
  top10: number
  /**
   * The cohort's OWN median per-teammate cost — the whole population's, not a
   * segment's. Computed over every row the cohort query returned (never a
   * truncated top-N list, which would report a high percentile as a median).
   * 0 when the cohort is empty.
   */
  medianUsd: number
  segments: ConcentrationSegmentStat[]
  /**
   * The decile partition (Top 1% / Next 9% / Next 40% / Bottom 50%) the
   * Concentration card renders. Cut at the SAME indices `top1` and `top10` are
   * cut at, so `cohorts[0].sharePct === top1` and
   * `cohorts[0].sharePct + cohorts[1].sharePct === top10` hold EXACTLY — the
   * card and the Median-per-person KPI publish one distribution, not two that
   * agree by luck. Empty when the cohort is empty.
   */
  cohorts: ConcentrationCohortStat[]
}

const SEGMENT_LABELS: Record<ConcentrationSegmentKey, string> = {
  power: 'Power users',
  heavy: 'Heavy users',
  typical: 'Typical users',
  light: 'Light users',
}

/**
 * PURE concentration/segment math over a DESCENDING array of per-teammate month
 * costs (build-design §5). Concentration cohorts use `k = max(1, round(N×p))`
 * for p ∈ {0.01, 0.05, 0.10}. Segments use the AEUF cut-points — top 5% (power),
 * next 15% (heavy), middle 55% (typical), bottom 25% (light) — sized by the SAME
 * `max(1, round(N×p))` guard, with avg + median per segment. Median mirrors AEUF
 * exactly: the costs sorted ASC, index `floor(len/2)` — applied to the WHOLE
 * cohort for `medianUsd` and to each slice for its own `medianUsd`.
 *
 * `cohorts` is a THIRD cut of the same ranked array — the decile partition
 * (Top 1% / Next 9% / Next 40% / Bottom 50%) the Concentration card renders,
 * cut at the same indices as `top1`/`top10` so the card and the KPI percentiles
 * are arithmetically the same distribution. It partitions the population
 * exactly; the AEUF `segments` do too, but at different boundaries and for a
 * different question. Neither is derived from the other.
 */
export function computeConcentration(costsDesc: number[]): ConcentrationStats {
  const n = costsDesc.length
  const total = costsDesc.reduce((a, c) => a + c, 0)
  if (n === 0 || total <= 0) {
    return {
      activeUsers: n,
      totalUsd: total,
      top1: 0,
      top5: 0,
      top10: 0,
      medianUsd: 0,
      segments: [],
      cohorts: [],
    }
  }

  /** The cut INDEX for a top-p cohort — the one definition `top1`/`top10` and
   *  the decile cohorts below both cut at, so they cannot drift apart. */
  const cutAt = (p: number): number => Math.max(1, Math.round(n * p))

  const topShare = (p: number): number => {
    const s = costsDesc.slice(0, cutAt(p)).reduce((a, c) => a + c, 0)
    return s / total
  }

  /*
   * The decile partition, cut at the SAME indices as the percentiles above.
   *
   * The bounds are CUMULATIVE cut points, not four independently rounded counts:
   * rounding each band's width separately (round(n×.01) + round(n×.09) +
   * round(n×.40) + round(n×.50)) overshoots — at n=207 it yields 2+19+83+104=208
   * people, one more than exist. Slicing at the cut points instead makes the four
   * counts partition `n` exactly and the four totals sum to `total` exactly, which
   * is what lets the card state "N of M" without the parts contradicting the whole.
   *
   * A band is EMITTED EVEN WHEN EMPTY-BY-ROUNDING is not the rule — a zero-width
   * band is dropped, because a legend entry reading "Next 9% · 0 people · 0%" is
   * noise at small n rather than information.
   */
  const k1 = cutAt(0.01)
  const k10 = cutAt(0.1)
  const k50 = cutAt(0.5)
  /*
   * `key` is the STABLE machine identifier; `label` is display copy and has
   * already changed once this week. Selectors, test ids and any future
   * persistence bind to the key, so re-wording a band cannot break them — and
   * a label carrying a space and a '%' makes an awkward selector besides.
   */
  const cohortBands: { key: ConcentrationCohortKey; label: string; from: number; to: number }[] = [
    { key: 'top1', label: 'Top 1%', from: 0, to: k1 },
    { key: 'next9', label: 'Next 9%', from: k1, to: k10 },
    { key: 'next40', label: 'Next 40%', from: k10, to: k50 },
    { key: 'bottom50', label: 'Bottom 50%', from: k50, to: n },
  ]
  const cohorts: ConcentrationCohortStat[] = cohortBands
    .filter((b) => b.to > b.from)
    .map((b) => {
      const rows = costsDesc.slice(b.from, b.to)
      const sum = rows.reduce((a, c) => a + c, 0)
      return { key: b.key, label: b.label, count: rows.length, totalUsd: sum, sharePct: sum / total }
    })

  const nPower = Math.max(1, Math.round(n * 0.05))
  const nHeavy = Math.max(1, Math.round(n * 0.15))
  const nLight = Math.max(1, Math.round(n * 0.25))
  const typicalEnd = n - nLight
  const slices: { key: ConcentrationSegmentKey; rows: number[] }[] = [
    { key: 'power', rows: costsDesc.slice(0, nPower) },
    { key: 'heavy', rows: costsDesc.slice(nPower, nPower + nHeavy) },
    { key: 'typical', rows: costsDesc.slice(nPower + nHeavy, typicalEnd) },
    { key: 'light', rows: costsDesc.slice(typicalEnd) },
  ]

  const segments: ConcentrationSegmentStat[] = slices.map((s) => {
    const count = s.rows.length
    const sum = s.rows.reduce((a, c) => a + c, 0)
    const asc = [...s.rows].sort((a, b) => a - b)
    const medianUsd = count > 0 ? asc[Math.floor(count / 2)]! : 0
    return {
      key: s.key,
      label: SEGMENT_LABELS[s.key],
      count,
      totalUsd: sum,
      sharePct: total > 0 ? sum / total : 0,
      avgUsd: count > 0 ? sum / count : 0,
      medianUsd,
    }
  })

  // The WHOLE cohort's median, same AEUF convention as the per-segment one.
  const allAsc = [...costsDesc].sort((a, b) => a - b)
  return {
    activeUsers: n,
    totalUsd: total,
    top1: topShare(0.01),
    top5: topShare(0.05),
    top10: topShare(0.1),
    medianUsd: allAsc[Math.floor(n / 2)]!,
    segments,
    cohorts,
  }
}
