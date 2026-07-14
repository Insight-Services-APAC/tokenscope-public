/*
 * Consumption read-model — series, window pivots, run-rate and velocity
 * over attribution_aggregate (brief §6.4). The /me/consumption and
 * /me/projects endpoints are thin consumers; NO dashboard SQL in handlers.
 *
 * Perf contract (brief §6.5): list/series/mix queries read the AGGREGATE
 * only. The single sanctioned raw-ledger exception is the per-project
 * DETAIL page (member contribution, activity mix, untagged pressure):
 * one-project-at-a-time, month-bounded, served by the (project_id,
 * ts_event) / (teammate_id, ts_event) indexes — codified in
 * tests/unit/server/consumption-perf-gate.test.ts.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { activeProjectPredicate } from '../db/project-predicates'
import { cacheStats, pivotByModel, pivotByTokenType, type BreakdownCell } from './breakdowns'
import type { CacheStats, ModelSpend, TokenTypeSpend } from '../../shared/schemas/usage'
import type { InsightCell } from './insights'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export type AggScope = 'teammate' | 'project'

// ── Aggregate reads ──────────────────────────────────────────────────────

export interface DaySpend {
  day: string
  cost_usd: string
  tokens: number
}

export interface ModelDaySpend {
  day: string
  model: string
  cost_usd: string
}

interface SeriesRow extends Record<string, unknown> {
  day: string
  cost_usd: string
  tokens: string
}

/** Daily spend series for a scope over the trailing window (gap days absent). */
export async function fetchDailySeries(
  tx: Tx,
  scope: AggScope,
  scopeId: string,
  windowDays: number,
): Promise<DaySpend[]> {
  const rows = await tx.execute<SeriesRow>(sql`
    SELECT (period_start AT TIME ZONE 'UTC')::date::text AS day,
           SUM(total_cost_usd)::text AS cost_usd,
           SUM(total_tokens)::text AS tokens
    FROM attribution_aggregate
    WHERE scope_type = ${scope} AND scope_id = ${scopeId}::uuid
      AND period_kind = 'day'
      AND period_start >= (now() - make_interval(days => ${windowDays}))
    GROUP BY 1 ORDER BY 1
  `)
  return [...rows].map((r) => ({
    day: r.day,
    cost_usd: Number(r.cost_usd).toFixed(2),
    tokens: Number(r.tokens),
  }))
}

interface ModelSeriesRow extends Record<string, unknown> {
  day: string
  model: string
  cost_usd: string
}

/** Daily per-model spend (the stacked-by-model toggle). */
export async function fetchModelSeries(
  tx: Tx,
  scope: AggScope,
  scopeId: string,
  windowDays: number,
): Promise<ModelDaySpend[]> {
  const rows = await tx.execute<ModelSeriesRow>(sql`
    SELECT (period_start AT TIME ZONE 'UTC')::date::text AS day,
           model,
           SUM(total_cost_usd)::text AS cost_usd
    FROM attribution_aggregate
    WHERE scope_type = ${scope} AND scope_id = ${scopeId}::uuid
      AND period_kind = 'day'
      AND period_start >= (now() - make_interval(days => ${windowDays}))
    GROUP BY 1, model ORDER BY 1
  `)
  return [...rows].map((r) => ({
    day: r.day,
    model: r.model,
    cost_usd: Number(r.cost_usd).toFixed(2),
  }))
}

export interface WindowTotals {
  cost_usd: number
  tokens: number
  advisory_cost_usd: number
  by_model: ModelSpend[]
  by_token_type: TokenTypeSpend[]
  cache: CacheStats
  aux: {
    main_tokens: number
    aux_tokens: number
    unknown_tokens: number
    aux_cost_usd: string
    aux_share: number | null
  }
}

interface WindowRow extends Record<string, unknown> {
  model: string
  token_type: string
  query_source: string | null
  tokens: string
  cost_usd: string
  advisory_cost_usd: string
}

/**
 * One windowed pull per scope → totals + every pivot the page needs.
 * Reuses the breakdowns pivot/cache math by mapping aggregate cells into
 * BreakdownCell (the conversation axis collapses to '').
 */
