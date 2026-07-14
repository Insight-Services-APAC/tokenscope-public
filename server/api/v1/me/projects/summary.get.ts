/*
 * GET /api/v1/me/projects/summary — project CARDS for the /projects index
 * (brief §5.6): one card per project the caller is currently a member of,
 * with MTD burn vs allocation, run-rate exhaustion, velocity flag, and end
 * state. Ended projects with a current assignment stay visible (post-mortem
 * view) — unlike the tag-picker (/me/projects), which excludes them.
 *
 * Aggregate-only reads; bounded by the caller's membership count.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { activeProjectPredicate } from '../../../../db/project-predicates'
import type { ProjectCard } from '../../../../../shared/schemas/usage'
import {
  fetchMtdSpend,
  fetchProjectAllocation,
  fetchProjectVelocity,
} from '../../../../usage/consumption'
import { exhaustionDate } from '../../../../usage/projections'
import {
  GOV_VELOCITY_SPIKE_THRESHOLD,
  loadGovernanceSettingResolver,
} from '../../../../utils/governance-settings'

interface MembershipRow extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  type: string
  wbs_code: string | null
  end_date: string | null
  ended: boolean
  member_count: string
  region_id: string
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)

  return await withRequestRls(event, async (tx) => {
    const memberships = await tx.execute<MembershipRow>(sql`
      SELECT p.id::text AS id, p.code, p.display_name, p.type, p.wbs_code,
             p.end_date::text AS end_date,
             p.region_id::text AS region_id,
             (NOT ${activeProjectPredicate('p')}) AS ended,
             (SELECT COUNT(DISTINCT pa2.teammate_id) FROM project_assignment pa2
               WHERE pa2.project_id = p.id AND pa2.effective @> now())::text AS member_count
      FROM project p
      JOIN project_assignment pa ON pa.project_id = p.id
      WHERE pa.teammate_id = ${session.teammateId}::uuid
        AND pa.effective @> now()
      ORDER BY p.code
    `)

    // Spike-threshold dial (mig 0049): one snapshot per request, applied
    // per PROJECT region (R1 F2/F3 — the subject's region decides the
    // bar, never the viewer's; memberships can be cross-region).
    const thresholdFor = await loadGovernanceSettingResolver(tx, GOV_VELOCITY_SPIKE_THRESHOLD)

    const now = new Date()
    const cards: ProjectCard[] = await Promise.all(
      [...memberships].map(async (m) => {
        const [mtd, allocation, velocity] = await Promise.all([
          fetchMtdSpend(tx, 'project', m.id),
          fetchProjectAllocation(tx, m.id),
          fetchProjectVelocity(tx, m.id, thresholdFor(m.region_id)),
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
          mtd_cost_usd: mtd.toFixed(2),
          allocation_usd: allocation.toFixed(2),
          utilisation: allocation > 0 ? Number((mtd / allocation).toFixed(4)) : null,
          projected_exhaustion_date: exhaustionDate(mtd, allocation, now),
          velocity,
        }
      }),
    )

    return { projects: cards, total: cards.length }
  })
})
