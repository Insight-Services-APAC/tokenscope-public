/*
 * GET /api/v1/me/sessions/{sid} — full granularity detail for ONE of the
 * caller's conversations (design: docs/design/session-granularity-sprint.md
 * §3.2). This is the session drill-down CONTRACT for next sprint's
 * My Consumption views — shipped server-side now so that work starts on UI,
 * not plumbing. Response shape: shared/schemas/usage.ts::SessionDetail.
 *
 * Ownership is AR-based, like assign.post.ts: the conversation must have
 * attribution_record rows for THIS teammate. A conversation id that exists
 * but belongs to someone else is indistinguishable from one that doesn't
 * exist → 404 either way (no cross-teammate probing).
 */
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { conversationKeyExpr } from '../../../../../db/conversation-key'
import type { SessionDetail } from '../../../../../../shared/schemas/usage'
import {
  fetchBreakdownCells,
  fetchQuerySourceSplit,
  fidelitySplit,
  pivotByModel,
  sessionLaneView,
} from '../../../../../usage/breakdowns'

interface HeaderRow extends Record<string, unknown> {
  instance_id: string | null
  tool: string
  project_id: string | null
  project_code: string | null
  project_display_name: string | null
  activity: string | null
  ts_start: string
  ts_last: string
  record_count: string
  span_count: string
  tokens: string
  cost_usd: string
}

export default defineEventHandler(async (event): Promise<SessionDetail> => {
  const session = await requireAuth(event)
  // Claude's session.id — a non-empty string we never mint (same bound as
  // assign.post.ts), OR an instance uuid for legacy pre-claude_session_id rows.
  const sidParsed = z.string().min(1).max(256).safeParse(getRouterParam(event, 'sid'))
  if (!sidParsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid conversation id' })
  }
  const conversationId = sidParsed.data

  return await withRequestRls(event, async (tx) => {
    const headerRows = await tx.execute<HeaderRow>(sql`
      SELECT
        MAX(ar.instance_id::text) AS instance_id,
        MAX(ar.tool) AS tool,
        MAX(ar.project_id::text) AS project_id,
        MAX(p.code) AS project_code,
        MAX(p.display_name) AS project_display_name,
        MAX(ar.activity) AS activity,
        MIN(ar.ts_event)::text AS ts_start,
        MAX(ar.ts_event)::text AS ts_last,
        COUNT(*)::text AS record_count,
        COUNT(DISTINCT (ar.ts_event, COALESCE(ar.source_run_id, '')))::text AS span_count,
        SUM(ar.tokens)::text AS tokens,
        SUM(ar.cost_usd)::text AS cost_usd
      FROM attribution_record ar
      LEFT JOIN project p ON p.id = ar.project_id
      WHERE ar.teammate_id = ${session.teammateId}::uuid
        AND ${conversationKeyExpr('ar')} = ${conversationId}
    `)
    const header = [...headerRows][0]
    if (!header || header.record_count === '0' || Number(header.record_count) === 0) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Conversation not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Conversation not found',
          status: 404,
          detail: 'No attributed spend for this conversation under your account.',
        },
      })
    }

    const cells = await fetchBreakdownCells(tx, session.teammateId, [conversationId])
    const byQuerySource = await fetchQuerySourceSplit(tx, session.teammateId, conversationId)
    // The lane axis (D14/D15). On a credit-priced session the per-lane money is
    // a carrier convention, not a set of prices, so it ships as NULL rather than
    // as fabricated zeros — the session's money is stated once, in cost_usd.
    const lanes = sessionLaneView(cells)

    return {
      session_id: conversationId,
      instance_id: header.instance_id,
      tool: header.tool,
      project_id: header.project_id,
      project_code: header.project_code,
      project_display_name: header.project_display_name,
      activity: header.activity,
      ts_start: header.ts_start,
      ts_last: header.ts_last,
      record_count: Number(header.record_count),
      span_count: Number(header.span_count),
      tokens: Number(header.tokens),
      cost_usd: Number(header.cost_usd).toFixed(2),
      priced_per_lane: lanes.priced_per_lane,
      matrix: lanes.matrix,
      by_model: pivotByModel(cells),
      by_token_type: lanes.by_token_type,
      by_query_source: byQuerySource,
      cache: lanes.cache,
      fidelity: fidelitySplit(cells),
    }
  })
})
