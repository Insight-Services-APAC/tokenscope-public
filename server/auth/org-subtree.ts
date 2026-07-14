/*
 * org-subtree — the region-clamped "ids under this path" subquery used to scope
 * spend over an org_unit SUBTREE (the practice rollup's usage / bill / trend
 * lanes). The `SELECT id FROM org_unit WHERE path <@ <path> AND region_id = …`
 * body had been hand-written at each call-site; the region clamp is load-bearing
 * (org_unit paths are only unique PER region, org-units.post.ts) so dropping it
 * leaks a colliding subtree from another region — hence one definition.
 *
 * This is the runtime-value form (the caller passes a resolved `path` /
 * `regionId`), distinct from the GUC-driven predicates in org-subtree-scope.ts.
 */
import { sql, type SQL } from 'drizzle-orm'

/**
 * The `SELECT id FROM org_unit WHERE path <@ <path>::ltree AND region_id =
 * <regionId>::uuid [AND is_cost_owning_unit = TRUE]` subquery, for use inside an
 * `<col> IN ( … )` scope predicate.
 *
 * @param path      ltree path of the subtree root (a resolved value, bound).
 * @param regionId  region uuid the subtree is clamped to (bound).
 * @param opts.costOwningOnly  also require `is_cost_owning_unit = TRUE` (the
 *        bill lane homes to cost-owning units only).
 */
export function orgSubtreeIds(
  path: string,
  regionId: string,
  opts: { costOwningOnly?: boolean } = {},
): SQL {
  const costOwning = opts.costOwningOnly ? sql` AND is_cost_owning_unit = TRUE` : sql``
  return sql`SELECT id FROM org_unit WHERE path <@ ${path}::ltree AND region_id = ${regionId}::uuid${costOwning}`
}
