/*
 * drill-lanes — the pure dominant-lane computation behind FinanceDrill's
 * per-teammate lane badge (lane-visuals V3, r1-F7/r2-5).
 *
 * The design decision, stated mechanically: a teammate row answers "what drives
 * this person's charge" at ROW resolution — a dominant-lane BADGE (lane chip +
 * label) plus that lane's share of the row's charge, with a "+N surfaces"
 * affordance whose tooltip itemises the rest. Deliberately NOT a per-row
 * mini-stack (r1-F7): 25 rows of 4px stacks are unreadable; the badge trades
 * the proportional glance for legibility, and near-tied splits read via the
 * badge's share % + the tooltip (r2-5, accepted + named).
 *
 * Pure TS (no Vue, no DOM) so the pick/share/tooltip maths is unit-testable.
 */
import type { FinanceCouLane } from '../finance-report-types'

export interface DominantLane {
  /** Registry lane id of the row's largest lane. */
  lane: string
  label: string
  /** The dominant lane's $ — the badge's value when the share is suppressed. */
  usd: number
  /**
   * The dominant lane's share of the ROW's charge, a FRACTION in [0,1] — or
   * null when ANY lane is negative (r3-5): with a credit/adjustment lane in the
   * mix, `top.usd / chargeUsd` is no longer a share (it can exceed 1 — "142%"),
   * so the badge renders the lane + its $ WITHOUT a percentage and the "+N
   * surfaces" tooltip still itemises the rest. Never clamped — a capped fake
   * share would misread as a real proportion.
   */
  sharePct: number | null
  /** How many OTHER lanes carry a non-zero slice of this row's charge. */
  othersCount: number
  /** The other lanes, largest-first — the "+N surfaces" tooltip itemisation. */
  others: FinanceCouLane[]
}

/**
 * Pick the row's dominant lane. `lanes` arrive in canonical VENDOR_LANES order
 * (zero lanes already elided server-side); ties resolve to the earlier
 * (canonical-order) lane so the badge never flickers between equal lanes.
 * Returns null when the row has no lanes or no positive charge to take a share
 * of (a $0/credit-only row gets no badge, not a NaN share). A mixed-sign row
 * (some negative lane) keeps its badge but suppresses the share (r3-5).
 */
export function dominantLaneOf(lanes: readonly FinanceCouLane[], chargeUsd: number): DominantLane | null {
  if (lanes.length === 0 || chargeUsd <= 0) return null
  let top = lanes[0]!
  for (const l of lanes) {
    if (l.usd > top.usd) top = l
  }
  const others = lanes.filter((l) => l !== top).sort((a, b) => b.usd - a.usd)
  const hasNegative = lanes.some((l) => l.usd < 0)
  return {
    lane: top.lane,
    label: top.label,
    usd: top.usd,
    sharePct: hasNegative ? null : top.usd / chargeUsd,
    othersCount: others.length,
    others,
  }
}
