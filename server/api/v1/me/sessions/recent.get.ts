/*
 * GET /api/v1/me/sessions/recent?limit=10 — the developer's most recent Claude
 * conversations for the Recent-sessions table (design-notes §2).
 *
 * Single source: attribution_record (the joiner itemises ALL spend, mig 0021), so
 * one query covers attributed AND unallocated conversations — no live-reader
 * merge. A "session" is a Claude CONVERSATION, keyed on
 * COALESCE(claude_session_id, instance_id) (subagents share the parent's id;
 * legacy rows fall back to the instance). project_code is NULL for unallocated;
 * `attributed` is true once any of the conversation's rows has a project.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { endedProjectExpr } from '../../../../db/project-predicates'
import { conversationKeyExpr } from '../../../../db/conversation-key'
import { breakdownFields, fetchBreakdownCells, groupCells } from '../../../../usage/breakdowns'

const RecentQuery = z.object({
  limit: z.coerce.number().int().positive().max(50).default(10),
})

interface ConvRow extends Record<string, unknown> {
  conversation_id: string
  instance_id: string | null
  project_id: string | null
  project_code: string | null
  project_display_name: string | null
  activity: string | null
  tool: string
  ts_start: string
  ts_last: string
  tokens: string
  cost_usd: string
  attributed: boolean
  // D2a split indicator: this conversation has BOTH rows attributed to an ended
  // project AND unallocated rows → it spans an end boundary. Re-tag will move
  // only the unallocated portion (the ended project keeps its pre-end rows), so
  // the UI must signal that re-tag splits rather than re-homes the whole thing.
  partly_ended: boolean
  ended_project_code: string | null
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const { limit } = await getValidatedQuery(event, (data) => RecentQuery.parse(data))

  const { rows, cellsByConv } = await withRequestRls(event, async (tx) => {
    const convRows = await tx.execute<ConvRow>(sql`
      SELECT
        ${conversationKeyExpr('ar')} AS conversation_id,
        MAX(ar.instance_id::text) AS instance_id,
        MAX(ar.project_id::text) AS project_id,
        MAX(p.code) AS project_code,
        MAX(p.display_name) AS project_display_name,
        MAX(ar.activity) AS activity,
        MAX(ar.tool) AS tool,
        MIN(ar.ts_event)::text AS ts_start,
        -- The row is ORDERED by MAX(ts_event) (most recent activity); expose it
        -- so the "When" column shows the SAME timestamp it's sorted on (showing
        -- ts_start while sorting on ts_last made the order look random).
        MAX(ar.ts_event)::text AS ts_last,
        SUM(ar.tokens)::text AS tokens,
        SUM(ar.cost_usd)::text AS cost_usd,
        bool_or(ar.project_id IS NOT NULL) AS attributed,
        -- Split indicator (D2a): the conversation has rows on an ENDED project
        -- AND rows that are NOT on an ended project (unallocated OR on an active
        -- project). This survives the re-tag: pre-end rows stay on ended X while
        -- the spilled rows move to active Y, so the conversation is still split
        -- (X + Y) — earlier "ended + unallocated" went false the moment the
        -- spilled rows were re-tagged, hiding the badge while still split.
        (bool_or(${endedProjectExpr('p')})
         AND bool_or(NOT (${endedProjectExpr('p')}))) AS partly_ended,
        MAX(p.code) FILTER (WHERE ${endedProjectExpr('p')})
          AS ended_project_code
      FROM attribution_record ar
      LEFT JOIN project p ON p.id = ar.project_id
      WHERE ar.teammate_id = ${session.teammateId}::uuid
      GROUP BY ${conversationKeyExpr('ar')}
      ORDER BY MAX(ar.ts_event) DESC
      LIMIT ${limit}
    `)
    // Per-conversation (model × token_type) cells via the usage read-model
    // (design §0.5.2) — one extra grouped query bounded by limit ≤ 50.
    const cells = await fetchBreakdownCells(
      tx,
      session.teammateId,
      [...convRows].map((r) => r.conversation_id),
    )
    return { rows: convRows, cellsByConv: groupCells(cells) }
  })

  const sessions = [...rows].map((r) => ({
    session_id: r.conversation_id,
    instance_id: r.instance_id,
    project_id: r.project_id,
    project_code: r.project_code,
    project_display_name: r.project_display_name,
    activity: r.activity,
    tool: r.tool,
    ts_start: r.ts_start,
    ts_last: r.ts_last,
    ts_actual_end: null as string | null,
    tokens: Number(r.tokens),
    cost_usd: Number(r.cost_usd).toFixed(2),
    attributed: r.attributed,
    partly_ended: r.partly_ended,
    ended_project_code: r.ended_project_code,
    // Granularity (design §3.1) — shared vocabulary from shared/schemas/usage.ts.
    // models is the by_model order (cost-share desc): models[0] is the dominant
    // model the UI chips.
    ...breakdownFields(cellsByConv.get(r.conversation_id) ?? []),
  }))

  return { sessions, total: sessions.length }
})
