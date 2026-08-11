/*
 * session-economics — the bounded ledger read behind the /usage Session
 * economics card (developer-pages W0c: D10).
 *
 * ── WHY THE LEDGER, AND WHY THAT IS SANCTIONED ──────────────────────────────
 *
 * `v_complete_usage` deliberately has NO session axis (`claude_session_id` is
 * used in arm 1's quarantine join but never projected — mig 0125), so a
 * per-conversation distribution can only come from the ledger itself. The
 * consumption perf gate names this module as its SECOND sanctioned exception
 * (tests/unit/server/consumption-perf-gate.test.ts) with the same
 * both-sides-bounded assertions the project-detail exception carries: ONE
 * query, teammate-scoped on the `attribution_record_teammate_t`
 * (teammate_id, ts_event) index (mig 0055), bounded on BOTH sides by the
 * caller's window — the gate is extended, never dodged.
 *
 * ── OTEL ARM ONLY, BY CONSTRUCTION ──────────────────────────────────────────
 *
 * The ledger IS arm 1. Provider-recorded days (arm 2 fills, arm 3
 * ingest-only) live in other tables and never enter this read — "a
 * provider-recorded day is not a conversation". The card discloses the arm
 * via its (i) popover, which is why the result carries `arm: 'otel'`
 * explicitly rather than leaving the provenance implicit.
 *
 * A "session" is a Claude CONVERSATION — `conversationKeyExpr`'s
 * COALESCE(claude_session_id, instance_id), the same key every session
 * surface groups on (the Activity list's session rows use it too). This module's vocabulary
 * is Claude's own: it carries NO LOC figures and never will (D22 — no fake
 * symmetry with the Copilot engagement column).
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { conversationKeyExpr } from '../db/conversation-key'
import type { SpendWindow } from './complete-spend'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export interface SessionEconomics {
  /** Conversations in the window (distinct conversation keys). */
  sessions: number
  /** Median per-conversation spend, USD. Null when there are no sessions. */
  medianUsd: number | null
  /** 90th-percentile per-conversation spend, USD. Null when no sessions. */
  p90Usd: number | null
  /** The top-N conversations' share of the window's total spend, percent. */
  topShare: { n: number; pct: number | null }
  /** Provenance disclosure: this read is the OTel arm and nothing else. */
  arm: 'otel'
}

/** The top-N the card quotes ("top-3 share"). */
const TOP_SHARE_N = 3

interface EconRow extends Record<string, unknown> {
  sessions: string
  median_usd: string | null
  p90_usd: string | null
  total_usd: string | null
  top_usd: string | null
}

/**
 * Per-conversation spend distribution for ONE teammate over a half-open
 * `[startIso, endIso)` window on `ts_event` — bounded both sides, always.
 */
export async function sessionEconomics(
  tx: Tx,
  teammateId: string,
  window: SpendWindow,
): Promise<SessionEconomics> {
  const rows = await tx.execute<EconRow>(sql`
    WITH conv AS (
      SELECT ${conversationKeyExpr('ar')} AS conversation_id,
             SUM(ar.cost_usd) AS cost_usd
        FROM attribution_record ar
       WHERE ar.teammate_id = ${teammateId}::uuid
         AND ar.ts_event >= ${window.startIso}::timestamptz
         AND ar.ts_event < ${window.endIso}::timestamptz
       GROUP BY ${conversationKeyExpr('ar')}
    )
    SELECT
      COUNT(*)::text                                                        AS sessions,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd)::numeric(14, 6)::text AS median_usd,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY cost_usd)::numeric(14, 6)::text AS p90_usd,
      SUM(cost_usd)::text                                                   AS total_usd,
      (SELECT SUM(top.cost_usd)
         FROM (SELECT c2.cost_usd FROM conv c2
               ORDER BY c2.cost_usd DESC LIMIT ${TOP_SHARE_N}) top)::text   AS top_usd
      FROM conv
  `)
  const row = [...rows][0]
  const sessions = row ? Number(row.sessions) : 0
  if (!row || sessions === 0) {
    return { sessions: 0, medianUsd: null, p90Usd: null, topShare: { n: TOP_SHARE_N, pct: null }, arm: 'otel' }
  }
  const total = row.total_usd === null ? 0 : Number(row.total_usd)
  const top = row.top_usd === null ? 0 : Number(row.top_usd)
  return {
    sessions,
    medianUsd: row.median_usd === null ? null : Number(row.median_usd),
    p90Usd: row.p90_usd === null ? null : Number(row.p90_usd),
    topShare: {
      n: TOP_SHARE_N,
      pct: total > 0 ? Number(((top / total) * 100).toFixed(1)) : null,
    },
    arm: 'otel',
  }
}
