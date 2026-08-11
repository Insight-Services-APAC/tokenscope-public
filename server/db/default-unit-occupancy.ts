/*
 * default-unit-occupancy — "how many people in this unit do NOT belong to it",
 * as ONE definition (spec C9).
 *
 * WHY THIS IS A WARNING AND NOT A STATISTIC. A region's `default` unit is the
 * catch-all the manager-chain walk lands on when it climbs past a report's own
 * manager and finds no nearer owner. Its EXPECTED occupants are roughly the
 * direct reports of its owner. Everyone else is there because some unit below is
 * missing an owner — and today every report downstream reads them as "placed".
 * A default unit holding hundreds of people is the org tree telling you which
 * units have no owner, dressed up as a success.
 *
 * THE THREE BUCKETS PARTITION THE OCCUPANTS, and the third one is why this is not
 * a two-way split:
 *
 *   directReports    their captured manager is an owner of this unit THE CHAIN
 *                    WALK COULD PLACE THEM THROUGH (server/reconciliation/
 *                    unit-owner-eligibility.ts — the same definition the walk's
 *                    own owner map is built from, ambiguity rule included) —
 *                    they belong here.
 *   notDirectReports their captured manager is NOT (including "no manager at
 *                    all", which is nobody's direct report) — the warning, and
 *                    the number that must shrink as the admin assigns owners.
 *   managerUnknown   no manager has ever been captured for them. NOT counted as
 *                    "does not belong": we have not looked. Counting an
 *                    un-looked-up person as misplaced would make the warning
 *                    largest on the estate that knows least about itself, and it
 *                    would never shrink by fixing anything. It shrinks by
 *                    RUNNING a placement pass, which is a different action, and
 *                    the UI asks for that one instead.
 *
 * The manager comes from the directory snapshot the placement lanes capture from
 * the chain walk's own first hop (server/reconciliation/directory-snapshot.ts) —
 * never a live Graph read, which at a few hundred occupants would be a few
 * hundred requests per page load.
 *
 * ONE DEFINITION, TWO CALLERS: the org-unit tree renders the counts inline and
 * the occupancy endpoint groups the same people into manager clusters. Both build
 * their SQL from here, so the number on the row and the number you get when you
 * open it cannot disagree.
 */
import { sql, type SQL } from 'drizzle-orm'
import { placementUsableOwnerOidsSql } from '../reconciliation/unit-owner-eligibility'

/**
 * The reserved code of a region's root org unit — the catch-all.
 *
 * Structural AND naming test together, matching
 * server/auth/org-subtree-scope.ts::placedBelowRegionRootPredicate: a region root
 * is parentless, and since `regions.post.ts` reserves the code, it is also always
 * `default`. Either alone has a false positive (an admin-created root-level BU;
 * a non-root unit coded 'default' in another region) that the conjunction does
 * not.
 */
export const DEFAULT_UNIT_CODE = 'default'

/** Is this org_unit row the region's catch-all root? `alias` is the table alias. */
export function isDefaultUnitSql(alias: SQL): SQL {
  return sql`(${alias}.parent_id IS NULL AND ${alias}.code = ${DEFAULT_UNIT_CODE})`
}

/**
 * True when this teammate's captured manager is an owner of `unitId` THAT THE
 * CHAIN WALK COULD ACTUALLY PLACE THEM THROUGH.
 *
 * Not "has an unrevoked cou_owner row" — that is a laxer test than placement's,
 * and being laxer here is not conservative, it is backwards. It would count a
 * `bill:`/`provisional:` placeholder oid (which can never appear in a manager
 * chain) and an owner of two active units (whom the walk treats as ambiguous and
 * skips), classifying their reports as "belongs here" while the walk places none
 * of them — the warning would go quietest on the misconfiguration it exists to
 * report. The list comes from placementUsableOwnerOidsSql, which is built from
 * the same predicate PlacementStore.loadActiveUnitOwners filters on plus
 * `resolvesToSingleUnit`'s rule.
 *
 * NULL-safe by construction: an uncaptured or absent manager is a NULL on the left
 * of `IN`, so the test is never true. Uncorrelated on the right, so the owner list
 * is computed once per query rather than per occupant.
 */
