/*
 * Project-detail ledger reads — THE sanctioned raw-ledger exception
 * (brief §6.5): one project at a time, month-bounded, served by the
 * (project_id, ts_event) / membership indexes. Everything list- or
 * series-shaped must read attribution_aggregate via consumption.ts —
 * the consumption-perf-gate test pins this file as the only dashboard
 * module allowed to touch attribution_record.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { conversationKeyExpr } from '../db/conversation-key'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export interface MemberContribution extends Record<string, unknown> {
  teammate_id: string
  display_name: string | null
  email: string
  cost_usd: string
  tokens: number
  active_days: number
  cost_per_active_day: string
  last_event: string | null
}

/**
 * Per-member MTD contribution for ONE project — month-bounded, served by
 * the (project_id, ts_event) index. Cost-per-active-day is AEUF's
 * intensity metric (spend / distinct active days).
 */
export async function fetchMemberContribution(
  tx: Tx,
  projectId: string,
): Promise<MemberContribution[]> {
  const rows = await tx.execute<MemberContribution & { active_days: string; tokens: string }>(sql`
    SELECT ar.teammate_id::text AS teammate_id,
           MAX(t.display_name) AS display_name,
           MAX(t.email) AS email,
           SUM(ar.cost_usd)::text AS cost_usd,
           SUM(ar.tokens)::text AS tokens,
           COUNT(DISTINCT (ar.ts_event AT TIME ZONE 'UTC')::date)::int::text AS active_days,
           MAX(ar.ts_event)::text AS last_event
    FROM attribution_record ar
    JOIN teammate t ON t.id = ar.teammate_id
    WHERE ar.project_id = ${projectId}::uuid
      AND ar.ts_event >= date_trunc('month', now() AT TIME ZONE 'UTC')
    GROUP BY ar.teammate_id
    ORDER BY SUM(ar.cost_usd) DESC
  `)
  return [...rows].map((r) => {
    const cost = Number(r.cost_usd)
    const days = Number(r.active_days)
    return {
      teammate_id: r.teammate_id,
      display_name: r.display_name,
      email: r.email,
      cost_usd: cost.toFixed(2),
      tokens: Number(r.tokens),
      active_days: days,
      cost_per_active_day: days > 0 ? (cost / days).toFixed(2) : '0.00',
      last_event: r.last_event,
    }
  })
}

export interface ActivitySlice {
  activity: string | null
  cost_usd: string
  tokens: number
}

/** MTD activity mix for ONE project (NULL = untagged-within-project). */
export async function fetchProjectActivityMix(tx: Tx, projectId: string): Promise<ActivitySlice[]> {
  const rows = await tx.execute<{ activity: string | null; cost_usd: string; tokens: string }>(sql`
    SELECT ar.activity, SUM(ar.cost_usd)::text AS cost_usd, SUM(ar.tokens)::text AS tokens
    FROM attribution_record ar
    WHERE ar.project_id = ${projectId}::uuid
      AND ar.ts_event >= date_trunc('month', now() AT TIME ZONE 'UTC')
    GROUP BY ar.activity
    ORDER BY SUM(ar.cost_usd) DESC
  `)
  return [...rows].map((r) => ({
    activity: r.activity,
    cost_usd: Number(r.cost_usd).toFixed(2),
    tokens: Number(r.tokens),
  }))
}

export interface UntaggedPressure {
  conversations: number
  cost_usd: string
  tokens: number
}

/**
 * Untagged pressure: members' UNALLOCATED MTD spend during their membership
 * window — conversations that plausibly belong to this project but carry no
 * budget. Counts + totals only (no per-member naming — PO principle #5).
 */
export async function fetchUntaggedPressure(
  tx: Tx,
  projectId: string,
): Promise<UntaggedPressure> {
  // EXISTS (not JOIN): overlapping assignment windows for one member must
  // not multiply unallocated rows into phantom pressure.
  const rows = await tx.execute<{ convs: string; cost_usd: string; tokens: string }>(sql`
    SELECT COUNT(DISTINCT ${conversationKeyExpr('ar')})::text AS convs,
           COALESCE(SUM(ar.cost_usd), 0)::text AS cost_usd,
           COALESCE(SUM(ar.tokens), 0)::text AS tokens
    FROM attribution_record ar
    WHERE ar.project_id IS NULL
      AND ar.ts_event >= date_trunc('month', now() AT TIME ZONE 'UTC')
      AND EXISTS (
        SELECT 1 FROM project_assignment pa
        WHERE pa.teammate_id = ar.teammate_id
          AND pa.project_id = ${projectId}::uuid
          AND pa.effective @> ar.ts_event
      )
  `)
  const r = [...rows][0]
  return {
    conversations: Number(r?.convs ?? 0),
    cost_usd: Number(r?.cost_usd ?? 0).toFixed(2),
    tokens: Number(r?.tokens ?? 0),
  }
}
