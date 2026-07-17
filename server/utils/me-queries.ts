/*
 * Shared "me"-scoped read queries.
 *
 * These pure functions are the single source of truth for the developer's
 * own usage / projects / activity-vocabulary reads. They take an explicit
 * caller identity (teammateId / regionId / role) plus a transaction handle
 * with the RLS GUCs already set, so they can be driven from EITHER:
 *
 *   - the REST endpoints (`/api/v1/me/*`, `/api/v1/projects/search`), via
 *     `withRequestRls(event, (tx) => ...)` using the cookie session; OR
 *   - the MCP tools (`/api/mcp`), via `withRlsContext(db, ctx, (tx) => ...)`
 *     using the OAuth-bearer-resolved teammate.
 *
 * Extracted from the endpoints verbatim (behaviour-preserving) so the MCP
 * surface reuses the exact same SQL — no second copy to drift. The endpoints
 * keep ownership of request parsing / response shaping; only the query bodies
 * moved here.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { activeProjectPredicate, endedProjectExpr } from '../db/project-predicates'
import { oauthScopeLabel } from '../../shared/oauth-scopes'
import {
  NON_CODE_CLAUDE_TOOLS,
  toolLabel,
  type NonCodeClaudeTool,
} from '../../shared/usage/surface'
import { GITHUB_USAGE_TOOLS } from '../../shared/usage/github-surface'
import { laneListSql, toolToVendor, VENDOR_LABELS } from '../../shared/usage/vendor'
import { monthStartIso as monthStartIsoFor } from './period'

type Tx = PostgresJsDatabase<Record<string, unknown>>

const ACTIVE_NOW_WINDOW_MINUTES = 30

// ── usage ────────────────────────────────────────────────────────────────

interface BucketRow extends Record<string, unknown> {
  project_code: string
  display_name: string
  cost_usd: string
  tokens: string
  allocation_total_usd: string
  allocation_mode: string
  is_active_now: boolean
  source: 'assigned' | 'contributed' | 'both'
  ended: boolean
  /** Distinct clients (e.g. claude-code, copilot-cli) that contributed this month. */
  tools: string[] | null
}

export interface UsageBucket {
  project_code: string
  display_name: string
  cost_usd: string
  tokens: number
  allocation_total_usd: string
  allocation_mode: string
  is_active_now: boolean
  source: 'assigned' | 'contributed' | 'both'
  ended: boolean
  /** Distinct contributing clients this month (for the per-project brand marks). */
  tools: string[]
}

export interface TaggedSpend {
  activity: string
  cost_usd: string
  tokens: number
  sessions: number
  /** Distinct contributing clients for this activity (for the brand marks). */
  tools: string[]
}

/**
 * Unallocated (no project budget) spend for the month, split tagged-by-activity
 * ("spill") vs genuinely-untagged ("needs tagging"). Accurate, month-scoped, and
 * UNCAPPED — the single source the dashboard's unallocated/tagged cards consume,
 * replacing the prior client-side composition off the LIMIT-100, all-time
 * /me/sessions/untagged list.
 */
export interface UnallocatedSummary {
  total_cost_usd: string
  total_tokens: number
  tagged_cost_usd: string
  untagged_cost_usd: string
  needs_tagging_count: number
  soft_cap_usd: string
  over_soft_cap: boolean
}

/** One day of a non-Code surface's bill (== usage: pure-metered Anthropic). */
export interface SurfaceDaySpend {
  day: string // 'YYYY-MM-DD' (UTC); gap days are absent, charts pad
  usd: string
}

/**
 * §B display-only (#142): the requester's month-to-date spend on ONE non-Code
 * Claude surface (Chat / Cowork / Office / Chrome / Design / Slack / other),
 * from `actual_spend` — the provider bill IS the usage for pure-metered
 * Anthropic. No rate card, no attribution_record, no sessions: these lanes are
 * chargeback-only and NEVER taggable (the UI renders them read-only).
 */
export interface SurfaceSpend {
  tool: NonCodeClaudeTool
  label: string
  mtd_usd: string
  days: SurfaceDaySpend[]
}

export interface UsageSummary {
  month_to_date: string
  total_cost_usd: string
  total_tokens: number
  total_allocation_usd: string
  base_allowance_usd: string
  total_quota_usd: string
  buckets: UsageBucket[]
  unallocated: UnallocatedSummary
  tagged_spend: TaggedSpend[]
  /** Non-Code Claude surface spend (§B, read-only) — zero surfaces elided. */
  surfaces: SurfaceSpend[]
  freshness_minutes_ago: number
  note: string
}

/**
 * The developer's current-month-to-date project bucket split (cost, tokens,
 * allocation, activity) plus the additive-quota summary. Extracted from
 * GET /api/v1/me/usage — identical SQL and response shape.
 */
