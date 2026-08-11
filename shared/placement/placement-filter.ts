/*
 * placement-filter — the three states of the Teammates worklist, as ONE list.
 *
 * Shared because the value travels the whole way through the product: a URL
 * query param on /admin/regions/:id, a request query param on
 * /api/v1/admin/teammates, a zod enum, and a segmented control. A literal at
 * each of those is four places to add a fourth state and three places to forget.
 *
 * `unplaced` is defined by the HOLDING-NODE unit_type (see holding-nodes.ts),
 * not by a code — the server owns that predicate; this module owns the vocabulary.
 */

/** all → no filter; unplaced → on a holding node; placed → anywhere else. */
export const PLACEMENT_FILTERS = ['all', 'unplaced', 'placed'] as const

export type PlacementFilter = (typeof PLACEMENT_FILTERS)[number]

export function isPlacementFilter(v: unknown): v is PlacementFilter {
  return typeof v === 'string' && (PLACEMENT_FILTERS as readonly string[]).includes(v)
}
