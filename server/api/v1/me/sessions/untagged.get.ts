/*
 * GET /api/v1/me/sessions/untagged — the caller's UNALLOCATED conversations
 * (no project budget). Source of truth is attribution_record: since the joiner
 * itemises all spend (mig 0021), unallocated spend is rows with project_id IS
 * NULL — no live-reader round-trip, one consistent ledger.
 *
 * Each row carries its activity (NULL = genuinely untagged → "needs tagging";
 * set = tagged-only → "spill"); the dashboard splits on it. Keyed per Claude
 * CONVERSATION (claude_session_id; subagents share the parent's), falling back to
 * the instance id for legacy rows. A conversation leaves this list once it has a
 * project (its rows get a project_id) — see docs/design/quota-model.md.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { breakdownFields, fetchBreakdownCells, groupCells } from '../../../../usage/breakdowns'
import { conversationKeyExpr } from '../../../../db/conversation-key'

interface Row extends Record<string, unknown> {
  session_id: string
  instance_id: string | null
  activity: string | null
  tool: string | null
  first_event: string
  last_event: string
  tokens: string
  cost_usd: string
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)

  const { rows, cellsByConv, unaccounted } = await withRequestRls(event, async (tx) => {
    // §A — the per-day reconciled "unaccounted usage" records that still need tagging
    // (provider API truth OTel didn't capture). One taggable item per (teammate, day, tool).
    const unaccountedRows = await tx.execute<{ id: string; day: string; tool: string; cost_usd: string; tokens: string }>(sql`
      SELECT id::text AS id, day::text AS day, tool, cost_usd::text AS cost_usd, tokens::text AS tokens
      FROM unaccounted_usage
      WHERE teammate_id = ${session.teammateId}::uuid AND project_id IS NULL AND cost_usd > 0
      ORDER BY day DESC
      LIMIT 100
    `)
    const convRows = await tx.execute<Row>(sql`
      SELECT
        ${conversationKeyExpr('ar')} AS session_id,
        MAX(ar.instance_id::text) AS instance_id,
        MAX(ar.activity) AS activity,
        MAX(ar.tool) AS tool,
        MIN(ar.ts_event)::text AS first_event,
        MAX(ar.ts_event)::text AS last_event,
        SUM(ar.tokens)::text AS tokens,
        SUM(ar.cost_usd)::text AS cost_usd
      FROM attribution_record ar
      WHERE ar.teammate_id = ${session.teammateId}::uuid
        AND ar.project_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM session_quarantine sq
          WHERE sq.teammate_id = ar.teammate_id AND sq.conversation_id = ar.claude_session_id
            AND sq.resolved_at IS NULL AND sq.reason = 'api-uncorroborated')
      GROUP BY ${conversationKeyExpr('ar')}
      ORDER BY MAX(ar.ts_event) DESC
      LIMIT 100
    `)
    // NOTE: the breakdown spans the conversation's FULL ledger (attributed +
    // unallocated rows), while tokens/cost above are the unallocated slice
    // only — the worklist sums what needs tagging; the chip describes the
    // conversation. Read-model per design §0.5.2.
    const cells = await fetchBreakdownCells(
      tx,
      session.teammateId,
      [...convRows].map((r) => r.session_id),
    )
    return { rows: convRows, cellsByConv: groupCells(cells), unaccounted: unaccountedRows }
  })

  return {
    sessions: [...rows].map((r) => ({
      session_id: r.session_id,
      instance_id: r.instance_id,
      first_event: r.first_event,
      last_event: r.last_event,
      tokens: Number(r.tokens),
      cost_usd: Number(r.cost_usd).toFixed(4),
      activity: r.activity,
      tool: r.tool ?? 'claude-code',
      // models was hardcoded [] pre-0045; now real (cost-share desc, §3.3).
      ...breakdownFields(cellsByConv.get(r.session_id) ?? []),
    })),
    // §A — per-day reconciled records (provider API truth OTel missed), taggable via
    // /me/unaccounted/{id}/assign. One per (day, tool); NOT sessions (no session id).
    unaccounted: [...unaccounted].map((u) => ({
      id: u.id,
      day: u.day,
      tool: u.tool,
      cost_usd: Number(u.cost_usd).toFixed(4),
      tokens: Number(u.tokens),
    })),
  }
})
