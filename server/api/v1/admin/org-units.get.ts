/*
 * GET /api/v1/admin/org-units?region={regionId} — LTREE-shaped tree
 * of org units for the admin org-units tab (design-notes §Screen 5).
 *
 * Returns rows in path order; the client renders the tree by
 * walking depth (nlevel of the LTREE path). Each row carries
 * inline counts of teammates and projects so the row label can
 * read "Practice Sigma · 32 teammates · 5 projects".
 *
 * ── OWNER DIAGNOSTICS (C8b / C8c) ─────────────────────────────────────────
 * Each owner chip carries two facts an admin previously had no way to learn:
 *
 *   `ambiguous`  — this owner owns more than one ACTIVE cost-owning unit, so
 *                  resolvePlacementViaManagerChain skips them entirely and they
 *                  place NOBODY, on either unit. Until now that looked identical
 *                  on screen to an owner that works.
 *   `places_count` — how many active teammates are currently homed in THIS unit
 *                  by a manager-chain walk that named THIS owner.
 *
 * `ambiguous` is NOT re-derived here. The owner map comes from
 * PlacementStore.loadActiveUnitOwners() — the same loader the placement workers
 * pass to the walk — and the condition is region-derivation.ts's exported
 * `resolvesToSingleUnit`, the function the walk itself calls. A second predicate
 * describing the same rule is a warning that drifts from the behaviour it warns
 * about, so there isn't one.
 *
 * `owns_unit_count` is a COUNT, not a list. It is what makes the warning
 * actionable ("they own 2 — revoke one") without naming another region's units to
 * an admin who cannot see that region.
 *
 * ── THE CATCH-ALL WARNING (C9) ────────────────────────────────────────────────
 * The region's `default` root carries `default_occupancy`: how many of its
 * occupants are, and are not, direct reports of its owner. A default unit holding
 * hundreds of people is not a placement success — it is the org tree reporting
 * which units have no owner, while every downstream report reads those people as
 * placed. Computed for that node only (see the CASE in the query), from the one
 * definition in server/db/default-unit-occupancy.ts that the occupancy endpoint's
 * cluster list also uses.
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { resolvesToSingleUnitCount } from '../../../reconciliation/region-derivation'
import {
  defaultUnitOccupancyJsonSql,
  isDefaultUnitSql,
  type DefaultUnitOccupancyCounts,
} from '../../../db/default-unit-occupancy'
import {
  GOV_DEFAULT_UNIT_WARN_THRESHOLD,
  resolveGovernanceSetting,
} from '../../../utils/governance-settings'

const Query = z.object({
  region: z.string().uuid(),
})

interface OwnerRow {
  teammate_id: string
  display_name: string | null
  email: string
  entra_oid: string
  /** Teammates in THIS unit whose chain placement named THIS owner. */
  places_count: number
}

interface NodeRow extends Record<string, unknown> {
  id: string
  parent_id: string | null
  path: string
  depth: string
  code: string
  display_name: string
  unit_type: string
  is_cost_owning_unit: boolean
  teammate_count: string
  project_count: string
  owners: OwnerRow[] | null
  is_default: boolean
  /** C9 counts, computed ONLY for the region's catch-all root (null elsewhere). */
  default_occupancy: DefaultUnitOccupancyCounts | null
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const query = await getValidated(event, Query)
  await requireRegionScope(event, query.region)

