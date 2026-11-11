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
 *
 * DISMISSED items (mig 0094) are split out into `dismissed` rather than dropped:
 * the developer decided to leave them unallocated, so they owe no further work,
 * but the decision is reversible and must stay visible to be reversed. Their
 * spend is untouched and still counts in the unallocated total — see
 * docs/design/needs-tagging-worklist.md.
 */
import { defineEventHandler } from 'h3'
import { sql, type SQL } from 'drizzle-orm'
import { requireAuth } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { breakdownFields, fetchBreakdownCells, groupCells } from '../../../../usage/breakdowns'
import { conversationKeyExpr } from '../../../../db/conversation-key'
import { WORKLIST_LIST_LIMIT } from '#shared/schemas/worklist'
import { ownDeviceNames } from '../../../../utils/device-names'

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

interface UnaccountedRow extends Record<string, unknown> {
  id: string
  day: string
  tool: string
  cost_usd: string
  tokens: string
}

/** Per-kind read cap, shared with the client so it can say when it is at the cap. */
const LIST_LIMIT = WORKLIST_LIST_LIMIT

/**
 * The caller's unallocated conversations, either the ACTIVE queue or the
 * DISMISSED set — one query shape so the two can never drift apart on the
 * quarantine filter or the conversation key. The dismissal probe runs on the
 * grouped result (one index probe per conversation, not per ledger row) and
 * matches on the same COALESCE key the list is grouped by, so a dismissal
 * recorded against a legacy instance-keyed conversation is honoured too.
 */
function conversationsQuery(teammateId: string, opts: { dismissed: boolean }): SQL {
  return sql`
    SELECT g.session_id, g.instance_id, g.activity, g.tool, g.first_event, g.last_event,
           g.tokens, g.cost_usd
      FROM (
        SELECT
          ${conversationKeyExpr('ar')} AS session_id,
          MAX(ar.instance_id::text) AS instance_id,
          MAX(ar.activity) AS activity,
          MAX(ar.tool) AS tool,
          MIN(ar.ts_event)::text AS first_event,
          MAX(ar.ts_event)::text AS last_event,
          MAX(ar.ts_event) AS last_event_ts,
          SUM(ar.tokens)::text AS tokens,
          SUM(ar.cost_usd)::text AS cost_usd
        FROM attribution_record ar
        WHERE ar.teammate_id = ${teammateId}::uuid
          AND ar.project_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM session_quarantine sq
            WHERE sq.teammate_id = ar.teammate_id AND sq.conversation_id = ${conversationKeyExpr('ar')}
              AND sq.resolved_at IS NULL AND sq.reason = 'api-uncorroborated')
        GROUP BY ${conversationKeyExpr('ar')}
      ) g
     WHERE ${opts.dismissed ? sql`EXISTS` : sql`NOT EXISTS`} (
       SELECT 1 FROM session_assignment sa
        WHERE sa.teammate_id = ${teammateId}::uuid
          AND sa.claude_session_id = g.session_id
          AND sa.dismissed_at IS NOT NULL)
     -- session_id is the UNIQUE tiebreaker. Ordering by a non-unique column
     -- under a LIMIT orders tied last_event_ts values arbitrarily, so WHICH
     -- sessions appear at all varies per request and one can stay permanently
     -- invisible on a queue people act on.
     ORDER BY g.last_event_ts DESC, g.session_id DESC
     LIMIT ${LIST_LIMIT}
  `
}

/** §A per-day reconciled records, ACTIVE queue or DISMISSED set. */
function unaccountedQuery(teammateId: string, opts: { dismissed: boolean }): SQL {
  return sql`
    SELECT id::text AS id, day::text AS day, tool, cost_usd::text AS cost_usd, tokens::text AS tokens
    FROM unaccounted_usage
    WHERE teammate_id = ${teammateId}::uuid AND project_id IS NULL AND cost_usd > 0
      AND dismissed_at IS ${opts.dismissed ? sql`NOT NULL` : sql`NULL`}
    -- id is the UNIQUE tiebreaker: day is not unique, and under a LIMIT that
    -- makes the visible set non-deterministic (see the note above).
    ORDER BY day DESC, id DESC
    LIMIT ${LIST_LIMIT}
  `
}

const toSession = (r: Row, names: Map<string, string>, spans: Map<string, { first: string; last: string }>) => ({
  session_id: r.session_id,
  instance_id: r.instance_id,
  device_name: r.instance_id ? (names.get(r.instance_id) ?? null) : null,
  session_first: spans.get(r.session_id)?.first ?? r.first_event,
  session_last: spans.get(r.session_id)?.last ?? r.last_event,
  first_event: r.first_event,
  last_event: r.last_event,
  tokens: Number(r.tokens),
  cost_usd: Number(r.cost_usd).toFixed(4),
  activity: r.activity,
  tool: r.tool ?? 'claude-code',
})

