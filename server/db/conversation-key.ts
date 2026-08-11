/*
 * Shared conversation-key expression — THE definition of what a "session" is
 * in every read query: Claude's per-conversation session.id (subagents share
 * their parent's), falling back to the instance id for legacy pre-0016 rows.
 *
 * It appeared inline in five files (recent/untagged/export/[sid] endpoints +
 * the usage read-model); a site that drops the COALESCE arm silently splits
 * legacy conversations from current ones, so the expression lives in one
 * place (same rationale as project-predicates.ts).
 *
 * `tableRef` is the attribution_record alias the calling query uses — a code
 * constant, never user input (shape-asserted like project-predicates).
 */
import { sql, type SQL } from 'drizzle-orm'

export function conversationKeyExpr(tableRef = 'ar'): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(tableRef)) {
    throw new Error(`conversation-key: unsafe tableRef ${JSON.stringify(tableRef)}`)
  }
  return sql.raw(`COALESCE(${tableRef}.claude_session_id, ${tableRef}.instance_id::text)`)
}

/**
 * A conversation's CURRENT UNALLOCATED spend, correlated against an outer
 * conversation key — the amount a dismissal is "about" (mig 0094).
 *
 * It lives beside conversationKeyExpr for the same reason that helper does: the
 * key has a legacy arm, and a site that forgets it silently answers $0 for a
 * pre-0016 instance-keyed conversation. There are two such sites (the snapshot
 * taken when dismissing, and the staleness test that compares against it), and
 * they MUST agree — a snapshot written on one key model and compared on the
 * other makes every legacy dismissal instantly stale.
 *
 * Written as an OR of two indexable equalities rather than
 * `COALESCE(...) = key`, which no index on attribution_record can serve.
 *
 * `keyExpr` / `teammateExpr` are caller-supplied SQL fragments (a bound param or
 * a code-constant column reference), never user text.
 */
export function unallocatedConversationSpendExpr(keyExpr: SQL, teammateExpr: SQL): SQL {
  return sql`COALESCE((
    SELECT SUM(ar.cost_usd) FROM attribution_record ar
     WHERE ar.teammate_id = ${teammateExpr}
       AND ar.project_id IS NULL
       AND (ar.claude_session_id = ${keyExpr}
            OR (ar.claude_session_id IS NULL AND ar.instance_id::text = ${keyExpr}))
  ), 0)`
}