export async function getMyUsage(tx: Tx, teammateId: string, now: Date = new Date()): Promise<UsageSummary> {
  const monthStartIso = monthStartIsoFor(now)
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const monthEndIso = monthEnd.toISOString()
  const activeCutoff = new Date(now.getTime() - ACTIVE_NOW_WINDOW_MINUTES * 60_000).toISOString()

  const rows = await tx.execute<BucketRow>(
    sql`
      -- candidate projects: union of assigned-to-user AND contributed-by-user-this-month
      WITH user_project AS (
        -- ASSIGNMENT lane — gated on end_date (D5): an open assignment to an
        -- ENDED project must NOT keep a $0 bucket in "My usage" (the reported
        -- leak). Ended projects with real pre-end spend still surface via the
        -- contributor lane below (flagged ended); ended + no spend -> no row.
        SELECT pa.project_id, TRUE AS is_assigned, FALSE AS is_contributor
          FROM project_assignment pa
          JOIN project p ON p.id = pa.project_id
         WHERE pa.teammate_id = ${teammateId}::uuid
           AND pa.effective && tstzrange(${monthStartIso}::timestamptz, ${monthEndIso}::timestamptz, '[)')
           AND ${activeProjectPredicate('p')}
        UNION ALL
        SELECT DISTINCT ar.project_id, FALSE AS is_assigned, TRUE AS is_contributor
          FROM attribution_record ar
         WHERE ar.teammate_id = ${teammateId}::uuid
           AND ar.ts_event >= ${monthStartIso}::timestamptz
        -- §A: a project the dev tagged an "unaccounted usage" day to is also a
        -- contributed bucket (its reconciled spend counts toward that budget).
        UNION ALL
        SELECT DISTINCT uu.project_id, FALSE AS is_assigned, TRUE AS is_contributor
          FROM unaccounted_usage uu
         WHERE uu.teammate_id = ${teammateId}::uuid
           AND uu.project_id IS NOT NULL
           AND uu.day >= ${monthStartIso}::date
      ),
      candidate AS (
        SELECT project_id,
               bool_or(is_assigned)    AS is_assigned,
               bool_or(is_contributor) AS is_contributor
          FROM user_project
         GROUP BY project_id
      )
      SELECT
        p.code AS project_code,
        p.display_name AS display_name,
        -- §A: project cost = OTel-attributed spend + any "unaccounted usage" days the
        -- dev tagged to this project (scalar subqueries so the LEFT JOIN above doesn't
        -- fan out rows). Keeps the bucket equal to the dev's real spend on the budget.
        (COALESCE(SUM(ar.cost_usd), 0) + COALESCE((
          SELECT SUM(uu.cost_usd) FROM unaccounted_usage uu
           WHERE uu.project_id = p.id AND uu.teammate_id = ${teammateId}::uuid
             AND uu.day >= ${monthStartIso}::date), 0))::text AS cost_usd,
        (COALESCE(SUM(ar.tokens), 0) + COALESCE((
          SELECT SUM(uu.tokens) FROM unaccounted_usage uu
           WHERE uu.project_id = p.id AND uu.teammate_id = ${teammateId}::uuid
             AND uu.day >= ${monthStartIso}::date), 0))::text AS tokens,
        COALESCE(
          (SELECT SUM(al.budget_usd)::text
             FROM allocation al
            WHERE al.scope_type = 'project'
              AND al.scope_id = p.id
              AND al.allocation_kind IN ('baseline', 'top-up')
              AND al.effective && tstzrange(${monthStartIso}::timestamptz, ${monthEndIso}::timestamptz, '[)')
              AND al.teammate_id = ${teammateId}::uuid),
          (SELECT SUM(al.budget_usd)::text
             FROM allocation al
            WHERE al.scope_type = 'project'
              AND al.scope_id = p.id
              AND al.allocation_kind IN ('baseline', 'top-up')
              AND al.effective && tstzrange(${monthStartIso}::timestamptz, ${monthEndIso}::timestamptz, '[)')
              AND al.teammate_id IS NULL),
          '0'
        ) AS allocation_total_usd,
        p.allocation_mode AS allocation_mode,
        EXISTS (
          SELECT 1
            FROM attribution_record arn
           WHERE arn.teammate_id = ${teammateId}::uuid
             AND arn.project_id = p.id
             AND arn.ts_event >= ${activeCutoff}::timestamptz
             -- §A integrity: a dev-confirmed forgery must not make a project look "active".
             AND NOT EXISTS (
               SELECT 1 FROM session_quarantine sq
               WHERE sq.teammate_id = arn.teammate_id AND sq.conversation_id = arn.claude_session_id
                 AND sq.resolved_at IS NULL AND sq.reason = 'api-uncorroborated')
        ) AS is_active_now,
        CASE
          WHEN c.is_assigned AND c.is_contributor THEN 'both'
          WHEN c.is_assigned THEN 'assigned'
          ELSE 'contributed'
        END AS source,
        -- D5: keep the bucket in the MTD aggregate (real pre-end spend), but
        -- flag it so the UI can collapse it into an "Ended" section. Dropping
        -- it would under-report the dev's month + corrupt the quota math.
        ${endedProjectExpr('p')} AS ended,
        -- Distinct contributing clients this month. LEFT JOIN → NULL when the
        -- project has an assignment but no spend; array_remove drops it so an
        -- empty bucket reports [] not [null].
        array_remove(array_agg(DISTINCT ar.tool ORDER BY ar.tool), NULL) AS tools
      FROM project p
      JOIN candidate c ON c.project_id = p.id
      LEFT JOIN attribution_record ar
        ON ar.project_id = p.id
       AND ar.teammate_id = ${teammateId}::uuid
       AND ar.ts_event >= ${monthStartIso}::timestamptz
       -- §A integrity: exclude dev-confirmed forgeries (over-emission → quarantined).
       AND NOT EXISTS (
         SELECT 1 FROM session_quarantine sq
         WHERE sq.teammate_id = ar.teammate_id AND sq.conversation_id = ar.claude_session_id
           AND sq.resolved_at IS NULL AND sq.reason = 'api-uncorroborated')
      GROUP BY p.id, p.code, p.display_name, p.allocation_mode, c.is_assigned, c.is_contributor
      ORDER BY p.code
    `,
  )

  let totalCost = 0
  let totalTokens = BigInt(0)
  let totalAllocation = 0
  for (const r of rows) {
    totalCost += Number(r.cost_usd)
    totalTokens += BigInt(r.tokens)
    totalAllocation += Number(r.allocation_total_usd)
  }

  // Freshness must reflect the teammate's MOST RECENT activity regardless of
  // project — INCLUDING unallocated spend (project_id IS NULL). The per-project
  // last_event_at above only sees rows joined to a candidate project, so a
  // teammate whose recent spend is all untagged (e.g. an unassigned device
  // dogfooding) would show an ever-staler "Updated X min ago" while their
  // unallocated total kept growing. Query teammate-wide, no project filter.
  // Intentionally NOT month-scoped (unlike the project buckets above): freshness
  // must reflect the teammate's latest activity regardless of month, so on the
  // 1st of a month "Updated X min ago" still shows their real last event rather
  // than snapping to "never". `freshness_minutes_ago` can therefore reference a
  // prior-month event — matches the pre-existing behaviour, not a regression.
  const freshRows = await tx.execute<{ last_event_at: string | null }>(
    sql`SELECT MAX(ts_event)::text AS last_event_at
          FROM attribution_record
         WHERE teammate_id = ${teammateId}::uuid`,
  )
  const lastEventAt = [...freshRows][0]?.last_event_at ?? null
  const lastEventMs = lastEventAt === null ? null : new Date(lastEventAt).getTime()

  const parsedBase = Number(process.env.NUXT_BASE_ALLOWANCE_USD)
  const baseAllowanceUsd = Number.isFinite(parsedBase) && parsedBase >= 0 ? parsedBase : 100
  const totalQuotaUsd = baseAllowanceUsd + totalAllocation

  const freshnessMinutesAgo =
    lastEventMs === null ? 0 : Math.max(0, Math.round((now.getTime() - lastEventMs) / 60_000))

  // Unallocated (no project budget) spend — month-scoped + uncapped. Extracted to
  // getUnallocatedSummary so it's the single source for the dashboard cards + CLI.
  const { unallocated, tagged_spend } = await getUnallocatedSummary(tx, teammateId, monthStartIso, baseAllowanceUsd)

  // §B (#142) — the requester's non-Code Claude surface spend, MTD, per day,
  // straight from actual_spend (bill == usage on the pure-metered Anthropic
  // lane). Filter derives from NON_CODE_CLAUDE_TOOLS — never hand-copied
  // literals — so a new surface lane lands here without touching this query.
  const surfaces = await getMySurfaceSpend(tx, teammateId, monthStartIso, monthEndIso)

  return {
    month_to_date: monthStartIso.slice(0, 7),
    total_cost_usd: totalCost.toFixed(2),
    total_tokens: Number(totalTokens),
    total_allocation_usd: totalAllocation.toFixed(2),
    base_allowance_usd: baseAllowanceUsd.toFixed(2),
    total_quota_usd: totalQuotaUsd.toFixed(2),
    buckets: [...rows].map((r) => ({
      project_code: r.project_code,
      display_name: r.display_name,
      cost_usd: Number(r.cost_usd).toFixed(2),
      tokens: Number(r.tokens),
      allocation_total_usd: Number(r.allocation_total_usd).toFixed(2),
      allocation_mode: r.allocation_mode,
      is_active_now: r.is_active_now,
      source: r.source,
      ended: r.ended,
      tools: Array.isArray(r.tools) ? r.tools : [],
    })),
    unallocated,
    tagged_spend,
    surfaces,
    freshness_minutes_ago: freshnessMinutesAgo,
    note:
      [...rows].length === 0
        ? 'No project assignments yet — ask your admin to assign you.'
        : 'Updated from attribution_record (Epic 6 OTel read path).',
  }
}

