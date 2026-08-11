/*
 * sweepStaleDismissals — hand back a worklist item whose spend materially
 * outgrew the decision that dismissed it.
 *
 * A dismissal says "this isn't worth tagging" about an AMOUNT, not about a key.
 * Both worklist item kinds can grow after the decision:
 *   - a dismissed conversation can be resumed and keep emitting;
 *   - a dismissed provider-recorded day is a RECONCILED delta that every
 *     reconciliation run recomputes — a day waved through at $0.67 can be
 *     revised to $65 when the provider's API reports the rest of it.
 * Without this sweep, "dismiss" would quietly absorb unbounded future spend,
 * which is the one behaviour docs/design/needs-tagging-worklist.md forbids.
 *
 * So each dismissal stores what it was about (dismissed_cost_usd), and the
 * workers that MOVE those numbers call this afterwards. An item that grew past
 * its snapshot by more than the threshold returns to the queue for a fresh
 * decision — the developer is asked again, rather than being silently bound by
 * an answer they gave about a different amount.
 *
 * THIS REVERSES A PERSON'S DECISION, so it audits like one. Every swept item
 * gets an audit_event attributed to the teammate whose decision it was (actor
 * system = the worker), carrying the snapshot and the amount that superseded it.
 * "Why is this back in my queue?" must be answerable from the ledger of record,
 * not from a log line nobody kept.
 *
 * Deliberately NOT a read-path predicate: "is this dismissal still current" is a
 * property of the decision, and computing it in four separate read queries is
 * four places to drift. One writer, one definition.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { recordAuditEvent } from '../db/audit'
import { unallocatedConversationSpendExpr } from '../db/conversation-key'

type Db = PostgresJsDatabase<Record<string, unknown>>

/**
 * How much an item may grow past its dismissal before the decision is stale,
 * USD. Absolute, not a ratio: a ratio would re-surface a $0.01 probe that
 * doubled to $0.02 (noise) while letting a $40 day grow to $50 unchallenged.
 * The developer's question is "is this now worth my attention", and that is an
 * absolute-dollars question.
 */
export const DISMISSAL_STALE_GROWTH_USD = 1.0

export interface StaleDismissalSweep {
  sessions: number
  unaccounted: number
  /**
   * Swept items whose dismissal carried NO snapshot. Every current writer sets
   * one, so a non-zero count means something wrote `dismissed_at` without
   * `dismissed_cost_usd` (a new writer, a manual DB fix) and the sweep treated
   * the baseline as $0 — worth seeing rather than folding into the normal path.
   */
  missingSnapshots: number
}

interface SweptRow extends Record<string, unknown> {
  id: string
  teammate_id: string
  key: string
  snapshot: string | null
  current: string
}

export async function sweepStaleDismissals(db: Db): Promise<StaleDismissalSweep> {
  // ONE transaction for the mutations AND their audit rows. If an audit write
  // fails, the sweep rolls back and the items stay dismissed until the next tick
  // — "swept but not audited" is the one outcome this function must never
  // produce, and a retry is free. The caller (a worker tick that has already
  // done its real work) still sees a thrown error, so the sweep is deliberately
  // called LAST and its failure is caught there rather than failing the tick.
  return await db.transaction(async (tx) => sweepInTx(tx as unknown as Db))
}

// The SAME expression the dismissal's snapshot is taken with (see
// applyWorklistBulk) — shared so a snapshot can never be written on one key
// model and compared on the other.
const conversationSpendExpr = unallocatedConversationSpendExpr(
  sql.raw('sa.claude_session_id'),
  sql.raw('sa.teammate_id'),
)

async function sweepInTx(db: Db): Promise<StaleDismissalSweep> {
  // LOCK ORDER: days before conversations, matching applyWorklistBulk (which
  // takes its unaccounted_usage row locks before it writes session_assignment).
  // Two paths that touch both tables in OPPOSITE orders deadlock the moment they
  // overlap on one teammate; one global order is the whole prevention.
  //
  // Provider-recorded days: the row is the usage record, so only the decision is
  // cleared, never the row. Both dismissal columns clear together — a snapshot
  // outliving its dismissal is dead data a future reader could misread.
  const unaccounted = await db.execute<SweptRow>(sql`
    UPDATE unaccounted_usage uu
       SET dismissed_at = NULL, dismissed_cost_usd = NULL
     WHERE uu.dismissed_at IS NOT NULL
       AND uu.cost_usd > COALESCE(uu.dismissed_cost_usd, 0) + ${DISMISSAL_STALE_GROWTH_USD}
    RETURNING uu.id::text AS id,
              uu.teammate_id::text AS teammate_id,
              uu.day::text AS key,
              uu.dismissed_cost_usd::text AS snapshot,
              uu.cost_usd::text AS current
  `)

  // Conversations: the dismissal row itself is deleted, because a
  // dismissal-only row with the flag cleared carries nothing (and the
  // project-or-activity-or-dismissed CHECK rejects it). Deleting = "back in the
  // queue, no decision on record", which is exactly the intent.
  const sessions = await db.execute<SweptRow>(sql`
    DELETE FROM session_assignment sa
     WHERE sa.dismissed_at IS NOT NULL
       AND ${conversationSpendExpr} > COALESCE(sa.dismissed_cost_usd, 0) + ${DISMISSAL_STALE_GROWTH_USD}
    RETURNING sa.id::text AS id,
              sa.teammate_id::text AS teammate_id,
              sa.claude_session_id AS key,
              sa.dismissed_cost_usd::text AS snapshot,
              ${conversationSpendExpr}::text AS current
  `)

  const swept = [
    ...[...sessions].map((r) => ({ ...r, kind: 'session' as const })),
    ...[...unaccounted].map((r) => ({ ...r, kind: 'day' as const })),
  ]
  for (const row of swept) {
    await recordAuditEvent(db, {
      eventType: 'worklist-dismissal-superseded',
      // The decision was theirs, so the reversal belongs on their timeline; the
      // actor SYSTEM records that no human asked for it.
      actorTeammateId: row.teammate_id,
      actorSystem: 'worker:stale-dismissals',
      subjectKind: row.kind === 'session' ? 'session' : 'unaccounted-usage',
      // A conversation id is not a uuid in our schema (Claude mints it), and
      // subject_id is; carry it in the payload for the session lane.
      subjectId: row.kind === 'day' ? row.id : null,
      payload: {
        kind: row.kind,
        key: row.key,
        dismissed_cost_usd: row.snapshot,
        current_cost_usd: row.current,
        threshold_usd: DISMISSAL_STALE_GROWTH_USD,
        reason: 'spend outgrew the dismissal; item returned to the needs-tagging queue',
      },
    })
  }

  return {
    sessions: [...sessions].length,
    unaccounted: [...unaccounted].length,
    missingSnapshots: swept.filter((r) => r.snapshot === null).length,
  }
}