  /*
   * ONE request transaction, three reads issued concurrently
   * (docs/design/request-floor-performance.md F5; docs/design/admin-nav-
   * responsiveness.md D5). None depends on another's result: the tree reads
   * org_unit for the region in the query; owner_active_unit_counts() is
   * SECURITY DEFINER with an empty search_path and reads no current_setting
   * (mig 0111); the governance dial reads governance_setting by the same
   * query.region. postgres-js pipelines the three on the one connection and
   * answers in order — the win is issuance without per-query await gaps and
   * two fewer transactions per request, not parallelism.
   */
  const [rows, ownerUnitCounts, defaultUnitThreshold] = await withRequestRls(event, (tx) =>
    Promise.all([
      tx.execute<NodeRow>(sql`
      SELECT ou.id::text AS id,
             ou.parent_id::text AS parent_id,
             ou.path::text AS path,
             nlevel(ou.path)::text AS depth,
             ou.code,
             ou.display_name,
             ou.unit_type,
             ou.is_cost_owning_unit,
             COALESCE(tm.cnt, 0)::text AS teammate_count,
             COALESCE(pr.cnt, 0)::text AS project_count,
             own.owners,
             ${isDefaultUnitSql(sql`ou`)} AS is_default,
             -- C9. Computed only for the catch-all root: everywhere else the
             -- question "do these people report to the owner" has no fallback
             -- semantics behind it, and the per-node subquery would be paid on
             -- every row of every region's tree for an answer nothing renders.
             CASE WHEN ${isDefaultUnitSql(sql`ou`)}
                  THEN ${defaultUnitOccupancyJsonSql(sql`ou.id`)}
             END AS default_occupancy
      FROM org_unit ou
      LEFT JOIN (
        SELECT org_unit_id, COUNT(*) AS cnt FROM teammate WHERE is_active = TRUE GROUP BY org_unit_id
      ) tm ON tm.org_unit_id = ou.id
      LEFT JOIN (
        SELECT cost_owning_unit_id, COUNT(*) AS cnt FROM project GROUP BY cost_owning_unit_id
      ) pr ON pr.cost_owning_unit_id = ou.id
      LEFT JOIN (
        -- Active CC owners (J4, mig 0048) — drives the owner chips +
        -- assignment UI on the Cost centres tab.
        --
        -- places_count (C8c) is the owner's REALISED reach on this unit: active
        -- teammates homed here whose metadata.placedOwnerOid names this owner.
        -- It is counted from placement PROVENANCE, which is a record of walks
        -- that already happened — it is not a projection of what a future
        -- re-resolve would do, and the UI says so rather than implying otherwise.
        SELECT co.org_unit_id,
               jsonb_agg(jsonb_build_object(
                 'teammate_id', t.id::text,
                 'display_name', t.display_name,
                 'email', t.email,
                 'entra_oid', t.entra_oid,
                 'places_count', (
                   SELECT COUNT(*) FROM teammate p
                   WHERE p.org_unit_id = co.org_unit_id
                     AND p.is_active = TRUE
                     AND p.metadata->>'placedVia' = 'manager-chain'
                     AND p.metadata->>'placedOwnerOid' = t.entra_oid
                 )
               ) ORDER BY t.display_name NULLS LAST) AS owners
        FROM cou_owner co
        JOIN teammate t ON t.id = co.teammate_id
        WHERE co.revoked_at IS NULL
        GROUP BY co.org_unit_id
      ) own ON own.org_unit_id = ou.id
      WHERE ou.region_id = ${query.region}::uuid
        AND ou.retired_at IS NULL
      ORDER BY ou.path
    `),

      /*
       * The ambiguity counts.
       *
       * The verdict has to span regions: an owner whose SECOND unit sits in
       * another region is exactly the case this warning exists to catch, and the
       * org_unit RLS policy (mig 0098) clamps a region `admin` to their own
       * region — so a region-scoped count would report that owner as WORKING.
       *
       * Reading it on the pooled handle would get the right answer and be an RLS
       * bypass inside a handler, which scripts/check-handler-rls-context.mjs
       * exists to ratchet down; moving the same call into a helper module would
       * slip past the scanner while changing nothing. So it comes from
       * `owner_active_unit_counts()` (mig 0111, SECURITY DEFINER), called INSIDE
       * the request transaction. That function returns only (owner_oid,
       * unit_count) — never a unit id, name or region — so nothing this caller
       * could not otherwise see leaves the database, and it behaves the same
       * before and after FORCE RLS.
       */
      tx
        .execute<{ owner_oid: string; unit_count: string }>(
          sql`SELECT owner_oid, unit_count FROM owner_active_unit_counts()`,
        )
        .then((counts) => new Map([...counts].map((c) => [c.owner_oid, Number(c.unit_count)]))),

      /*
       * C9's threshold — a governance dial, resolved for THIS region (a region
       * override beats the platform baseline). Read once per request, and the
       * VERDICT is computed here rather than in the client: span of control is
       * configuration, and a client that compared against a number of its own
       * would warn at a different point than the panel behind it.
       */
      resolveGovernanceSetting(tx, GOV_DEFAULT_UNIT_WARN_THRESHOLD, query.region),
    ]),
  )

  return {
    default_unit_warn_threshold: defaultUnitThreshold,
    nodes: [...rows].map((r) => ({
      id: r.id,
      parent_id: r.parent_id,
      path: r.path,
      depth: Number(r.depth),
      code: r.code,
      display_name: r.display_name,
      unit_type: r.unit_type,
      is_cost_owning_unit: r.is_cost_owning_unit,
      teammate_count: Number(r.teammate_count),
      project_count: Number(r.project_count),
      owners: (r.owners ?? []).map((o) => {
        const ownsUnitCount = ownerUnitCounts.get(o.entra_oid) ?? 0
        /*
         * THE load-bearing test is the walk's own function. Everything below is
         * derived from its result, so the chip cannot claim a behaviour the walk
         * does not have:
         *   resolves  — resolvesToSingleUnitCount() is true; the walk places
         *               into this unit.
         *   ambiguous — it is false AND they own units, i.e. more than one: the
         *               walk cannot tell which, skips them, and they place
         *               nobody on EITHER unit. This is C8b's warning.
         *   inert     — it is false and they own none the walk can see: a
         *               bill:/provisional: placeholder oid (never appears in a
         *               manager chain), or an owner chip on a unit that is not
         *               cost-owning. Also places nobody, for a different reason
         *               and with a different fix, so it is not called ambiguous.
         *
         * The count comes from the aggregate function; the VERDICT comes from
         * the walk's own predicate, which resolvesToSingleUnit now delegates to,
         * so the two cannot disagree.
         */
        const resolves = resolvesToSingleUnitCount(ownsUnitCount)
        return {
          teammate_id: o.teammate_id,
          display_name: o.display_name,
          email: o.email,
          placement_status: resolves ? 'resolves' : ownsUnitCount > 0 ? 'ambiguous' : 'inert',
          owns_unit_count: ownsUnitCount,
          places_count: Number(o.places_count ?? 0),
        }
      }),
      is_default: r.is_default === true,
      default_occupancy: r.default_occupancy
        ? {
            occupants: Number(r.default_occupancy.occupants),
            direct_reports: Number(r.default_occupancy.direct_reports),
            not_direct_reports: Number(r.default_occupancy.not_direct_reports),
            manager_unknown: Number(r.default_occupancy.manager_unknown),
            // Above the dial, on the count we can PROVE — `manager_unknown` is
            // "we have not looked", not "they do not belong", and raising the
            // warning with it would make it loudest on the estate that has run
            // the fewest placement passes.
            warn: Number(r.default_occupancy.not_direct_reports) > defaultUnitThreshold,
          }
        : null,
    })),
  }
})
