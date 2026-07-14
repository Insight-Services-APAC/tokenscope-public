/*
 * GET /api/v1/me/cost-centres — the P&L-owner view (J3, mig 0048).
 *
 * One card per cost-owning unit the caller OWNS (active cou_owner row):
 * the projects whose lead CC it is, each with MTD burn vs allocation,
 * velocity, PM names, and cross-CC member composition; CC-level totals
 * on top. "What do I own and what's it burning" on one response.
 *
 * Authz is the RELATIONSHIP, not the role: any teammate with active
 * ownership rows gets their centres; everyone else gets an empty list
 * (200, not 403 — the nav uses total to decide whether to show the
 * entry point). App-layer gate via getOwnedCostCentreIds — RLS is inert
 * at runtime until Epic 10 (see server/auth/org-roles.ts).
 *
 * Aggregate-only reads, bounded by owned-CC count × their project count.
 */
import { defineEventHandler, getQuery } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { activeProjectPredicate } from '../../../db/project-predicates'
import { exhaustionDate } from '../../../usage/projections'
import {
  fetchMtdSpend,
  fetchProjectAllocation,
  fetchProjectVelocity,
} from '../../../usage/consumption'
import {
  GOV_VELOCITY_SPIKE_THRESHOLD,
  loadGovernanceSettingResolver,
} from '../../../utils/governance-settings'
import type { CostCentreCard, CostCentreProject } from '../../../../shared/schemas/cost-centres'

interface CouRow extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  region_code: string
  region_id: string
}

