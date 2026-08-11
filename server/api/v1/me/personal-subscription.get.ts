/*
 * GET /api/v1/me/personal-subscription — my own active personal-subscription
 * declarations (ADR-0011 D3/D4, design §4.3). Self-service, teammate-scoped.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'

interface Row extends Record<string, unknown> {
  id: string
  tool: string
  subscription_type: string
  monthly_cost_usd: string
  declared_at: string
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  return withRequestRls(event, async (db) => {
    const rows = await db.execute<Row>(sql`
      SELECT id::text AS id, tool, subscription_type, monthly_cost_usd::text AS monthly_cost_usd,
             declared_at::text AS declared_at
      FROM personal_subscription_declaration
      WHERE teammate_id = ${session.teammateId}::uuid AND revoked_at IS NULL
      ORDER BY tool
    `)
    return {
      declarations: rows.map((r) => ({
        id: r.id,
        tool: r.tool,
        subscriptionType: r.subscription_type,
        monthlyCostUsd: Number(r.monthly_cost_usd),
        declaredAt: r.declared_at,
      })),
    }
  })
})
