/*
 * GET /api/v1/rollups/finance/{couId}/export — CSV export for a
 * single cost-owning unit (design-notes §Screen 6 per-row CSV).
 *
 * Same shape as the breakdown endpoint but rendered as CSV with
 * Content-Disposition. csvEscape() on every cell per the
 * security-audit lesson.
 */
import { defineEventHandler, createError, getValidatedQuery, setHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { csvEscape } from '../../../../../utils/csv-escape'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { monthStartIso } from '../../../../../utils/period'

const Query = z.object({
  period: z.enum(['prior', 'mtd', 'q1']).default('mtd'),
})

function rangeForPeriod(period: 'prior' | 'mtd' | 'q1'): {
  start: string
  end: string
  label: string
} {
  const now = new Date()
  if (period === 'mtd') {
    const start = monthStartIso(now)
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    return { start, end: end.toISOString(), label: start.slice(0, 7) }
  }
  if (period === 'prior') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    return { start: start.toISOString(), end: end.toISOString(), label: start.toISOString().slice(0, 7) }
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), 3, 1))
  return { start: start.toISOString(), end: end.toISOString(), label: `${now.getUTCFullYear()}-Q1` }
}

interface ProjectRow extends Record<string, unknown> {
  project_id: string | null
  project_code: string | null
  project_display_name: string | null
  wbs_code: string | null
  dev_count: string
  total_cost_usd: string
}

interface CouRow extends Record<string, unknown> {
  cou_code: string
  cou_display_name: string
  region_id: string
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const couId = requireUuidParam(event, 'couId')
  const query = await getValidatedQuery(event, (data) => Query.parse(data))
  const range = rangeForPeriod(query.period)

  return await withRequestRls(event, async (tx) => {
    const couRows = await tx.execute<CouRow>(sql`
      SELECT code AS cou_code, display_name AS cou_display_name,
             region_id::text AS region_id
      FROM org_unit WHERE id = ${couId}::uuid
    `)
    const cou = [...couRows][0]
    if (!cou) {
      throw createError({ statusCode: 404, statusMessage: 'CoU not found' })
    }
    // Region-bound the caller to the CoU's region (admin → own region
    // only; global-finops unbounded). RLS is inert at runtime, so this
    // app-level check is the live gate against cross-region CoU export.
    await requireRegionScope(event, cou.region_id)

    // BILL-ANCHORED (mig 0059): per-project charge = the bill split (overlay) homed
    // to this CoU; tokens are the OTel volume signal (merged from the reportable
    // view, which carries no bill scaling but is the only per-project token source).
    const startDate = range.start.slice(0, 10)
    const endDate = range.end.slice(0, 10)
    const rows = await tx.execute<ProjectRow>(sql`
      SELECT o.project_id::text AS project_id,
             p.code AS project_code,
             p.display_name AS project_display_name,
             p.wbs_code,
             COUNT(DISTINCT o.teammate_id)::text AS dev_count,
             COALESCE(SUM(o.charge_usd), 0)::text AS total_cost_usd
      FROM v_finance_project_overlay o
      JOIN project p ON p.id = o.project_id
      WHERE o.cost_owning_unit_id = ${couId}::uuid
        AND o.period_date >= ${startDate}::date
        AND o.period_date <  ${endDate}::date
      GROUP BY o.project_id, p.code, p.display_name, p.wbs_code
      ORDER BY SUM(o.charge_usd) DESC NULLS LAST
    `)
    const tokenRows = await tx.execute<{ project_id: string; total_tokens: string }>(sql`
      SELECT project_id::text AS project_id, COALESCE(SUM(tokens), 0)::text AS total_tokens
      FROM v_finance_reportable_spend
      WHERE cost_owning_unit_id = ${couId}::uuid
        AND project_id IS NOT NULL
        AND occurred_at >= ${range.start}::timestamptz
        AND occurred_at <  ${range.end}::timestamptz
      GROUP BY project_id
    `)
    const tokensByProject = new Map([...tokenRows].map((r) => [r.project_id, r.total_tokens]))

    // wbs_code sits next to project_code so a finance analyst can join the
    // export straight onto the finance-system record (the field's purpose).
    const csvLines = [
      'cou_code,cou_display_name,project_code,project_display_name,wbs_code,dev_count,total_tokens,total_cost_usd',
      ...[...rows].map((r) =>
        [
          csvEscape(cou.cou_code),
          csvEscape(cou.cou_display_name),
          csvEscape(r.project_code ?? ''),
          csvEscape(r.project_display_name ?? ''),
          csvEscape(r.wbs_code ?? ''),
          r.dev_count,
          r.project_id ? (tokensByProject.get(r.project_id) ?? '0') : '0',
          r.total_cost_usd,
        ].join(','),
      ),
    ]
    setHeader(event, 'content-type', 'text/csv; charset=utf-8')
    setHeader(
      event,
      'content-disposition',
      `attachment; filename="tokenscope-cou-${cou.cou_code}-${range.label}.csv"`,
    )
    return csvLines.join('\n') + '\n'
  })
})