interface ProjectRow extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  type: string
  wbs_code: string | null
  end_date: string | null
  ended: boolean
  member_count: string
  cross_cou_member_count: string
  managers: string[] | null
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  // R1 F9: the nav probe only needs the count — serve it without the
  // P&L aggregation (one indexed lookup, owner or not).
  const countOnly = getQuery(event).count === '1'

  return await withRequestRls(event, async (tx) => {
    if (countOnly) {
      const rows = await tx.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n
        FROM cou_owner co
        JOIN org_unit ou ON ou.id = co.org_unit_id
        WHERE co.teammate_id = ${session.teammateId}::uuid
          AND co.revoked_at IS NULL
          AND ou.retired_at IS NULL
      `)
      return { cost_centres: [], total: Number([...rows][0]?.n ?? 0) }
    }

    // Single join on the ownership relation — no id-array round-trip.
    const cous = await tx.execute<CouRow>(sql`
      SELECT ou.id::text AS id, ou.code, ou.display_name, r.code AS region_code,
             ou.region_id::text AS region_id
      FROM cou_owner co
      JOIN org_unit ou ON ou.id = co.org_unit_id
      JOIN region r ON r.id = ou.region_id
      WHERE co.teammate_id = ${session.teammateId}::uuid
        AND co.revoked_at IS NULL
        AND ou.retired_at IS NULL
      ORDER BY ou.display_name
    `)
    if ([...cous].length === 0) {
      return { cost_centres: [], total: 0 }
    }

    // Spike-threshold dial (mig 0049): one snapshot per request, applied
    // per COST CENTRE's region (R1 F2 — the subject's region decides the
    // bar; ownership can be cross-region).
    const thresholdFor = await loadGovernanceSettingResolver(tx, GOV_VELOCITY_SPIKE_THRESHOLD)

    const now = new Date()
    const cards: CostCentreCard[] = []
    for (const cou of [...cous]) {
      // Lead projects of this CC, with member composition. A member's HOME
      // CC is their nearest cost-owning ancestor; home <> lead = cross-CC.
      const projRows = await tx.execute<ProjectRow>(sql`
        SELECT
          p.id::text AS id, p.code, p.display_name, p.type, p.wbs_code,
          p.end_date::text AS end_date,
          (NOT ${activeProjectPredicate('p')}) AS ended,
          (SELECT COUNT(DISTINCT pa.teammate_id) FROM project_assignment pa
            WHERE pa.project_id = p.id AND pa.effective @> now())::text AS member_count,
          (SELECT COUNT(DISTINCT pa.teammate_id)
            FROM project_assignment pa
            JOIN teammate t ON t.id = pa.teammate_id
            JOIN org_unit tou ON tou.id = t.org_unit_id
            LEFT JOIN LATERAL (
              SELECT cou2.id FROM org_unit cou2
              WHERE cou2.path @> tou.path AND cou2.is_cost_owning_unit
                AND cou2.region_id = tou.region_id
              ORDER BY nlevel(cou2.path) DESC LIMIT 1
            ) home ON TRUE
            WHERE pa.project_id = p.id AND pa.effective @> now()
              -- R1 F8: NULL home = UNHOMED (no cost-owning ancestor), not
              -- cross-CC — don't inflate the cross count with config gaps.
              AND home.id IS NOT NULL
              AND home.id IS DISTINCT FROM p.cost_owning_unit_id)::text AS cross_cou_member_count,
          (SELECT array_agg(COALESCE(t.display_name, t.email) ORDER BY t.display_name)
            FROM project_assignment pa
            JOIN teammate t ON t.id = pa.teammate_id
            WHERE pa.project_id = p.id AND pa.role = 'manager'
              AND pa.effective @> now()) AS managers
        FROM project p
        WHERE p.cost_owning_unit_id = ${cou.id}::uuid
        ORDER BY p.code
      `)

      const projects: CostCentreProject[] = await Promise.all(
        [...projRows].map(async (m) => {
          const [mtd, allocation, velocity] = await Promise.all([
            fetchMtdSpend(tx, 'project', m.id),
            fetchProjectAllocation(tx, m.id),
            fetchProjectVelocity(tx, m.id, thresholdFor(cou.region_id)),
          ])
          return {
            id: m.id,
            code: m.code,
            display_name: m.display_name,
            type: m.type,
            wbs_code: m.wbs_code,
            end_date: m.end_date,
            ended: m.ended,
            member_count: Number(m.member_count),
            cross_cou_member_count: Number(m.cross_cou_member_count),
            managers: m.managers ?? [],
            mtd_cost_usd: mtd.toFixed(2),
            allocation_usd: allocation.toFixed(2),
            utilisation: allocation > 0 ? Number((mtd / allocation).toFixed(4)) : null,
            projected_exhaustion_date: exhaustionDate(mtd, allocation, now),
            velocity,
          }
        }),
      )

      const mtdTotal = projects.reduce((s, p) => s + Number(p.mtd_cost_usd), 0)
      const allocTotal = projects.reduce((s, p) => s + Number(p.allocation_usd), 0)
      // Distinct people across the CC's projects (a member on two projects
      // counts once at CC level).
      const memberTotals = await tx.execute<{ members: string; cross: string }>(sql`
        SELECT
          COUNT(DISTINCT pa.teammate_id)::text AS members,
          COUNT(DISTINCT pa.teammate_id) FILTER (
            WHERE home.id IS NOT NULL AND home.id IS DISTINCT FROM ${cou.id}::uuid
          )::text AS cross
        FROM project_assignment pa
        JOIN project p ON p.id = pa.project_id
        JOIN teammate t ON t.id = pa.teammate_id
        JOIN org_unit tou ON tou.id = t.org_unit_id
        LEFT JOIN LATERAL (
          SELECT cou2.id FROM org_unit cou2
          WHERE cou2.path @> tou.path AND cou2.is_cost_owning_unit
            AND cou2.region_id = tou.region_id
          ORDER BY nlevel(cou2.path) DESC LIMIT 1
        ) home ON TRUE
        WHERE p.cost_owning_unit_id = ${cou.id}::uuid AND pa.effective @> now()
      `)
      const totals = [...memberTotals][0]

      cards.push({
        id: cou.id,
        code: cou.code,
        display_name: cou.display_name,
        region_code: cou.region_code,
        project_count: projects.length,
        member_count: Number(totals?.members ?? 0),
        cross_cou_member_count: Number(totals?.cross ?? 0),
        mtd_cost_usd: mtdTotal.toFixed(2),
        allocation_usd: allocTotal.toFixed(2),
        utilisation: allocTotal > 0 ? Number((mtdTotal / allocTotal).toFixed(4)) : null,
        projects,
      })
    }

    return { cost_centres: cards, total: cards.length }
  })
})