export async function fetchWindowTotals(
  tx: Tx,
  scope: AggScope,
  scopeId: string,
  windowDays: number,
): Promise<WindowTotals> {
  const rows = await tx.execute<WindowRow>(sql`
    SELECT model, token_type, query_source,
           SUM(total_tokens)::text AS tokens,
           SUM(total_cost_usd)::text AS cost_usd,
           SUM(advisory_cost_usd)::text AS advisory_cost_usd
    FROM attribution_aggregate
    WHERE scope_type = ${scope} AND scope_id = ${scopeId}::uuid
      AND period_kind = 'day'
      AND period_start >= (now() - make_interval(days => ${windowDays}))
    GROUP BY model, token_type, query_source
  `)
  const cells: BreakdownCell[] = []
  let cost = 0
  let tokens = 0
  let advisory = 0
  let mainTokens = 0
  let auxTokens = 0
  let unknownTokens = 0
  let auxCost = 0
  for (const r of [...rows]) {
    const c = Number(r.cost_usd)
    const t = Number(r.tokens)
    cost += c
    tokens += t
    advisory += Number(r.advisory_cost_usd)
    if (r.query_source === null) unknownTokens += t
    else if (r.query_source === 'main') mainTokens += t
    else {
      auxTokens += t
      auxCost += c
    }
    cells.push({
      conversation_id: '',
      model: r.model,
      token_type: r.token_type,
      tokens: t,
      cost_usd: c,
      tier2_cost_usd: Number(r.advisory_cost_usd),
    })
  }
  // Pivots collapse the query_source axis by re-grouping in the shared helpers.
  const knownLanes = mainTokens + auxTokens
  return {
    cost_usd: cost,
    tokens,
    advisory_cost_usd: advisory,
    by_model: pivotByModel(cells),
    by_token_type: pivotByTokenType(cells),
    cache: cacheStats(cells),
    aux: {
      main_tokens: mainTokens,
      aux_tokens: auxTokens,
      unknown_tokens: unknownTokens,
      aux_cost_usd: auxCost.toFixed(2),
      aux_share: knownLanes > 0 ? Number((auxTokens / knownLanes).toFixed(4)) : null,
    },
  }
}

/** Aggregate cells in InsightCell shape (the detectors' input). */
export async function fetchInsightCellsFromWindow(
  tx: Tx,
  teammateId: string,
  windowDays = 28,
): Promise<InsightCell[]> {
  const rows = await tx.execute<WindowRow & { day: string }>(sql`
    SELECT (period_start AT TIME ZONE 'UTC')::date::text AS day,
           model, token_type, query_source,
           SUM(total_tokens)::text AS tokens,
           SUM(total_cost_usd)::text AS cost_usd,
           SUM(advisory_cost_usd)::text AS advisory_cost_usd
    FROM attribution_aggregate
    WHERE scope_type = 'teammate' AND scope_id = ${teammateId}::uuid
      AND period_kind = 'day'
      AND period_start >= (now() - make_interval(days => ${windowDays}))
    GROUP BY 1, model, token_type, query_source
  `)
  return [...rows].map((r) => ({
    day: r.day,
    tool: 'claude-code',
    model: r.model,
    token_type: r.token_type,
    query_source: r.query_source,
    tokens: Number(r.tokens),
    cost_usd: Number(r.cost_usd),
  }))
}

// ── Velocity (project scope; the inbox velocity-watch convention) ───────

export interface VelocityState {
  current_week_usd: string
  trailing_mean_usd: string
  delta_pct: number | null
  is_flagged: boolean
}

/** Monday (UTC) of the ISO week containing `d`, as 'YYYY-MM-DD'. */
function isoWeekStartUtc(d: Date): string {
  const day = d.getUTCDay()
  const offset = (day + 6) % 7 // Mon=0 … Sun=6
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset)
  return new Date(monday).toISOString().slice(0, 10)
}

/**
 * Current ISO week (Mon UTC) vs the mean of the 4 prior weeks, from
 * aggregate day rows — flagged at `flagThreshold` above mean. Callers thread
 * the resolved 'velocity.spike_threshold' governance dial (mig 0049) in —
 * velocity-watch's bar, so the dashboard agrees with inbox alerts. Week keys
 * are DERIVED from the clock, never from "the latest week with data": a quiet
 * current week must read as $0 current spend, not as last week's spend
 * re-labelled.
 */