/**
 * Unallocated (no project budget) spend for the month, split tagged-by-activity
 * ("spill") vs genuinely-untagged ("needs tagging"). Aggregates per CONVERSATION
 * first (MAX(activity), matching the untagged worklist's session semantics), then
 * rolls up by activity. Month-scoped + UNCAPPED — the accurate single source the
 * dashboard's unallocated/tagged cards AND the usage MCP prompt both consume
 * (replacing the prior client-side composition off the LIMIT-100, all-time
 * /me/sessions/untagged list). Exported so the MCP surface can reuse it.
 */
export async function getUnallocatedSummary(
  tx: Tx,
  teammateId: string,
  monthStartIso: string,
  baseAllowanceUsd: number,
): Promise<{ unallocated: UnallocatedSummary; tagged_spend: TaggedSpend[] }> {
  const unallocRows = await tx.execute<{
    activity: string | null
    cost_usd: string
    tokens: string
    sessions: string
    tools: string[] | null
  }>(
    sql`
      WITH unalloc AS (
        SELECT COALESCE(ar.claude_session_id, ar.instance_id::text) AS conv,
               MAX(ar.activity) AS activity,
               MAX(ar.tool)     AS tool,
               SUM(ar.cost_usd) AS cost,
               SUM(ar.tokens)   AS tokens
          FROM attribution_record ar
         WHERE ar.teammate_id = ${teammateId}::uuid
           AND ar.project_id IS NULL
           AND ar.ts_event >= ${monthStartIso}::timestamptz
           -- §A integrity: a conversation the dev CONFIRMED as a forgery (over-emission
           -- → session_quarantine reason='api-uncorroborated') is excluded from usage.
           AND NOT EXISTS (
             SELECT 1 FROM session_quarantine sq
             WHERE sq.teammate_id = ar.teammate_id AND sq.conversation_id = ar.claude_session_id
               AND sq.resolved_at IS NULL AND sq.reason = 'api-uncorroborated')
         GROUP BY COALESCE(ar.claude_session_id, ar.instance_id::text)
        -- §A: per-day "unaccounted usage" (provider API truth OTel missed) is also
        -- unallocated spend that needs tagging — one item per (day, tool), counted
        -- like a conversation so the dashboard's needs-tagging total includes it.
        UNION ALL
        SELECT 'unaccounted:' || uu.id::text AS conv,
               uu.activity,
               uu.tool,
               uu.cost_usd AS cost,
               uu.tokens   AS tokens
          FROM unaccounted_usage uu
         WHERE uu.teammate_id = ${teammateId}::uuid
           AND uu.project_id IS NULL
           AND uu.cost_usd > 0
           AND uu.day >= ${monthStartIso}::date
      )
      SELECT activity,
             SUM(cost)::text   AS cost_usd,
             SUM(tokens)::text AS tokens,
             COUNT(*)::text    AS sessions,
             array_remove(array_agg(DISTINCT tool ORDER BY tool), NULL) AS tools
        FROM unalloc
       GROUP BY activity
    `,
  )

  let unallocCost = 0
  let unallocTokens = BigInt(0)
  let taggedCost = 0
  let untaggedCost = 0
  let needsTaggingCount = 0
  const taggedSpend: TaggedSpend[] = []
  for (const r of unallocRows) {
    const cost = Number(r.cost_usd)
    unallocCost += cost
    unallocTokens += BigInt(r.tokens)
    if (r.activity === null || r.activity === '') {
      untaggedCost += cost
      needsTaggingCount += Number(r.sessions)
    } else {
      taggedCost += cost
      taggedSpend.push({
        activity: r.activity,
        cost_usd: cost.toFixed(2),
        tokens: Number(BigInt(r.tokens)),
        sessions: Number(r.sessions),
        tools: Array.isArray(r.tools) ? r.tools : [],
      })
    }
  }
  taggedSpend.sort((a, b) => Number(b.cost_usd) - Number(a.cost_usd))

  return {
    unallocated: {
      total_cost_usd: unallocCost.toFixed(2),
      total_tokens: Number(unallocTokens),
      tagged_cost_usd: taggedCost.toFixed(2),
      untagged_cost_usd: untaggedCost.toFixed(2),
      needs_tagging_count: needsTaggingCount,
      soft_cap_usd: baseAllowanceUsd.toFixed(2),
      // >= (not >) to match the dashboard's "Over" badge threshold (>= 100% of base).
      over_soft_cap: unallocCost >= baseAllowanceUsd,
    },
    tagged_spend: taggedSpend,
  }
}

