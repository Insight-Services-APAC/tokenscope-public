/*
 * Activity/tag drill-down read-model — "how much did tag X cost me, across
 * which models and sessions?" Teammate-scoped, window-bounded reads of the
 * ledger (activity is NOT a dimension of attribution_aggregate, so — like the
 * session drill-down — this is a sanctioned single-subject ledger read served
 * by the (teammate_id, ts_event) index, not a dashboard fan-out).
 *
 * Pure pivots are reused from breakdowns.ts; only the activity-scoped cell
 * fetch + the session list live here.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { conversationKeyExpr } from '../db/conversation-key'
import {
  cacheStats,
  fidelitySplit,
  pivotByModel,
  pivotByTokenType,
  type BreakdownCell,
} from './breakdowns'
import type { ActivityDetail, ActivitySession } from '../../shared/schemas/usage'

type Tx = PostgresJsDatabase<Record<string, unknown>>

interface CellRow extends Record<string, unknown> {
  model: string
  token_type: string
  tokens: string
  cost_usd: string
  tier2_cost_usd: string
}
interface SessRow extends Record<string, unknown> {
  session_id: string
  project_code: string | null
  project_display_name: string | null
  tokens: string
  cost_usd: string
  ts_last: string
}

/** How many sessions the drill-down's session list returns (bounded read). */
const SESSION_LIMIT = 100

export async function fetchActivityDetail(
  tx: Tx,
  teammateId: string,
  activity: string,
  windowDays: number,
): Promise<ActivityDetail> {
  // (model × token_type) cells for the activity → the shared pivots. tier-2 is
  // the advisory (telemetry-only) share, mirroring fetchBreakdownCells.
  const cellRows = await tx.execute<CellRow>(sql`
    SELECT ar.model,
           ar.token_type,
           SUM(ar.tokens)::text AS tokens,
           SUM(ar.cost_usd)::text AS cost_usd,
           COALESCE(SUM(ar.cost_usd) FILTER (WHERE ar.fidelity_tier = 'tier-2'), 0)::text AS tier2_cost_usd
    FROM attribution_record ar
    WHERE ar.teammate_id = ${teammateId}::uuid
      AND ar.activity = ${activity}
      AND ar.ts_event >= (now() - make_interval(days => ${windowDays}))
    GROUP BY ar.model, ar.token_type
  `)
  const cells: BreakdownCell[] = [...cellRows].map((r) => ({
    conversation_id: '',
    model: r.model,
    token_type: r.token_type,
    tokens: Number(r.tokens),
    cost_usd: Number(r.cost_usd),
    tier2_cost_usd: Number(r.tier2_cost_usd),
    // The activity drill-down spans many sessions and possibly several
    // providers, so a single per-lane pricing answer would be meaningless here.
    // Not asked → null (the session drawer is where F3's lane honesty lives).
    lane_priced: null,
  }))
  const totalCost = cells.reduce((a, c) => a + c.cost_usd, 0)
  const totalTokens = cells.reduce((a, c) => a + c.tokens, 0)

  // The sessions that carried the tag (cost desc). Model detail lives one hop
  // deeper — each row opens the session drill-down — so no per-session model
  // pivot here.
  const sessRows = await tx.execute<SessRow>(sql`
    SELECT ${conversationKeyExpr('ar')} AS session_id,
           MAX(p.code) AS project_code,
           MAX(p.display_name) AS project_display_name,
           SUM(ar.tokens)::text AS tokens,
           SUM(ar.cost_usd)::text AS cost_usd,
           MAX(ar.ts_event)::text AS ts_last
    FROM attribution_record ar
    LEFT JOIN project p ON p.id = ar.project_id
    WHERE ar.teammate_id = ${teammateId}::uuid
      AND ar.activity = ${activity}
      AND ar.ts_event >= (now() - make_interval(days => ${windowDays}))
    GROUP BY ${conversationKeyExpr('ar')}
    ORDER BY SUM(ar.cost_usd) DESC
    LIMIT ${SESSION_LIMIT}
  `)
  const sessions: ActivitySession[] = [...sessRows].map((r) => ({
    session_id: r.session_id,
    project_code: r.project_code,
    project_display_name: r.project_display_name,
    cost_usd: Number(r.cost_usd).toFixed(2),
    tokens: Number(r.tokens),
    ts_last: r.ts_last,
  }))

  return {
    activity,
    window_days: windowDays,
    total_cost_usd: totalCost.toFixed(2),
    total_tokens: totalTokens,
    session_count: sessions.length,
    by_model: pivotByModel(cells),
    by_token_type: pivotByTokenType(cells),
    cache: cacheStats(cells),
    fidelity: fidelitySplit(cells),
    sessions,
  }
}
