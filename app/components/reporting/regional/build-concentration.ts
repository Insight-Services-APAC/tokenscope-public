/*
 * build-concentration — derive teammate spend-concentration stats for the shared
 * ConcentrationCard from the Regional teammate drivers.
 *
 * The Across-Regions drivers endpoint returns a server-computed `concentration`
 * block; the Regional drivers endpoint does not (it returns only the ranked rows).
 * Concentration is a pure function of the per-teammate spend, so we compute it
 * CLIENT-SIDE here from the `axis=teammate` driver rows — no new endpoint, and
 * axis-stable (the card is fed from a dedicated teammate fetch so switching the
 * table axis never blanks it).
 *
 * Shapes match the shared ConcentrationCard contract: top-1/5/10% cohort shares
 * (fractions in [0,1]) plus non-overlapping rank segments (power → light) with a
 * count each. Pure: no Vue, no DOM — unit-testable.
 *
 * NOTE: the fair home for this is a server `concentration` block on the Regional
 * drivers endpoint (mirroring Across); computing it here is the interim path that
 * keeps the card honest without reaching outside this track's files.
 */
import type { DriverRow } from '#shared/reports/types'
import type { ConcentrationStats, ConcentrationSegment } from '../ConcentrationCard.vue'

interface CohortSpec {
  label: string
  /** Inclusive lower rank fraction, exclusive upper — e.g. [0, 0.10). */
  lo: number
  hi: number
}

const COHORTS: CohortSpec[] = [
  { label: 'Power (top 10%)', lo: 0, hi: 0.1 },
  { label: 'Heavy (10–25%)', lo: 0.1, hi: 0.25 },
  { label: 'Typical (25–50%)', lo: 0.25, hi: 0.5 },
  { label: 'Light (bottom 50%)', lo: 0.5, hi: 1 },
]

/**
 * Compute concentration stats from teammate driver rows. Returns null when there
 * is no positive spend (⇒ the card is hidden). Rows need not be pre-sorted.
 */
export function buildConcentration(rows: DriverRow[]): ConcentrationStats | null {
  const ranked = rows.filter((r) => r.usd > 0).sort((a, b) => b.usd - a.usd)
  const n = ranked.length
  const total = ranked.reduce((a, r) => a + r.usd, 0)
  if (n === 0 || total <= 0) return null

  // Share of total spend held by the top `frac` of teammates (≥ 1 person).
  const topShare = (frac: number): number => {
    const k = Math.max(1, Math.ceil(frac * n))
    const sum = ranked.slice(0, k).reduce((a, r) => a + r.usd, 0)
    return sum / total
  }

  // Non-overlapping rank cohorts. `cut` clamps a rank fraction to a whole index.
  const cut = (frac: number): number => Math.min(n, Math.ceil(frac * n))
  const segments: ConcentrationSegment[] = COHORTS.map((c) => {
    const cohort = ranked.slice(cut(c.lo), cut(c.hi))
    const sum = cohort.reduce((a, r) => a + r.usd, 0)
    return { label: c.label, sharePct: sum / total, count: cohort.length }
  }).filter((s) => s.count > 0)

  return {
    top1: topShare(0.01),
    top5: topShare(0.05),
    top10: topShare(0.1),
    segments,
  }
}