// ── non-Code Claude surfaces (§B display, #142) ────────────────────────────

/**
 * The REQUESTING teammate's month-to-date spend on the non-Code Claude
 * surfaces, per surface per day, from `actual_spend`. §B display ONLY: for
 * pure-metered Anthropic the per-(user, day) bill IS the usage, so no rate
 * card and no attribution_record are involved, and there is nothing to tag —
 * these lanes are source-incapable of sessions (excluded from §A by mig 0084).
 * Surfaces with zero MTD spend are elided; order follows the canonical
 * NON_CODE_CLAUDE_TOOLS display order.
 */
export async function getMySurfaceSpend(
  tx: Tx,
  teammateId: string,
  monthStartIso: string,
  monthEndIso: string,
): Promise<SurfaceSpend[]> {
  const laneList = sql.join(
    NON_CODE_CLAUDE_TOOLS.map((t) => sql`${t}`),
    sql.raw(', '),
  )
  const rows = await tx.execute<{ tool: string; day: string; usd: string }>(sql`
    SELECT a.tool, a.date::text AS day, SUM(a.cost_usd)::text AS usd
      FROM actual_spend a
     WHERE a.teammate_id = ${teammateId}::uuid
       AND a.date >= ${monthStartIso.slice(0, 10)}::date
       AND a.date <  ${monthEndIso.slice(0, 10)}::date
       AND a.tool IN (${laneList})
     GROUP BY a.tool, a.date
     ORDER BY a.tool, a.date
  `)
  const byTool = new Map<string, SurfaceDaySpend[]>()
  for (const r of rows) {
    const days = byTool.get(r.tool) ?? []
    days.push({ day: r.day, usd: Number(r.usd).toFixed(2) })
    byTool.set(r.tool, days)
  }
  const out: SurfaceSpend[] = []
  for (const tool of NON_CODE_CLAUDE_TOOLS) {
    const days = byTool.get(tool)
    if (!days) continue
    const mtd = days.reduce((acc, d) => acc + Number(d.usd), 0)
    if (mtd <= 0) continue // elide zero surfaces
    out.push({ tool, label: toolLabel(tool), mtd_usd: mtd.toFixed(2), days })
  }
  return out
}

// ── consumption hero (visuals-iter2 §I3) — per-basis lane series ────────────

/** One weekly bucket of a hero lane (Mon-UTC week start, matching date_trunc('week')). */
export interface HeroLaneWeek {
  week_start: string // 'YYYY-MM-DD' (Monday, UTC); gap weeks absent, client pads
  usd: string
}

/**
 * One hero lane: a registry lane id + its weekly window series and its OWN
 * calendar-MTD total — always from the lane's own source, never summed across
 * bases (§I3 / r1-F1).
 */
export interface HeroLane {
  lane: string
  label: string
  mtd_usd: string
  weekly: HeroLaneWeek[]
}

/**
 * One basis group of the /consumption hero. `basis` is the caption text the
 * UI must render verbatim beside the group — every element carries its basis
 * (axis rule a); no scalar ever sums across groups (axis rule b).
 */
export interface HeroBasisGroup {
  id: 'telemetry' | 'billed'
  label: string
  basis: string
  lanes: HeroLane[]
}

/**
 * The "What kind of AI work drove this" hero series (§I3), requester-scoped:
 *
 *   - telemetry group — §A usage lanes:
 *       'claude' (Claude Code) from attribution_aggregate (the SAME source and
 *       window predicate as the page's daily series, so weekly Σ == daily Σ by
 *       construction — the grain-conservation test pins it);
 *       'copilot' + 'copilot-agent' from v_teammate_usage_daily's copilot
 *       branch (reconciliation_record per-(user, day) usage truth, mig 0086).
 *   - billed group — §B display of the non-Code Claude surfaces, straight from
 *     actual_spend (bill == usage on the pure-metered Anthropic lane), exactly
 *     the getMySurfaceSpend source.
 *
 * Zero lanes are elided EXCEPT 'claude' (the page's primary lane — an empty
 * month must still render the group, not a blank card). actual_spend /
 * reconciliation_record carry no RLS policy of their own: the explicit
 * teammate_id predicate IS the scope gate (the getMySurfaceSpend pattern).
 */
