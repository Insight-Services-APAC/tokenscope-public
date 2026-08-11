/*
 * GET /api/v1/admin/governance/personal-subscriptions — the reviewer's
 * month-specific view of teammate-declared personal subscriptions.
 *
 * WHY THIS EXISTS. A personal-subscription declaration (migration 0105, design
 * §4.3) is the only usage-provenance statement a teammate creates for
 * themselves. It suppresses the no-bill lane of over-emission detection for
 * that (teammate, tool), but it NEVER alters provider-backed chargeback. Until
 * this route the only surface listing a declaration was the declaring
 * teammate's own /account page. `audit_event` records every create and revoke,
 * but a reviewable statement also needs a surface.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. Read-only. There is no admin revoke, and
 * that is a decision rather than an omission: 0105 is explicit that a
 * declaration is "only ever created by an explicit teammate action", and the
 * same should hold for withdrawing one. An admin who believes a declaration is
 * wrong has a conversation, not a button. Making it revocable here would also
 * make it silently revocable, which is the failure this route exists to fix.
 *
 * RBAC: global-finops ONLY, mirroring the sibling governance-cutover route.
 * This is estate-wide governance state and it names individual teammates
 * alongside their spend, so a region admin is the wrong scope twice over.
 */
import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { getValidated } from '../../../../utils/validated-body'

/*
 * Month-aligned, like the ab-decomposition probe and for the same reason: the
 * two exposure figures below come from sources at different grains
 * (`actual_spend.date` is a bare date, `v_complete_usage.ts_event` a
 * timestamptz), and a window that splits a month compares a partial one
 * against a whole one.
 */
const querySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM (e.g. 2026-07)')
    .optional(),
})

function monthBounds(month: string): { startIso: string; endIso: string } {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const y2 = m === 12 ? y + 1 : y
  const m2 = m === 12 ? 1 : m + 1
  return {
    startIso: `${month}-01T00:00:00.000Z`,
    endIso: `${y2}-${String(m2).padStart(2, '0')}-01T00:00:00.000Z`,
  }
}

