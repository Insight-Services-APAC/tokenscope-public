/*
 * GET /api/v1/me/sessions/recent/export — CSV export of the developer's recent
 * sessions for download via the "Export CSV" affordance on the Recent-sessions
 * table (design-notes §Screen 2).
 *
 * Mirrors the ATTRIBUTED rows of `/api/v1/me/sessions/recent`: one row per Claude
 * CONVERSATION (COALESCE(claude_session_id, instance_id)), tokens + cost summed
 * from attribution_record. Untagged-instance rows (the live-reader "pending"
 * rows the UI also shows) are NOT exported — they have no attribution yet, so
 * there is nothing durable to export until they're assigned. csvEscape()
 * mitigates formula injection per the security-audit sweep.
 */
import { defineEventHandler, getValidatedQuery, setHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { csvEscape } from '../../../../../utils/csv-escape'
import { conversationKeyExpr } from '../../../../../db/conversation-key'

const ExportQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  // 'model' → one row per (conversation × model) — the pivot-ready form for
  // reporting (design §3.4). Default keeps one row per conversation.
  granularity: z.enum(['conversation', 'model']).default('conversation'),
})

interface ConvRow extends Record<string, unknown> {
  conversation_id: string
  model: string | null
  models: string | null
  project_code: string | null
  project_display_name: string | null
  tool: string
  ts_start: string
  tokens: string
  input_tokens: string
  output_tokens: string
  cache_read_tokens: string
  cache_write_tokens: string
  cost_usd: string
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const query = await getValidatedQuery(event, (data) => ExportQuery.parse(data))

  // Same query shape as /me/sessions/recent (API-14): key on the teammate
  // axis of attribution_record itself (the old instance_attestation join
  // dropped rows with NULL instance_id) and group by the CONVERSATION only —
  // grouping by project too exported a re-tagged conversation as multiple
  // rows while the table shows one. granularity=model adds the model to the
  // GROUP BY (one row per conversation × model — explicitly multi-row).
  // Token-type splits are FILTER sums (mig-0045 exposure, design §3.4);
  // `models` is the per-conversation distinct list (semicolon-joined in CSV).
  const byModel = query.granularity === 'model'
  const rows = await withRequestRls(event, async (tx) =>
    tx.execute<ConvRow>(
      sql`
        SELECT
          ${conversationKeyExpr('ar')} AS conversation_id,
          ${byModel ? sql`ar.model AS model,` : sql`NULL AS model,`}
          string_agg(DISTINCT ar.model, ';' ORDER BY ar.model) AS models,
          MAX(p.code) AS project_code,
          MAX(p.display_name) AS project_display_name,
          MAX(ar.tool) AS tool,
          MIN(ar.ts_event)::text AS ts_start,
          SUM(ar.tokens)::text AS tokens,
          COALESCE(SUM(ar.tokens) FILTER (WHERE ar.token_type = 'input'), 0)::text AS input_tokens,
          COALESCE(SUM(ar.tokens) FILTER (WHERE ar.token_type = 'output'), 0)::text AS output_tokens,
          COALESCE(SUM(ar.tokens) FILTER (WHERE ar.token_type = 'cache-read'), 0)::text AS cache_read_tokens,
          COALESCE(SUM(ar.tokens) FILTER (WHERE ar.token_type = 'cache-write'), 0)::text AS cache_write_tokens,
          SUM(ar.cost_usd)::text AS cost_usd
        FROM attribution_record ar
        LEFT JOIN project p ON p.id = ar.project_id
        WHERE ar.teammate_id = ${session.teammateId}::uuid
        GROUP BY ${conversationKeyExpr('ar')}${byModel ? sql`, ar.model` : sql``}
        ORDER BY MAX(ar.ts_event) DESC
        LIMIT ${query.limit}
      `,
    ),
  )

  // New columns are APPENDED so the original 7-column positional order
  // (session_id..cost_usd) survives for existing CSV consumers; only the
  // new granularity=model shape (multi-row, new anyway) carries `model`.
  const csvLines = [
    `session_id,project_code,project_display_name,tool,ts_start,tokens,cost_usd,${byModel ? 'model' : 'models'},input_tokens,output_tokens,cache_read_tokens,cache_write_tokens`,
    ...rows.map(
      (r) =>
        [
          csvEscape(r.conversation_id),
          csvEscape(r.project_code ?? ''),
          csvEscape(r.project_display_name ?? ''),
          csvEscape(r.tool),
          csvEscape(r.ts_start),
          r.tokens,
          r.cost_usd,
          csvEscape(byModel ? (r.model ?? '') : (r.models ?? '')),
          r.input_tokens,
          r.output_tokens,
          r.cache_read_tokens,
          r.cache_write_tokens,
        ].join(','),
    ),
  ]
  const stamp = new Date().toISOString().slice(0, 10)
  setHeader(event, 'content-type', 'text/csv; charset=utf-8')
  setHeader(
    event,
    'content-disposition',
    `attachment; filename="tokenscope-recent-sessions-${stamp}.csv"`,
  )
  return csvLines.join('\n') + '\n'
})