export async function getMyConsumptionHero(
  tx: Tx,
  teammateId: string,
  windowDays: number,
  now: Date = new Date(),
): Promise<HeroBasisGroup[]> {
  const monthStartIso = monthStartIsoFor(now)

  // Claude Code — attribution_aggregate, window predicate IDENTICAL to
  // fetchDailySeries (server/usage/consumption.ts) so hero-weekly Σ == daily Σ.
  const claudeWeekly = await tx.execute<{ week_start: string; usd: string }>(sql`
    SELECT date_trunc('week', period_start AT TIME ZONE 'UTC')::date::text AS week_start,
           SUM(total_cost_usd)::text AS usd
    FROM attribution_aggregate
    WHERE scope_type = 'teammate' AND scope_id = ${teammateId}::uuid
      AND period_kind = 'day'
      AND period_start >= (now() - make_interval(days => ${windowDays}))
    GROUP BY 1 ORDER BY 1
  `)
  const claudeMtdRows = await tx.execute<{ usd: string }>(sql`
    SELECT COALESCE(SUM(total_cost_usd), 0)::text AS usd
    FROM attribution_aggregate
    WHERE scope_type = 'teammate' AND scope_id = ${teammateId}::uuid
      AND period_kind = 'day'
      AND period_start >= date_trunc('month', now() AT TIME ZONE 'UTC')
  `)

  // Copilot usage lanes — v_teammate_usage_daily copilot branch (tool literals
  // from the registry, never hand lists: copilot-surface-lanes checklist).
  const copilotList = laneListSql(GITHUB_USAGE_TOOLS)
  const copilotWeekly = await tx.execute<{ tool: string; week_start: string; usd: string }>(sql`
    SELECT tool, date_trunc('week', day)::date::text AS week_start, SUM(usage_usd)::text AS usd
    FROM v_teammate_usage_daily
    WHERE teammate_id = ${teammateId}::uuid
      AND tool IN (${copilotList})
      AND day >= ((now() AT TIME ZONE 'UTC')::date - (${windowDays} - 1))
    GROUP BY 1, 2 ORDER BY 1, 2
  `)
  const copilotMtd = await tx.execute<{ tool: string; usd: string }>(sql`
    SELECT tool, SUM(usage_usd)::text AS usd
    FROM v_teammate_usage_daily
    WHERE teammate_id = ${teammateId}::uuid
      AND tool IN (${copilotList})
      AND day >= ${monthStartIso.slice(0, 10)}::date
    GROUP BY 1
  `)

  // Billed surfaces — actual_spend over the non-Code Claude lanes (§B display).
  const nonCodeList = laneListSql(NON_CODE_CLAUDE_TOOLS)
  const billedWeekly = await tx.execute<{ tool: string; week_start: string; usd: string }>(sql`
    SELECT tool, date_trunc('week', date)::date::text AS week_start, SUM(cost_usd)::text AS usd
    FROM actual_spend
    WHERE teammate_id = ${teammateId}::uuid
      AND tool IN (${nonCodeList})
      AND date >= ((now() AT TIME ZONE 'UTC')::date - (${windowDays} - 1))
    GROUP BY 1, 2 ORDER BY 1, 2
  `)
  const billedMtd = await tx.execute<{ tool: string; usd: string }>(sql`
    SELECT tool, SUM(cost_usd)::text AS usd
    FROM actual_spend
    WHERE teammate_id = ${teammateId}::uuid
      AND tool IN (${nonCodeList})
      AND date >= ${monthStartIso.slice(0, 10)}::date
    GROUP BY 1
  `)

  const weeksOf = (
    rows: Iterable<{ tool?: string; week_start: string; usd: string }>,
    tool?: string,
  ): HeroLaneWeek[] =>
    [...rows]
      .filter((r) => tool === undefined || r.tool === tool)
      .map((r) => ({ week_start: r.week_start, usd: Number(r.usd).toFixed(2) }))
  const mtdOf = (rows: Iterable<{ tool: string; usd: string }>, tool: string): number =>
    Number([...rows].find((r) => r.tool === tool)?.usd ?? 0)

  const telemetryLanes: HeroLane[] = [
    {
      lane: 'claude',
      label: VENDOR_LABELS['claude'],
      mtd_usd: Number([...claudeMtdRows][0]?.usd ?? 0).toFixed(2),
      weekly: weeksOf(claudeWeekly),
    },
  ]
  for (const toolId of GITHUB_USAGE_TOOLS) {
    const lane = toolToVendor(toolId)
    const weekly = weeksOf(copilotWeekly, toolId)
    const mtd = mtdOf(copilotMtd, toolId)
    if (weekly.length === 0 && mtd === 0) continue // elide silent lanes
    telemetryLanes.push({
      lane,
      label: VENDOR_LABELS[lane],
      mtd_usd: mtd.toFixed(2),
      weekly,
    })
  }

  const billedLanes: HeroLane[] = []
  for (const toolId of NON_CODE_CLAUDE_TOOLS) {
    const weekly = weeksOf(billedWeekly, toolId)
    const mtd = mtdOf(billedMtd, toolId)
    if (weekly.length === 0 && mtd === 0) continue // elide silent lanes
    billedLanes.push({ lane: toolId, label: toolLabel(toolId), mtd_usd: mtd.toFixed(2), weekly })
  }

  return [
    {
      id: 'telemetry',
      label: 'Telemetry-attributed',
      basis: 'attributed telemetry usage · weekly',
      lanes: telemetryLanes,
    },
    {
      id: 'billed',
      label: 'Billed surfaces',
      basis: 'billed usage (provider bill) · weekly',
      lanes: billedLanes,
    },
  ]
}

