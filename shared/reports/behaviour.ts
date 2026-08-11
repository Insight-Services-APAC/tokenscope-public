/*
 * reports/behaviour — the response contract for the two BEHAVIOUR cards
 * (docs/design/reporting-consolidation/04-prototype-delta.md §5, order items 5
 * and 6): "Behavioural exposure" and "Spend per active developer".
 *
 * WHY ONE RESPONSE FOR TWO CARDS. They are the two cards in the prototype's
 * rolling band that answer "what changed in how people work", and they are drawn
 * over the SAME window — the trailing 60 days, decoupled from the month picker
 * the KPI band uses. Serving them from one call is what guarantees the two cards
 * on screen were computed over one window: two endpoints could be fetched a
 * second apart, across a UTC midnight, and disagree about which days they cover.
 *
 * The per-developer half creates NO query — `fetchDailyMetrics` already returns
 * daily spend and daily distinct actives, and `buildPerDeveloperSeries` divides
 * them (shared/reports/per-developer.ts).
 */
import type { PerDeveloperSeries } from './per-developer'
import type { TierExposure } from './tier-exposure'
import type { RegionWidth } from './types'

export interface BehaviourReport {
  /** Inclusive window bounds (`YYYY-MM-DD`) BOTH cards were computed over. */
  window: { from: string; to: string }
  /**
   * The WIDTH this response was computed at — `all-regions` (whole company) or
   * `region` (one region's clamp). Set from the resolved scope, never echoed
   * from the query.
   */
  width: RegionWidth
  /**
   * The region this response was COMPUTED for; `null` at the whole-company width
   * (and only there).
   *
   * DECLARED SO THE CLIENT CAN REJECT A LAGGING PAYLOAD. The handler has always
   * returned it; the type did not, so the Regional container had nothing to
   * compare and handed the ref straight to the view. A `useFetch` ref keeps the
   * PREVIOUS response while the next is in flight, so after a region switch this
   * is the previous region's exposure and per-developer figures — rendered under
   * the new region's heading, beside drivers cards that had correctly gone empty
   * (`app/components/reporting/regional/teammate-cut.ts`).
   */
  region: { id: string; code: string; displayName: string } | null
  /**
   * §B — billed spend against consumption, banded by `model_catalog.tier`.
   * NEVER summed with `perDeveloper`, which is §A usage (contract C2): the two
   * cards sit in one band on screen and answer different questions from
   * different lanes.
   */
  exposure: TierExposure
  /** §A — daily spend ÷ daily distinct active developers, plus three deltas. */
  perDeveloper: PerDeveloperSeries
}
