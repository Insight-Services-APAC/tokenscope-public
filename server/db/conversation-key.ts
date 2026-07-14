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