// ── provider-truth MTD (visuals-iter2 §I3 "one honest number") ──────────────

/**
 * The requester's provider-truth month-to-date spend — the SAME per-user
 * sources /me/usage's §A reconciliation reads: Σ v_teammate_usage_daily
 * (claude-code + any other emitted tool from actual_spend, PLUS the Copilot
 * reconciliation usage the view lanes in — mig 0086 keeps the two arms
 * double-count-free by construction) + Σ actual_spend over the non-Code Claude
 * surfaces (which the view deliberately excludes as §B-only). No attribution
 * math anywhere: this is what the providers say the user consumed.
 */
export async function getMyProviderTruthMtd(
  tx: Tx,
  teammateId: string,
  now: Date = new Date(),
): Promise<string> {
  const monthStart = monthStartIsoFor(now).slice(0, 10)
  const nonCodeList = laneListSql(NON_CODE_CLAUDE_TOOLS)
  const rows = await tx.execute<{ usd: string }>(sql`
    SELECT (
      COALESCE((
        SELECT SUM(usage_usd) FROM v_teammate_usage_daily
        WHERE teammate_id = ${teammateId}::uuid AND day >= ${monthStart}::date
      ), 0)
      +
      COALESCE((
        SELECT SUM(cost_usd) FROM actual_spend
        WHERE teammate_id = ${teammateId}::uuid AND tool IN (${nonCodeList})
          AND date >= ${monthStart}::date
      ), 0)
    )::text AS usd
  `)
  return Number([...rows][0]?.usd ?? 0).toFixed(2)
}

/**
 * Minutes since the requester's provider feeds last landed anything — the
 * STALEST of actual_spend (Anthropic analytics poll, `pulled_at`) and
 * reconciliation_record (GitHub usage engine, `computed_at`). LEAST (not
 * GREATEST — iter2 review r1): the leg feeds the page's "as fresh as its
 * stalest source" worst-of line, so the OLDEST sub-feed timestamp (= most
 * minutes ago) must win — a fresh GitHub pull must never hide a 3-day-old
 * Anthropic pull. Postgres LEAST/GREATEST skip NULL operands (SQL-standard
 * deviation): one feed absent → the other's timestamp; both absent → NULL
 * (this function returns null — no feed has landed anything yet).
 */
export async function getMyProviderFeedFreshness(
  tx: Tx,
  teammateId: string,
): Promise<number | null> {
  const rows = await tx.execute<{ minutes: string | null }>(sql`
    SELECT FLOOR(EXTRACT(EPOCH FROM (now() - LEAST(
      (SELECT MAX(pulled_at) FROM actual_spend WHERE teammate_id = ${teammateId}::uuid),
      (SELECT MAX(computed_at) FROM reconciliation_record
        WHERE teammate_id = ${teammateId}::uuid AND provider = 'github')
    ))) / 60)::text AS minutes
  `)
  const m = [...rows][0]?.minutes
  return m == null ? null : Math.max(0, Number(m))
}

// ── my projects (memberships) ──────────────────────────────────────────────

export interface MyProject extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  /** Budget type — billable / pursuit / internal (so the UI reads as a typed budget, not just "project"). */
  type: string
}

/**
 * The projects the caller is a CURRENT member of (active assignment). These are
 * the projects a teammate can attribute spend to. Extracted from
 * GET /api/v1/me/projects.
 */
export async function getMyProjects(tx: Tx, teammateId: string): Promise<MyProject[]> {
  const rows = await tx.execute<MyProject>(sql`
    SELECT p.id::text AS id, p.code, p.display_name, p.type
    FROM project p
    JOIN project_assignment pa ON pa.project_id = p.id
    WHERE pa.teammate_id = ${teammateId}::uuid AND pa.effective @> now()
      -- Exclude ENDED projects from tag-eligibility — don't route new work onto
      -- a dead project (D2 spill is the backstop if any slips through).
      AND ${activeProjectPredicate('p')}
    ORDER BY p.code
  `)
  return [...rows]
}

// ── resolve a repo's .tokenscope code → a member budget ─────────────────────

export interface ResolvedRepoProject extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  /** Budget type — billable / pursuit / internal. */
  type: string
}

/**
 * Resolve a repo's `.tokenscope` reference — given a project **code** OR a
 * **code_hash** (never a filesystem path: the server must not persist any repo
 * path or cwd, per the design doc's privacy note) — to a project the caller is a
 * CURRENT member of. Returns the project metadata on a match, or `null` when the
 * ref doesn't resolve to a member budget (unknown code, or a real project the
 * caller is not assigned to — both collapse to "not yours", no existence oracle).
 *
 * Membership-gated exactly like getMyProjects (active assignment, active
 * project), so the `/tokenscope-project` and `/tokenscope-tag` skills can confirm
 * a repo's `.tokenscope` code maps to a real budget before they act on it.
 * Exactly one of `code` / `codeHash` is matched; `codeHash` wins if both given.
 */
