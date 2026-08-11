/*
 * teammate-cut — the one place that decides when the switchable DriversTable and
 * the Concentration card are asking the SAME question, and whether a payload that
 * carries its own region is the one the screen is currently showing (that region,
 * and for a drivers cut its axis too).
 *
 * The Regional container issues one drivers request for the switchable table and
 * a second, axis-fixed one for concentration. When the table's own axis IS
 * 'teammate' the two are the same URL under two different `useFetch` keys — and
 * Nuxt shares in-flight promises per KEY, so that was two network round-trips for
 * one answer. The table reads the concentration request's response instead.
 *
 * Pure (no Vue, no DOM) so the rule is unit-testable rather than only observable
 * in a browser's network tab — the same reason build-concentration.ts sits here.
 */
import type { RegionalDriversResp, RegionalTrendResp } from '../regional-report-types'
import type { BehaviourReport } from '#shared/reports/behaviour'
import type { RegionWidth } from '#shared/reports/types'

/**
 * Any Region payload that reflects back the WIDTH and the REGION it was computed
 * for. Both are required, and `width` is the half that is easy to think
 * redundant — see {@link regionOnScreen}.
 */
interface RegionScoped {
  width: RegionWidth
  region?: { id: string } | null
}

/** The drivers axis the Concentration card is always built from. */
export const TEAMMATE_AXIS = 'teammate'

/**
 * True when the switchable table's axis is the concentration card's, so the
 * table's own request would duplicate one already in flight.
 */
export function tableSharesTeammateCut(tableAxis: string): boolean {
  return tableAxis === TEAMMATE_AXIS
}

/**
 * `resp` if it was computed at the CLAMPED width AND for the region the header is
 * naming, else null. The scope half of the on-screen test, on its own — the
 * drivers cuts add an axis on top of it ({@link cutOnScreen}); the trend and
 * behaviour responses have no axis and take this directly
 * ({@link trendOnScreen}, {@link behaviourOnScreen}).
 *
 * THE WIDTH IS CHECKED FIRST, AND IT IS NOT REDUNDANT WITH THE REGION. This
 * container is only ever mounted at the single-region width (`ScopeRegion`
 * mounts `ScopeAcrossRegions` for the other), and a whole-company payload
 * carries `region: null` LEGITIMATELY. On a region → "All regions" transition
 * the heading's region and that payload's region are BOTH null, so a region-only
 * comparison returns EQUAL and every card on this page renders company-wide
 * figures under the vanishing region's name. Only `behaviourOnScreen` checked
 * this, because only `BehaviourReport` declared the field; every sibling payload
 * now carries it, so the check lives here once instead of in one caller.
 *
 * The heading is `report.region.displayName` (ScopeRegionalView) and the figures
 * beside it come from six other requests, each resolving its own scope. A `useFetch`
 * ref keeps the PREVIOUS response while the next is in flight, so after a region
 * switch those refs hold the OLD region's payloads, and rendering one under the new
 * region's name is the "wrong region under a wrong name" state the server-side
 * default-region rule exists to prevent, reached from the client side instead.
 *
 * The region comes from the PAYLOAD, never from which ref happened to hold it:
 * every endpoint that carries one sets it from its own resolved scope.
 *
 * Compared by region ID, not display name: `region.display_name` carries no unique
 * constraint (only `region.code` does), so two regions can share the heading text.
 *
 * `headingRegionId` is null/undefined until the primary report lands, and a payload
 * for a real region does not match it — during that window the header names no
 * region ('Regional'), and rendering a card under it would be a figure with no
 * stated scope. The card renders empty for the moment it takes, instead.
 */
function regionOnScreen<T extends RegionScoped>(
  resp: T | null | undefined,
  headingRegionId: string | null | undefined,
): T | null {
  if (!resp || resp.width !== 'region') return null
  return (resp.region?.id ?? null) === (headingRegionId ?? null) ? resp : null
}

/**
 * `resp` if it is the cut the screen is currently showing — BOTH the axis asked for
 * AND the region the header is naming — else null.
 *
 * EVERY drivers-derived card on the Regional screen goes through this: the switchable
 * table (below), the Concentration card and the Top-models bar. They read three
 * separate requests; nothing reconciles them afterwards.
 *
 * `resp.axis` is set from the validated `?axis=` and `resp.region` from the resolved
 * scope, both by `server/api/v1/reports/regional/drivers.get.ts` — so an axis-only
 * check would render the previous region's rows, and a region-only check the
 * previous axis' rows, under the current heading.
 */
export function cutOnScreen(
  resp: RegionalDriversResp | null | undefined,
  axis: string,
  headingRegionId: string | null | undefined,
): RegionalDriversResp | null {
  if (!resp || resp.axis !== axis) return null
  return regionOnScreen(resp, headingRegionId)
}

