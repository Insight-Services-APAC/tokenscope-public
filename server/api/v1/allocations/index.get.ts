/*
 * GET /api/v1/allocations — the budget lines in the manager/admin scope,
 * grouped by project (#632).
 *
 * PAGED BY WHOLE PROJECTS. `limit` / `offset` count projects (a "group": one
 * scope_type + scope_id), and a page carries every budget line of its
 * projects, so the page that groups them never splits a project across two
 * pages (#632 risk 1). `total` is the number of projects in scope, a real
 * COUNT over the same scope (API-17); `total_lines` the number of lines.
 *
 * ORDER: project name (case-insensitive), then each project's lines newest
 * period first, then id, so the order is total and pages cannot repeat or skip
 * (H33).
 *
 * Each line carries its period parsed on the server (`effective_from`,
 * `effective_to`: ISO instants, null when unbounded) and `is_current`, decided
 * here: the browser never parses the range text (#632 trap 4).
 *
 * `budget_now` per project is THE budget in force, read by
 * `fetchProjectAllocations`, the reader the project page and the budget alert
 * use (#632 trap 5): one definition, not a sum the browser makes. It and
 * `is_current` read the same transaction's now(), so they agree.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../auth/rbac'
import { allocationScopePredicate } from '../../../auth/allocation-scope'
import { withRequestRls } from '../../../db/request-rls'
import { parseTstzrangeText } from '../../../utils/allocation-validation'
import { fetchProjectAllocations } from '../../../usage/consumption'

const Query = z.object({
  limit: z.coerce.number().int().positive().max(200).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
})

interface Row extends Record<string, unknown> {
  id: string
  scope_type: string
  scope_id: string
  budget_usd: string
  effective: string
  allocation_kind: string
  /* A per-developer cap is a carve-out of the pool, not part of the budget in force. */
  is_pool: boolean
  is_current: boolean
  project_code: string | null
  project_display_name: string | null
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'manager', 'admin')
  const query = await getValidatedQuery(event, (data) => Query.parse(data))

  // Rows, counts and budgets in ONE RLS transaction so they can't disagree
  // mid-flight (the admin/audit list house pattern, R2 F1).
  const { rows, total, totalLines, budgetNow } = await withRequestRls(event, async (tx) => {
    const dataRows = await tx.execute<Row>(sql`
      WITH scoped AS (
        SELECT a.id, a.scope_type, a.scope_id, a.budget_usd, a.effective,
               a.allocation_kind, a.teammate_id,
               p.code AS project_code, p.display_name AS project_display_name
        FROM allocation a
        LEFT JOIN project p ON p.id = a.scope_id AND a.scope_type = 'project'
        WHERE ${allocationScopePredicate('a')}
      ),
      grp AS (
        SELECT scope_type, scope_id,
               MIN(COALESCE(project_display_name, scope_id::text)) AS sort_name
        FROM scoped
        GROUP BY scope_type, scope_id
      ),
      page AS (
        SELECT scope_type, scope_id, sort_name
        FROM grp
        ORDER BY lower(sort_name), sort_name, scope_type, scope_id
        LIMIT ${query.limit} OFFSET ${query.offset}
      )
      SELECT s.id::text AS id,
             s.scope_type, s.scope_id::text AS scope_id,
             s.budget_usd::text AS budget_usd,
             s.effective::text AS effective,
             s.allocation_kind,
             (s.teammate_id IS NULL) AS is_pool,
             (s.effective @> now()) AS is_current,
             s.project_code,
             s.project_display_name
      FROM scoped s
      JOIN page g ON g.scope_type = s.scope_type AND g.scope_id = s.scope_id
      ORDER BY lower(g.sort_name), g.sort_name, g.scope_type, g.scope_id,
               lower(s.effective) DESC NULLS LAST, s.id
    `)
    const counts = await tx.execute<{ total: string; total_lines: string }>(sql`
      SELECT COUNT(DISTINCT (a.scope_type, a.scope_id))::text AS total,
             COUNT(*)::text AS total_lines
      FROM allocation a
      WHERE ${allocationScopePredicate('a')}
    `)
    const projectIds = [
      ...new Set([...dataRows].filter((r) => r.scope_type === 'project').map((r) => r.scope_id)),
    ]
    const budgets = await fetchProjectAllocations(tx, projectIds)
    const c = [...counts][0]
    return {
      rows: [...dataRows],
      total: Number(c?.total ?? 0),
      totalLines: Number(c?.total_lines ?? 0),
      budgetNow: budgets,
    }
  })

  const allocations = rows.map((r) => {
    const { from, to } = parseTstzrangeText(r.effective)
    return {
      ...r,
      effective_from: from,
      effective_to: to,
      /* The budget in force for this line's project (same on every line of it); null for a non-project scope. */
      project_budget_now: r.scope_type === 'project' ? (budgetNow.get(r.scope_id) ?? 0) : null,
    }
  })

  return { allocations, total, total_lines: totalLines, limit: query.limit, offset: query.offset }
})