export async function resolveRepoProject(
  tx: Tx,
  teammateId: string,
  ref: { code?: string; codeHash?: string },
): Promise<ResolvedRepoProject | null> {
  // Neither ref → nothing to resolve. Guard here too (not only at the MCP tool)
  // so a bare process call can't build `p.code = NULL` (which matches nothing,
  // but make the contract explicit rather than relying on SQL NULL semantics).
  if (!ref.codeHash && !ref.code) return null
  // Match on code_hash when supplied, else on code. The caller passes one; this
  // is a code-constant choice, not user-controlled SQL structure. The VALUE is
  // parameter-bound (drizzle `sql` interpolation), never raw-concatenated.
  const matchPredicate = ref.codeHash
    ? sql`p.code_hash = ${ref.codeHash}`
    : sql`p.code = ${ref.code}`

  const rows = await tx.execute<ResolvedRepoProject>(sql`
    SELECT p.id::text AS id, p.code, p.display_name, p.type
    FROM project p
    JOIN project_assignment pa ON pa.project_id = p.id
    WHERE pa.teammate_id = ${teammateId}::uuid AND pa.effective @> now()
      AND ${matchPredicate}
      -- Same active-project gate as getMyProjects: don't resolve a dead budget.
      AND ${activeProjectPredicate('p')}
    LIMIT 1
  `)
  return [...rows][0] ?? null
}

// ── activity types ─────────────────────────────────────────────────────────

export interface ActivityType {
  label: string
  is_standard: boolean
  /** True if the CALLER has used this activity before (their own tag). */
  is_mine: boolean
}

/**
 * Display label for a vocabulary entry: title-case only entries that are ALL
 * lowercase (the lazily-seeded ones like 'research' -> 'Research'), preserving
 * any intentional mixed casing an admin chose (e.g. 'WorkIQ' stays 'WorkIQ').
 */
function displayLabel(s: string): string {
  return s === s.toLowerCase() ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : s
}

/**
 * The activity-tag suggestion list, ordered for the human doing the tagging:
 *   1. the caller's OWN previously-used activities (most-used first, in THEIR
 *      casing) — the ones they actually reach for;
 *   2. then the hybrid standard / region vocabulary (title-cased for display —
 *      the seed is lowercase), deduped case-insensitively against (1).
 *
 * The case-insensitive dedup means a caller who has used 'Research' sees only
 * their 'Research', not a second standard 'research' — so capitalising the
 * standard set never splits their own tagged-spend buckets. Suggestion source,
 * NOT an allow-list (the stored value stays free-form). Used by both
 * GET /api/v1/me/activity-types and the MCP `list_activity_types` tool.
 */
export async function getActivityTypes(
  tx: Tx,
  regionId: string,
  teammateId: string,
): Promise<ActivityType[]> {
  // (1) The caller's own activities, most-used first.
  const mineRows = await tx.execute<{ label: string }>(sql`
    SELECT activity AS label
      FROM session_assignment
     WHERE teammate_id = ${teammateId}::uuid
       AND activity IS NOT NULL
       AND btrim(activity) <> ''
     GROUP BY activity
     ORDER BY COUNT(*) DESC, lower(activity)
  `)
  // (2) The standard / region vocabulary.
  const stdRows = await tx.execute<{ label: string; is_standard: boolean }>(sql`
    SELECT label, is_standard
      FROM activity_type
     WHERE is_active = TRUE
       AND (region_id IS NULL OR region_id = ${regionId}::uuid)
     ORDER BY sort_order, lower(label)
  `)
  const stdByLower = new Map([...stdRows].map((r) => [r.label.toLowerCase(), r]))

  const seen = new Set<string>()
  const out: ActivityType[] = []
  for (const r of mineRows) {
    const key = r.label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ label: r.label, is_standard: stdByLower.has(key), is_mine: true })
  }
  for (const r of stdRows) {
    const display = displayLabel(r.label)
    const key = display.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ label: display, is_standard: r.is_standard, is_mine: false })
  }
  return out
}

// ── quarantined (heartbeat-uncovered) spend ─────────────────────────────────

export interface QuarantinedSession extends Record<string, unknown> {
  session_id: string
  instance_id: string
  cost_usd: string
  tokens: number
  session_ts_start: string
  session_ts_end: string
  last_bearer_at: string | null
  reason: string
  detected_at: string
}

/**
 * The caller's OPEN quarantined sessions — spend claiming an instance whose
 * authenticated heartbeat ([ts_start, last_bearer_at + grace]) does NOT span the
 * session's [min,max] ts_event. Surfaced as "unverified spend" pending
 * reconciliation. This is the cross-instance-spoof signal (a spoofer can't mint a
 * /bearer for a victim's instance, so there's no covering heartbeat); it does NOT
 * catch full credential theft (the thief owns the instance, so it heartbeats as
 * the victim). INFORMATIONAL — reconciliation, not this read, decides truth.
 *
 * Reads the worker-maintained session_quarantine table. teammate_id is filtered
 * explicitly (defense in depth) AND the table is RLS teammate-scoped, so a caller
 * only ever sees their own rows — exactly like the other /me reads.
 */
export async function getMyQuarantinedSpend(
  tx: Tx,
  teammateId: string,
): Promise<QuarantinedSession[]> {
  const rows = await tx.execute<QuarantinedSession>(sql`
    SELECT
      sq.conversation_id                       AS session_id,
      sq.instance_id::text                     AS instance_id,
      sq.cost_usd::text                        AS cost_usd,
      sq.tokens::text                          AS tokens,
      sq.session_ts_start::text                AS session_ts_start,
      sq.session_ts_end::text                  AS session_ts_end,
      sq.last_bearer_at::text                  AS last_bearer_at,
      sq.reason                                AS reason,
      sq.detected_at::text                     AS detected_at
    FROM session_quarantine sq
    WHERE sq.teammate_id = ${teammateId}::uuid
      AND sq.resolved_at IS NULL
    ORDER BY sq.session_ts_end DESC
  `)
  return [...rows].map((r) => ({
    session_id: r.session_id,
    instance_id: r.instance_id,
    cost_usd: Number(r.cost_usd).toFixed(2),
    tokens: Number(r.tokens),
    session_ts_start: r.session_ts_start,
    session_ts_end: r.session_ts_end,
    last_bearer_at: r.last_bearer_at,
    reason: r.reason,
    detected_at: r.detected_at,
  }))
}