const toUnaccounted = (u: UnaccountedRow) => ({
  id: u.id,
  day: u.day,
  tool: u.tool,
  cost_usd: Number(u.cost_usd).toFixed(4),
  tokens: Number(u.tokens),
})

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)

  const { rows, cellsByConv, unaccounted, dismissedRows, dismissedUnaccounted, names, spans } = await withRequestRls(
    event,
    async (tx) => {
      // Concurrent issuance on ONE tx connection: postgres-js pipelines and
      // answers in order — no per-query await gaps for the four independent
      // lists (docs/design/request-floor-performance.md F5). The breakdown fetch
      // below stays after: it consumes the active conversations' ids.
      const [convRows, unaccountedRows, dismissedConvRows, dismissedUnaccountedRows] =
        await Promise.all([
          tx.execute<Row>(conversationsQuery(session.teammateId, { dismissed: false })),
          tx.execute<UnaccountedRow>(unaccountedQuery(session.teammateId, { dismissed: false })),
          tx.execute<Row>(conversationsQuery(session.teammateId, { dismissed: true })),
          tx.execute<UnaccountedRow>(unaccountedQuery(session.teammateId, { dismissed: true })),
        ])
      // NOTE: the breakdown spans the conversation's FULL ledger (attributed +
      // unallocated rows), while tokens/cost above are the unallocated slice
      // only — the worklist sums what needs tagging; the chip describes the
      // conversation. Read-model per design §0.5.2. Dismissed rows render muted
      // (no model chip), so they don't pay for a breakdown fetch.
      const cells = await fetchBreakdownCells(
        tx,
        session.teammateId,
        [...convRows].map((r) => r.session_id),
      )
      // The caller's own device names (#576), one read for both session lists.
      const names = await ownDeviceNames(tx, session.teammateId, [
        ...[...convRows].map((r) => r.instance_id),
        ...[...dismissedConvRows].map((r) => r.instance_id),
      ])
      /*
       * #577: when each listed conversation ran, across its WHOLE ledger (tagged
       * rows too). One grouped read over the listed keys only, matched on the
       * same COALESCE key the lists group by.
       */
      const keys = [...new Set([...[...convRows], ...[...dismissedConvRows]].map((r) => r.session_id))]
      const inList = sql.join(keys.map((k) => sql`${k}`), sql`, `)
      const spanRows = keys.length
        ? await tx.execute<{ k: string; first: string; last: string } & Record<string, unknown>>(sql`
            SELECT ${conversationKeyExpr('ar')} AS k,
                   MIN(ar.ts_event)::text AS first, MAX(ar.ts_event)::text AS last
              FROM attribution_record ar
             WHERE ar.teammate_id = ${session.teammateId}::uuid
               -- The two arms of the COALESCE key, so the claude_session_id arm
               -- is index-servable (as fetchBreakdownCells does); the legacy
               -- instance arm matches pre-0016 rows only.
               AND (ar.claude_session_id IN (${inList})
                    OR (ar.claude_session_id IS NULL AND ar.instance_id::text IN (${inList})))
             GROUP BY ${conversationKeyExpr('ar')}
          `)
        : []
      const spans = new Map([...spanRows].map((r) => [r.k, { first: r.first, last: r.last }]))
      return {
        names,
        spans,
        rows: convRows,
        cellsByConv: groupCells(cells),
        unaccounted: unaccountedRows,
        dismissedRows: dismissedConvRows,
        dismissedUnaccounted: dismissedUnaccountedRows,
      }
    },
  )

  return {
    sessions: [...rows].map((r) => ({
      ...toSession(r, names, spans),
      // models was hardcoded [] pre-0045; now real (cost-share desc, §3.3).
      ...breakdownFields(cellsByConv.get(r.session_id) ?? []),
    })),
    // §A — per-day reconciled records (provider API truth OTel missed), taggable via
    // /me/unaccounted/{id}/assign. One per (day, tool); NOT sessions (no session id).
    unaccounted: [...unaccounted].map(toUnaccounted),
    // Decided-and-left-unallocated. Out of the queue, still restorable, spend unchanged.
    dismissed: {
      sessions: [...dismissedRows].map((r) => toSession(r, names, spans)),
      unaccounted: [...dismissedUnaccounted].map(toUnaccounted),
    },
  }
})
