/*
 * unit-owner-eligibility — WHICH cou_owner rows the manager-chain walk can
 * actually place through, as ONE expression.
 *
 * WHY IT IS A CONTROL, NOT A CONVENIENCE. Two surfaces answer "is this person's
 * manager an owner of this unit", and they must answer it the same way:
 *
 *   - the WALK, via PlacementStore.loadActiveUnitOwners → the owner map
 *     resolvePlacementViaManagerChain climbs. It is what actually places people.
 *   - the C9 CATCH-ALL WARNING (server/db/default-unit-occupancy.ts), which counts
 *     the occupants of a default unit who are NOT their owner's direct reports,
 *     i.e. the people the chain could not place through that owner.
 *
 * Written twice, the warning SUPPRESSES exactly the population it exists to
 * surface. `cou_owner.revoked_at IS NULL` alone counts a `bill:`/`provisional:`
 * placeholder — an oid that can never appear in a manager chain — and an owner of
 * two active units, whom the walk treats as ambiguous and skips entirely. Both
 * place NOBODY, yet both would make their reports read as "belongs here", and the
 * warning would be quietest on exactly the misconfiguration it is for.
 *
 * TWO EXPORTS, BECAUSE THE AMBIGUITY RULE IS APPLIED AT TWO LEVELS. The row-level
 * predicate is what the loader filters on (the walk then applies
 * `resolvesToSingleUnit` to the loaded rows, in TypeScript). The oid list below
 * folds that same rule back into SQL for readers that have no map to apply it to.
 */
import { sql, type SQL } from 'drizzle-orm'
import { UNAMBIGUOUS_OWNER_UNIT_COUNT } from './region-derivation'

/**
 * A cou_owner row the walk can use: not revoked, a REAL Entra oid (the chain match
 * key — a placeholder oid can never appear in a manager chain), and a unit that can
 * still receive a placement.
 *
 * `couOwner` / `owner` / `unit` are the caller's aliases for `cou_owner`,
 * `teammate` and `org_unit`.
 */
export function eligibleUnitOwnerPredicate(couOwner: SQL, owner: SQL, unit: SQL): SQL {
  return sql`(
    ${couOwner}.revoked_at IS NULL
    AND ${owner}.entra_oid NOT LIKE 'bill:%'
    AND ${owner}.entra_oid NOT LIKE 'provisional:%'
    AND ${unit}.is_cost_owning_unit
    AND ${unit}.retired_at IS NULL
  )`
}

/**
 * The Entra oids the chain walk would actually place INTO `unitId` — eligible per
 * the predicate above AND unambiguous (owning exactly one active cost-owning unit,
 * which is `resolvesToSingleUnit`'s rule).
 *
 * The count comes from `owner_active_unit_counts()` (mig 0111, SECURITY DEFINER)
 * for the reason that function exists: an owner whose SECOND unit sits in a region
 * the caller cannot read is precisely the ambiguous case, and a region-clamped
 * count would report them as working. The function returns only
 * (owner_oid, unit_count) — no unit identity leaves the database.
 *
 * Written as an UNCORRELATED subquery so a caller can test membership per occupant
 * (`… IN (thisList)`) and still have it evaluated once for the whole scan.
 *
 * CAVEAT worth knowing: the `teammate` join is RLS-visible, so under FORCE RLS an
 * owner homed in another region drops out of this list for a region admin. That is
 * the same clamp `loadActiveUnitOwners` runs under, which is the point — the
 * warning tracks what the caller's own placement pass would do.
 */
export function placementUsableOwnerOidsSql(unitId: SQL): SQL {
  return sql`(
    SELECT o.entra_oid
    FROM cou_owner co
    JOIN teammate o ON o.id = co.teammate_id
    JOIN org_unit ou ON ou.id = co.org_unit_id
    JOIN owner_active_unit_counts() c ON c.owner_oid = o.entra_oid
    WHERE co.org_unit_id = ${unitId}
      AND ${eligibleUnitOwnerPredicate(sql`co`, sql`o`, sql`ou`)}
      AND c.unit_count = ${UNAMBIGUOUS_OWNER_UNIT_COUNT}
  )`
}