function currentMonthUtc(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export interface PersonalSubscriptionRow {
  id: string
  teammateId: string
  email: string
  displayName: string
  tool: string
  subscriptionType: string
  /** What the teammate says the subscription costs them per month. Their
   *  statement, never a figure this system charges or reconciles. */
  declaredMonthlyCostUsd: string
  declaredAt: string
  revokedAt: string | null
  activeAtMonthEnd: boolean
  /** §A usage for this (teammate, tool) in the window — the scale of what the
   *  declaration is vouching for. */
  usageUsd: string
  /**
   * Insight-paid provider spend for this (teammate, tool) in the window.
   *
   * A non-zero value can mean mixed personal and Insight-funded use of the same
   * tool, or an inaccurate declaration. It is review context only: every row
   * remains chargeable or tracked according to its provider billing unit.
   */
  providerSpendUsd: string
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'global-finops')
  const q = await getValidated(event, querySchema)
  const month = q.month ?? currentMonthUtc()
  const { startIso, endIso } = monthBounds(month)

  return withRequestRls(event, async (db) => {
    /*
     * One query, LEFT JOINed to both exposure sources, so a declaration with no
     * usage and no bill still appears. It must: a declaration covering nothing
     * is exactly the one a reviewer wants to ask about, and dropping it would
     * make the list quietly incomplete.
     *
     * Only declarations whose [declared_at, revoked_at) interval overlaps the
     * selected month are returned. Usage uses exact event timestamps. Provider
     * spend is daily, so a day that overlaps two successive declarations is
     * assigned once, to the latest declaration effective during that day.
     */
    const rows = await db.execute<{
      id: string
      teammate_id: string
      email: string
      display_name: string
      tool: string
      subscription_type: string
      monthly_cost_usd: string
      declared_at: string
      revoked_at: string | null
      usage_usd: string
      provider_usd: string
      active_at_month_end: boolean
    }>(sql`
      SELECT psd.id::text AS id,
             psd.teammate_id::text AS teammate_id,
             t.email,
             t.display_name,
             psd.tool,
             psd.subscription_type,
             psd.monthly_cost_usd::text AS monthly_cost_usd,
             psd.declared_at::text AS declared_at,
             psd.revoked_at::text AS revoked_at,
             (psd.revoked_at IS NULL OR psd.revoked_at >= ${endIso}::timestamptz) AS active_at_month_end,
             COALESCE(u.usage_usd, 0)::numeric(14,6)::text AS usage_usd,
             COALESCE(b.provider_usd, 0)::numeric(14,6)::text AS provider_usd
      FROM personal_subscription_declaration psd
      JOIN teammate t ON t.id = psd.teammate_id
      LEFT JOIN LATERAL (
        SELECT SUM(cu.cost_usd) AS usage_usd
        FROM v_complete_usage cu
        WHERE cu.teammate_id = psd.teammate_id AND cu.tool = psd.tool
          AND cu.ts_event >= GREATEST(${startIso}::timestamptz, psd.declared_at)
          AND cu.ts_event < LEAST(${endIso}::timestamptz, COALESCE(psd.revoked_at, ${endIso}::timestamptz))
      ) u ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(a.cost_usd) AS provider_usd
        FROM actual_spend a
        WHERE a.teammate_id = psd.teammate_id AND a.tool = psd.tool
          AND a.date >= ${startIso}::date AND a.date < ${endIso}::date
          AND (a.date::timestamp AT TIME ZONE 'UTC') < COALESCE(psd.revoked_at, ${endIso}::timestamptz)
          AND ((a.date + 1)::timestamp AT TIME ZONE 'UTC') > psd.declared_at
          AND psd.id = (
            SELECT candidate.id
            FROM personal_subscription_declaration candidate
            WHERE candidate.teammate_id = a.teammate_id
              AND candidate.tool = a.tool
              AND (a.date::timestamp AT TIME ZONE 'UTC') < COALESCE(candidate.revoked_at, ${endIso}::timestamptz)
              AND ((a.date + 1)::timestamp AT TIME ZONE 'UTC') > candidate.declared_at
            ORDER BY candidate.declared_at DESC, candidate.id DESC
            LIMIT 1
          )
      ) b ON TRUE
      WHERE psd.declared_at < ${endIso}::timestamptz
        AND (psd.revoked_at IS NULL OR psd.revoked_at > ${startIso}::timestamptz)
      ORDER BY (psd.revoked_at IS NOT NULL), t.email, psd.tool
    `)

    const declarations: PersonalSubscriptionRow[] = rows.map((r) => ({
      id: r.id,
      teammateId: r.teammate_id,
      email: r.email,
      displayName: r.display_name,
      tool: r.tool,
      subscriptionType: r.subscription_type,
      declaredMonthlyCostUsd: r.monthly_cost_usd,
      declaredAt: r.declared_at,
      revokedAt: r.revoked_at,
      activeAtMonthEnd: r.active_at_month_end,
      usageUsd: r.usage_usd,
      providerSpendUsd: r.provider_usd,
    }))

    const activeAtMonthEnd = declarations.filter((d) => d.activeAtMonthEnd)
    const sum = (xs: string[]) => xs.reduce((a, v) => a + Number(v), 0).toFixed(6)

    return {
      month,
      window: { startIso, endIso },
      declarations,
      totals: {
        effectiveCount: declarations.length,
        activeAtMonthEndCount: activeAtMonthEnd.length,
        endedDuringMonthCount: declarations.length - activeAtMonthEnd.length,
        effectiveUsageUsd: sum(declarations.map((d) => d.usageUsd)),
        effectiveProviderSpendUsd: sum(declarations.map((d) => d.providerSpendUsd)),
        providerBackedCount: declarations.filter((d) => Number(d.providerSpendUsd) !== 0).length,
      },
    }
  })
})