/**
 * The trend response the §A/§B trend cards render, or null.
 *
 * ONE request (`/reports/regional/trend`) feeds every trend-derived surface on the
 * page — the usage composition hero, its pinned donut, the §A spend trend, the §B
 * chargeback trend and the page-level lane legends built from them — so this one
 * guard covers all of them. It has no axis to match (unlike a drivers cut), only a
 * region: `trend.get.ts` returns `region: scope.region` from the same
 * `resolveRegionalScope` the primary report uses.
 *
 * Its window is deliberately DIFFERENT from the report's (a rolling ~60 days in
 * month mode), so the region is the only dimension the two payloads can be compared
 * on at all.
 *
 * WHAT IS GUARDED, stated positively because that is the checkable direction:
 * exactly the payloads that carry their own `region` and are passed through this
 * module — the drivers responses (via {@link driversForAxis} /
 * {@link teammateCutOnScreen} / model cut), the trend response (via
 * {@link trendOnScreen}) and the behaviour response (via
 * {@link behaviourOnScreen}). Grep the call sites; that is the whole set.
 *
 * EVERYTHING ELSE ON THIS PAGE CAN STILL LAG A REGION. An earlier draft of this
 * comment enumerated the unguarded cards instead, and the list was already
 * incomplete — it named active-trend and seasonality but missed the MoM watcher,
 * whose source array only re-fires when one of its watched values CHANGES, so a
 * new region whose `genuineUsd` happens to equal the old one's leaves the prior
 * month-over-month figure on screen under the new name. An enumeration of what
 * is NOT covered invites the reader to trust it as complete; a statement of what
 * IS covered can be verified.
 *
 * Closing the rest needs `/reports/regional/active-trend` to reflect its resolved
 * scope back the way `/trend` already does, plus a region term in the MoM
 * watcher's source. (`/reports/regional/seasonality` was on that list until the
 * "When spend happens" card was deleted; this page no longer calls it.)
 */
export function trendOnScreen(
  trend: RegionalTrendResp | null | undefined,
  headingRegionId: string | null | undefined,
): RegionalTrendResp | null {
  return regionOnScreen(trend, headingRegionId)
}

/**
 * The response the switchable DriversTable renders, or null.
 *
 * Two steps, and the SECOND is the one that carries the guarantee:
 *
 * 1. Pick the ref that is *supposed* to be serving this axis — the concentration
 *    card's on the teammate axis (the table's own request is skipped there), the
 *    table's own everywhere else.
 * 2. Return it only if the RESPONSE ITSELF says it is this axis AND this region
 *    (see {@link cutOnScreen}).
 *
 * Step 2 is why a breakdown can never render under the wrong heading — wrong axis
 * or wrong region. A `useFetch` ref keeps the PREVIOUS payload while the next
 * request is in flight, and on the teammate axis the table's own request never runs
 * at all, so its ref holds whatever was showing before the switch, indefinitely.
 * Keying on which ref we read would hand that stale payload straight to the table.
 * Keying on the payload returns null instead, and the table renders empty until the
 * right answer lands.
 */
export function driversForAxis(
  tableAxis: string,
  headingRegionId: string | null | undefined,
  axisResponse: RegionalDriversResp | null | undefined,
  teammateResponse: RegionalDriversResp | null | undefined,
): RegionalDriversResp | null {
  const serving = tableSharesTeammateCut(tableAxis) ? teammateResponse : axisResponse
  return cutOnScreen(serving, tableAxis, headingRegionId)
}

/**
 * The teammate cut the Concentration card is built from, or null.
 *
 * The card reads the teammate request DIRECTLY (it is axis-fixed, so there is no
 * axis to switch), which left it outside the guard above: after a region switch it
 * would show the previous region's people under the new region's heading, beside a
 * drivers table that had correctly gone empty. Same payload, same hazard, same
 * check — {@link cutOnScreen} on the fixed teammate axis.
 */
export function teammateCutOnScreen(
  teammateResponse: RegionalDriversResp | null | undefined,
  headingRegionId: string | null | undefined,
): RegionalDriversResp | null {
  return cutOnScreen(teammateResponse, TEAMMATE_AXIS, headingRegionId)
}

/**
 * The BEHAVIOUR response the two behaviour cards render, or null.
 *
 * SAME PAYLOAD CLASS, SAME HAZARD, SAME CHECK. `/reports/region/behaviour`
 * resolves its own scope and reflects back BOTH the width it answered at and the
 * region it answered for, exactly as `/trend` does — so after a region switch its
 * `useFetch` ref holds the previous region's tier exposure and per-developer
 * series, and rendering them under the new region's heading is the same "wrong
 * region under a wrong name" state every other card on this page is guarded
 * against.
 *
 * The width check that used to live here is now in {@link regionOnScreen}, where
 * every sibling payload gets it too — this response was simply the first one
 * whose type declared the field.
 */
export function behaviourOnScreen(
  behaviour: BehaviourReport | null | undefined,
  headingRegionId: string | null | undefined,
): BehaviourReport | null {
  return regionOnScreen(behaviour, headingRegionId)
}