export async function fetchProjectVelocity(
  tx: Tx,
  projectId: string,
  flagThreshold: number,
): Promise<VelocityState> {
  const rows = await tx.execute<{ week: string; cost_usd: string }>(sql`
    SELECT date_trunc('week', period_start AT TIME ZONE 'UTC')::date::text AS week,
           SUM(total_cost_usd)::text AS cost_usd
    FROM attribution_aggregate
    WHERE scope_type = 'project' AND scope_id = ${projectId}::uuid
      AND period_kind = 'day'
      AND period_start >= date_trunc('week', now() AT TIME ZONE 'UTC') - interval '28 days'
    GROUP BY 1 ORDER BY 1
  `)
  const byWeek = new Map([...rows].map((r) => [r.week, Number(r.cost_usd)]))
  const now = new Date()
  const current = byWeek.get(isoWeekStartUtc(now)) ?? 0
  // The 4 prior week keys, zero-filled. A project with NO prior-week rows at
  // all has no baseline → delta null, unflagged (never divide a quiet
  // project into a flag).
  const priorKeys = [1, 2, 3, 4].map((w) =>
    isoWeekStartUtc(new Date(now.getTime() - w * 7 * 86_400_000)),
  )
  const hasHistory = priorKeys.some((k) => byWeek.has(k))
  const mean = priorKeys.reduce((a, k) => a + (byWeek.get(k) ?? 0), 0) / priorKeys.length
  const delta = hasHistory && mean > 0 ? (current - mean) / mean : null
  return {
    current_week_usd: current.toFixed(2),
    trailing_mean_usd: mean.toFixed(2),
    delta_pct: delta === null ? null : Number(delta.toFixed(4)),
    is_flagged: delta !== null && delta >= flagThreshold,
  }
}

// ── Membership + project context ─────────────────────────────────────────

export interface MemberProject extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  type: string
  wbs_code: string | null
  end_date: string | null
  ended: boolean
  // R1 F2/F3: region of the PROJECT — governance dials are resolved by
  // the subject's region, never the viewer's.
  region_id: string
  // 'member' (current assignment) | 'cou-owner' (active cou_owner row on
  // the project's lead CC; R1 F1 — the P&L drill-through path).
  access: 'member' | 'cou-owner'
}

/**
 * The caller's CURRENT admission to project `code`, or null — the
 * project-page gate. Two admission paths in one query (R1 F1): current
 * membership, OR active ownership of the project's lead cost-owning unit
 * (the CC owner is typically 2-3 levels removed and NOT a member, and
 * their P&L view links straight here). Membership wins the access label
 * when both hold. A caller with neither is indistinguishable from a
 * missing project (the [sid] 404 posture). Ended projects stay VISIBLE
 * (post-mortem view), flagged via `ended`.
 */
export async function requireProjectMembership(
  tx: Tx,
  teammateId: string,
  code: string,
): Promise<MemberProject | null> {
  const rows = await tx.execute<MemberProject>(sql`
    SELECT p.id::text AS id, p.code, p.display_name, p.type, p.wbs_code,
           p.end_date::text AS end_date,
           (NOT ${activeProjectPredicate('p')}) AS ended,
           p.region_id::text AS region_id,
           CASE WHEN EXISTS (
             SELECT 1 FROM project_assignment pa
             WHERE pa.project_id = p.id
               AND pa.teammate_id = ${teammateId}::uuid
               AND pa.effective @> now()
           ) THEN 'member' ELSE 'cou-owner' END AS access
    FROM project p
    WHERE p.code = ${code}
      AND (
        EXISTS (
          SELECT 1 FROM project_assignment pa
          WHERE pa.project_id = p.id
            AND pa.teammate_id = ${teammateId}::uuid
            AND pa.effective @> now()
        )
        OR EXISTS (
          SELECT 1 FROM cou_owner co
          WHERE co.org_unit_id = p.cost_owning_unit_id
            AND co.teammate_id = ${teammateId}::uuid
            AND co.revoked_at IS NULL
        )
      )
    LIMIT 1
  `)
  return [...rows][0] ?? null
}

/** MTD project allocation (baseline + top-up), matching the quota model. */
export async function fetchProjectAllocation(tx: Tx, projectId: string): Promise<number> {
  const rows = await tx.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(budget_usd), 0)::text AS total
    FROM allocation
    WHERE scope_type = 'project' AND scope_id = ${projectId}::uuid
      AND allocation_kind IN ('baseline', 'top-up')
      AND effective @> now()
  `)
  return Number([...rows][0]?.total ?? 0)
}

/** MTD spend for a scope, from the aggregate. */
export async function fetchMtdSpend(tx: Tx, scope: AggScope, scopeId: string): Promise<number> {
  const rows = await tx.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(total_cost_usd), 0)::text AS total
    FROM attribution_aggregate
    WHERE scope_type = ${scope} AND scope_id = ${scopeId}::uuid
      AND period_kind = 'day'
      AND period_start >= date_trunc('month', now() AT TIME ZONE 'UTC')
  `)
  return Number([...rows][0]?.total ?? 0)
}