// ── oauth grants (authorized connections) ───────────────────────────────────

/** Grant lifecycle state — derived, never stored (design doc §Grant lifecycle). */
export type GrantState = 'active' | 'inactive' | 'revoked' | 'expired'

/** Window (days) past which a grant with no fresh use reads "inactive" (informational, never auto-revoked). */
export const GRANT_INACTIVE_DAYS = 14

/**
 * Plain-language scope label for the account / admin grant review UIs. Re-exports
 * the SHARED source (shared/oauth-scopes.ts) that the consent page also uses — so
 * a user reads the same words at grant time and at review time (no drift).
 */
export const grantScopeLabel = oauthScopeLabel

export interface Grant extends Record<string, unknown> {
  id: string
  client_name: string
  /** Space-delimited scopes split into the granted list. */
  scopes: string[]
  /** Plain-language label per scope, index-aligned with `scopes`. */
  scope_labels: string[]
  state: GrantState
  /** Stable per-row issuance instant — the grant's creation anchor. */
  created_at: string
  last_used_at: string | null
  /** True when the grant carries the emit scope (revoke cascades to the instance). */
  is_emit: boolean
}

interface GrantRow extends Record<string, unknown> {
  id: string
  client_name: string
  scope: string
  state: GrantState
  created_at: string
  last_used_at: string | null
}

/**
 * Derived grant state, computed in SQL so the list and any future review UIs
 * agree on one truth table.
 *
 * `oauth_token` has NO `created_at` column (verified: migrations 0023/0030). The
 * STABLE per-row issuance anchor is `refresh_issued_at` (set once at issuance,
 * never bumped — unlike `access_issued_at`, which the non-rotating refresh bumps
 * every cycle). So the creation anchor and the active/inactive base both use
 * `COALESCE(last_used_at, refresh_issued_at)`.
 *
 * Precedence (terminal states win): revoked > expired > active/inactive. A
 * revoked grant reads "revoked" regardless of how recently it was used; an
 * expired-but-not-revoked grant reads "expired". A fresh grant (never used) is
 * active because `refresh_issued_at` is `now()` at issuance.
 */
function grantStateExpr() {
  return sql`
    CASE
      WHEN t.revoked_at IS NOT NULL THEN 'revoked'
      WHEN t.refresh_expires_at < now() THEN 'expired'
      WHEN COALESCE(t.last_used_at, t.refresh_issued_at)
             >= now() - (${GRANT_INACTIVE_DAYS}::text || ' days')::interval THEN 'active'
      ELSE 'inactive'
    END
  `
}

function projectGrant(r: GrantRow): Grant {
  const scopes = r.scope ? r.scope.split(' ').filter(Boolean) : []
  return {
    id: r.id,
    client_name: r.client_name,
    scopes,
    scope_labels: scopes.map(grantScopeLabel),
    state: r.state,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    is_emit: scopes.includes('tokenscope.emit'),
  }
}

/**
 * The caller's OWN authorized connections (oauth_token rows), joined to the
 * client name, with the derived lifecycle state. Owner-scoped by an explicit
 * `teammate_id` predicate — `oauth_token` has no RLS policy and the owner DB
 * connection makes RLS inert anyway, so this predicate IS the live gate (the
 * instance-list pattern). Multiple grants per user are expected (N machines /
 * re-enrol / reconnect) — disambiguated by created_at + last_used_at.
 */
export async function getMyGrants(tx: Tx, teammateId: string): Promise<Grant[]> {
  const rows = await tx.execute<GrantRow>(sql`
    SELECT
      t.id::text                AS id,
      c.client_name             AS client_name,
      t.scope                   AS scope,
      ${grantStateExpr()}       AS state,
      t.refresh_issued_at::text AS created_at,
      t.last_used_at::text      AS last_used_at
    FROM oauth_token t
    JOIN oauth_client c ON c.client_id = t.client_id
    WHERE t.teammate_id = ${teammateId}::uuid
    ORDER BY COALESCE(t.last_used_at, t.refresh_issued_at) DESC, t.refresh_issued_at DESC
  `)
  return [...rows].map(projectGrant)
}

/**
 * Admin variant — a single teammate's grants, with the owning teammate's
 * identity carried on each row for the admin table. Region scoping is enforced
 * by the CALLER (the admin endpoint resolves the teammate's region_id and runs
 * requireRegionScope before calling this) — `oauth_token` has no region of its
 * own, so the join to teammate is where region lives.
 */
export interface AdminGrant extends Grant {
  teammate_id: string
  teammate_email: string
  teammate_display_name: string | null
}

export async function getGrantsForTeammate(tx: Tx, teammateId: string): Promise<AdminGrant[]> {
  const rows = await tx.execute<
    GrantRow & { teammate_id: string; teammate_email: string; teammate_display_name: string | null }
  >(sql`
    SELECT
      t.id::text                AS id,
      c.client_name             AS client_name,
      t.scope                   AS scope,
      ${grantStateExpr()}       AS state,
      t.refresh_issued_at::text AS created_at,
      t.last_used_at::text      AS last_used_at,
      tm.id::text               AS teammate_id,
      tm.email                  AS teammate_email,
      tm.display_name           AS teammate_display_name
    FROM oauth_token t
    JOIN oauth_client c ON c.client_id = t.client_id
    JOIN teammate tm    ON tm.id = t.teammate_id
    WHERE t.teammate_id = ${teammateId}::uuid
    ORDER BY COALESCE(t.last_used_at, t.refresh_issued_at) DESC, t.refresh_issued_at DESC
  `)
  return [...rows].map((r) => ({
    ...projectGrant(r),
    teammate_id: r.teammate_id,
    teammate_email: r.teammate_email,
    teammate_display_name: r.teammate_display_name,
  }))
}