function managerIsOwnerOfSql(teammate: SQL, unitId: SQL): SQL {
  return sql`(${teammate}.metadata->'directory'->>'managerOid' IN ${placementUsableOwnerOidsSql(unitId)})`
}

/** Has a manager ever been captured for this teammate? (Key present, value may be NULL.) */
function managerCapturedSql(teammate: SQL): SQL {
  return sql`(${teammate}.metadata->'directory' ? 'managerOid')`
}

/**
 * A scalar subquery yielding the four counts as jsonb, for `unitId`. Use inline
 * in a SELECT list (the tree) or on its own (the detail endpoint).
 */
export function defaultUnitOccupancyJsonSql(unitId: SQL): SQL {
  const t = sql`t`
  const captured = managerCapturedSql(t)
  const isOwnersReport = managerIsOwnerOfSql(t, unitId)
  return sql`(
    SELECT jsonb_build_object(
      'occupants',          COUNT(*),
      'direct_reports',     COUNT(*) FILTER (WHERE ${captured} AND ${isOwnersReport}),
      'not_direct_reports', COUNT(*) FILTER (WHERE ${captured} AND NOT ${isOwnersReport}),
      'manager_unknown',    COUNT(*) FILTER (WHERE NOT ${captured})
    )
    FROM teammate t
    WHERE t.org_unit_id = ${unitId} AND t.is_active = TRUE
  )`
}

/** The shape `defaultUnitOccupancyJsonSql` produces. */
export interface DefaultUnitOccupancyCounts {
  occupants: number
  direct_reports: number
  not_direct_reports: number
  manager_unknown: number
}

/**
 * The manager CLUSTERS behind `notDirectReports` — "12 report to Lee Hughes".
 *
 * This is the to-do list, not the scold: each row is one concrete next action
 * (make that manager an owner of the unit their team belongs to, or place the
 * cluster directly), and each one the admin does subtracts itself from the
 * warning above. Ordered biggest-first because that is the order that shrinks
 * the number fastest.
 *
 * The manager's display name is resolved from `teammate` when they are one this
 * caller can read, and falls back to the email captured alongside the oid — a
 * manager in another region is invisible under the region RLS clamp, and a
 * cluster labelled with a bare oid is not an action.
 *
 * ── WHY THE MANAGER'S OWN UNIT COUNT COMES BACK WITH IT ───────────────────────
 * The action this list asks for is "make that manager an owner". If the manager
 * ALREADY owns an active cost-owning unit, doing so gives them two — which is the
 * ambiguous case: the walk cannot tell which unit a report belongs to, skips them
 * entirely, and they place nobody on EITHER unit. The advice would then create the
 * exact failure the C8b warning exists to flag, and would silently break the unit
 * they already own. So the count travels with the cluster and the UI only offers
 * the action where the result stays unambiguous. It comes from
 * `owner_active_unit_counts()` (mig 0111) because the disqualifying second unit
 * may sit in a region this caller cannot read.
 */
export function defaultUnitManagerClustersSql(unitId: SQL, limit: number): SQL {
  const t = sql`t`
  return sql`
    SELECT t.metadata->'directory'->>'managerOid' AS manager_oid,
           MAX(t.metadata->'directory'->>'managerEmail') AS manager_email,
           MAX(m.display_name) AS manager_display_name,
           COALESCE(MAX(c.unit_count), 0)::text AS manager_owns_unit_count,
           COUNT(*)::text AS people
    FROM teammate t
    LEFT JOIN teammate m ON m.entra_oid = t.metadata->'directory'->>'managerOid'
    LEFT JOIN owner_active_unit_counts() c ON c.owner_oid = t.metadata->'directory'->>'managerOid'
    WHERE t.org_unit_id = ${unitId}
      AND t.is_active = TRUE
      AND ${managerCapturedSql(t)}
      AND NOT ${managerIsOwnerOfSql(t, unitId)}
    GROUP BY t.metadata->'directory'->>'managerOid'
    ORDER BY COUNT(*) DESC, 1
    LIMIT ${limit}
  `
}
