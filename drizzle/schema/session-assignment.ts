/*
 * Per-conversation assignment (dogfood-followups §13).
 *
 * Maps a Claude conversation (claude_session_id — Claude's own per-event
 * session.id) to a project, scoped to the teammate who assigned it. The read
 * joiner consults this as the fallback project source for records that emitted
 * NO project.code_hash: emitted-hash (ADR-0004 B′) ELSE this assignment ELSE
 * untagged. The membership gate still applies at join time, so a stale
 * assignment to a project the teammate has left spills like any other claim.
 *
 * Migration 0018 is the source of truth (hand-written SQL); 0020 adds the
 * orthogonal activity axis (project_id becomes nullable + an activity column).
 * This mirrors them.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, numeric, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { teammate } from './identity'
import { project } from './projects'

export const sessionAssignment = pgTable(
  'session_assignment',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // Claude's per-conversation session.id (client-emitted; grouping-only per
    // ADR-0004 — it never crosses a teammate).
    claudeSessionId: text('claude_session_id').notNull(),
    teammateId: uuid('teammate_id')
      .notNull()
      .references(() => teammate.id),
    // Nullable (mig 0020): a session may be tagged with an activity but NO
    // project (the personal lane). A DB CHECK requires at least one of
    // project_id / activity / dismissed_at (mig 0094) to be present.
    projectId: uuid('project_id').references(() => project.id),
    // Orthogonal activity axis (mig 0020): free-form label, hybrid-validated in
    // the UI against activity_type suggestions. Independent of project_id.
    activity: text('activity'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull().default('manual'),
    // Worklist-only (mig 0094): the teammate decided NOT to tag this
    // conversation. A row may now be dismissal-only (both axes NULL) — the DB
    // CHECK accepts project_id OR activity OR dismissed_at, and a SECOND CHECK
    // makes tagged-and-dismissed unrepresentable. The spend stays unallocated
    // either way; only the queue changes.
    // See docs/design/needs-tagging-worklist.md.
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    // What the dismissal was ABOUT: the conversation's unallocated spend when
    // the decision was made. sweepStaleDismissals hands the item back if it
    // materially outgrows this, so a dismissal can never silently absorb spend
    // that arrived after it.
    dismissedCostUsd: numeric('dismissed_cost_usd', { precision: 14, scale: 6 }),
  },
  (t) => [
    uniqueIndex('session_assignment_session_teammate_unique').on(
      t.claudeSessionId,
      t.teammateId,
    ),
    index('session_assignment_teammate_idx').on(t.teammateId, t.claudeSessionId),
  ],
)
