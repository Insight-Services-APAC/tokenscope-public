/*
 * GET /api/v1/me/over-emission — the caller's OPEN over-emission flags: days where their
 * OTel-reported usage materially EXCEEDS the provider API truth (uncorroborated; possibly a
 * forged/mis-tagged emission). docs/design/provider-billing-attribution-model.md §A.
 *
 * For each flagged (day, tool) it returns the day's conversations (cost desc) so the
 * developer can identify the suspect session and either quarantine it or escalate, via
 * /me/over-emission/{id}/resolve. The API has no session ids, so the system never
 * auto-picks the forgery — the developer makes the call.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'

interface FlagRow extends Record<string, unknown> {
  id: string
  day: string
  tool: string
  otel_usd: string
  api_usd: string
  over_usd: string
}
interface SessRow extends Record<string, unknown> {
  day: string
  tool: string
  conversation_id: string
  cost_usd: string
  tokens: string
  first_event: string
  last_event: string
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)

  return await withRequestRls(event, async (tx) => {
    const flags = await tx.execute<FlagRow>(sql`
      SELECT id::text AS id, day::text AS day, tool,
             otel_usd::text AS otel_usd, api_usd::text AS api_usd, over_usd::text AS over_usd
      FROM over_emission
      WHERE teammate_id = ${session.teammateId}::uuid AND state = 'open' AND over_usd > 0
      ORDER BY day DESC
    `)
    const flagList = [...flags]
    if (flagList.length === 0) return { flags: [] }

    // The conversations on each flagged day (so the dev can spot the outlier). Excludes
    // already-confirmed forgeries (they no longer count toward the over).
    const days = flagList.map((f) => f.day)
    const sessions = await tx.execute<SessRow>(sql`
      SELECT (ar.ts_event AT TIME ZONE 'UTC')::date::text AS day,
             ar.tool,
             COALESCE(ar.claude_session_id, ar.instance_id::text) AS conversation_id,
             SUM(ar.cost_usd)::text AS cost_usd,
             SUM(ar.tokens)::text AS tokens,
             MIN(ar.ts_event)::text AS first_event,
             MAX(ar.ts_event)::text AS last_event
      FROM attribution_record ar
      WHERE ar.teammate_id = ${session.teammateId}::uuid
        AND (ar.ts_event AT TIME ZONE 'UTC')::date = ANY(${sql`ARRAY[${sql.join(days.map((d) => sql`${d}::date`), sql`, `)}]`})
        AND NOT EXISTS (
          SELECT 1 FROM session_quarantine sq
          WHERE sq.teammate_id = ar.teammate_id AND sq.conversation_id = ar.claude_session_id
            AND sq.resolved_at IS NULL AND sq.reason = 'api-uncorroborated')
      GROUP BY (ar.ts_event AT TIME ZONE 'UTC')::date, ar.tool, COALESCE(ar.claude_session_id, ar.instance_id::text)
      ORDER BY SUM(ar.cost_usd) DESC
    `)
    const byDayTool = new Map<string, SessRow[]>()
    for (const s of sessions) {
      const k = `${s.day}|${s.tool}`
      const arr = byDayTool.get(k) ?? []
      arr.push(s)
      byDayTool.set(k, arr)
    }

    return {
      flags: flagList.map((f) => ({
        id: f.id,
        day: f.day,
        tool: f.tool,
        otel_usd: Number(f.otel_usd).toFixed(2),
        api_usd: Number(f.api_usd).toFixed(2),
        over_usd: Number(f.over_usd).toFixed(2),
        sessions: (byDayTool.get(`${f.day}|${f.tool}`) ?? []).map((s) => ({
          conversation_id: s.conversation_id,
          cost_usd: Number(s.cost_usd).toFixed(2),
          tokens: Number(s.tokens),
          first_event: s.first_event,
          last_event: s.last_event,
        })),
      })),
    }
  })
})
