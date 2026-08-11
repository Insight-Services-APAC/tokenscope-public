/*
 * Project-detail ledger read — THE sanctioned raw-ledger exception
 * (brief §6.5), now down to ONE query: untagged pressure.
 *
 * `fetchMemberContribution` and `fetchProjectActivityMix` used to live here and
 * read `attribution_record` directly. They are gone: per-member and
 * per-activity are GRAINS of the project total, so they now come from
 * `completeProjectSpend`'s siblings in server/usage/complete-spend.ts, over the
 * same §A lane and the same window. A team table that footed to a different
 * lane than the headline above it is the defect, not a performance choice.
 *
 * Untagged pressure stays on the ledger because it is NOT project spend: it is
 * members' UNALLOCATED conversations, keyed by `claude_session_id` — a
 * conversation axis `v_complete_usage` does not carry (arms 2 and 3 are
 * day-grained and have no session id at all, so a conversation COUNT cannot be
 * derived from that lane).
 *
 * Reading a different table does NOT license a different window or a different
 * set of filters without saying so. The function below takes its window from
 * the caller (the same half-open month-to-date range the headline uses) and its
 * doc names every §A filter it deliberately does not inherit.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { conversationKeyExpr } from '../db/conversation-key'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export interface UntaggedPressure {
  conversations: number
  cost_usd: string
  tokens: number
}

/**
 * Untagged pressure: members' UNALLOCATED spend in `window` during their
 * membership window — conversations that plausibly belong to this project but
 * carry no budget. Counts + totals only (no per-member naming — PO principle #5).
 *
 * ── THE WINDOW ───────────────────────────────────────────────────────────────
 * Half-open `[startIso, endIso)`, passed in by the caller so it is the SAME
 * window as the headline it sits under. It used to compute its own lower bound
 * (`ts_event >= date_trunc('month', now())`) with NO upper bound at all, which
 * made "this month's pressure" include every future-dated row in the table —
 * next month's, next year's — under a figure the PM reads as "chase this now".
 *
 * ── THE FILTERS IT DOES AND DOES NOT APPLY ───────────────────────────────────
 * This is the one sanctioned raw-ledger read (brief §6.5), so it does NOT
 * inherit `v_complete_usage`'s semantics. Stated rather than assumed:
 *
 *   APPLIED  — the membership window (`pa.effective @> ar.ts_event`), the
 *              half-open month window, and the dismissal filter below.
 *   NOT APPLIED — the api-uncorroborated QUARANTINE exclusion the §A lane
 *              applies, and the `excludeProvisional` identity filter every
 *              manager-facing project figure applies.
 *
 * Both omissions push the same way — pressure can read slightly HIGH relative
 * to the headline — and both are deliberate: this is a "go and ask someone to
 * tag their sessions" prompt, not money in a budget. A quarantined or
 * provisional conversation still needs tagging, and suppressing it here would
 * hide work from the only person who can do it. It is never added to any
 * project total, so it cannot move a budget decision.
 *
 * It stays on the ledger (rather than the §A lane) because it counts
 * CONVERSATIONS, keyed by `claude_session_id` — an axis `v_complete_usage` does
 * not carry at all (arms 2 and 3 are day-grained and have no session id).
 */
export async function fetchUntaggedPressure(
  tx: Tx,
  projectId: string,
  window: { startIso: string; endIso: string },
): Promise<UntaggedPressure> {
  // EXISTS (not JOIN): overlapping assignment windows for one member must
  // not multiply unallocated rows into phantom pressure.
  const rows = await tx.execute<{ convs: string; cost_usd: string; tokens: string }>(sql`
    SELECT COUNT(DISTINCT ${conversationKeyExpr('ar')})::text AS convs,
           COALESCE(SUM(ar.cost_usd), 0)::text AS cost_usd,
           COALESCE(SUM(ar.tokens), 0)::text AS tokens
    FROM attribution_record ar
    WHERE ar.project_id IS NULL
      AND ar.ts_event >= ${window.startIso}::timestamptz
      AND ar.ts_event <  ${window.endIso}::timestamptz
      AND EXISTS (
        SELECT 1 FROM project_assignment pa
        WHERE pa.teammate_id = ar.teammate_id
          AND pa.project_id = ${projectId}::uuid
          AND pa.effective @> ar.ts_event
      )
      -- A conversation its owner has DISMISSED (mig 0094) is decided, not
      -- pending: they said it isn't project work. Keeping it in "pressure"
      -- would nag the PM to chase spend nobody is going to re-tag.
      AND NOT EXISTS (
        SELECT 1 FROM session_assignment sa
        WHERE sa.teammate_id = ar.teammate_id
          AND sa.claude_session_id = ${conversationKeyExpr('ar')}
          AND sa.dismissed_at IS NOT NULL
      )
  `)
  const r = [...rows][0]
  return {
    conversations: Number(r?.convs ?? 0),
    cost_usd: Number(r?.cost_usd ?? 0).toFixed(2),
    tokens: Number(r?.tokens ?? 0),
  }
}
