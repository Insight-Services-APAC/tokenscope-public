/*
 * pending-placement-gc — prunes the owed-bill queue (pending_placement, mig 0066)
 * of rows that have already been REPLAYED into actual_spend.
 *
 * Once placement-sync replays an owed bill it stamps placed_at; the row's job is
 * done (the money now lives in actual_spend) but it lingers as queue history.
 * This worker deletes placed rows older than a retention window so the table —
 * and the partial `pending_placement_unplaced` index that scans it — stays small.
 *
 * SAFETY INVARIANT: it NEVER touches an un-replayed row (placed_at IS NULL). Those
 * are owed bills not yet in actual_spend; deleting one silently loses billed spend.
 * The WHERE clause requires placed_at IS NOT NULL, so an unplaced row cannot match
 * regardless of age.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

// Default retention for replayed (placed) owed bills. 90 days well outlives any
// reconciliation/forensic need — by then the spend has been in actual_spend for a
// quarter and the queue row is pure history.
const DEFAULT_OLDER_THAN_DAYS = 90

/** Delete REPLAYED owed bills older than the retention window. Never deletes an
 *  un-replayed row (placed_at IS NULL) — that would lose un-banked spend. */
export async function runPendingPlacementGc(
  db: Db,
  opts?: { olderThanDays?: number },
): Promise<{ deleted: number }> {
  const olderThanDays = opts?.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS
  const deleted = await db.execute<{ id: string }>(sql`
    DELETE FROM pending_placement
    WHERE placed_at IS NOT NULL
      AND placed_at < now() - (${olderThanDays} * INTERVAL '1 day')
    RETURNING id::text AS id`)
  return { deleted: deleted.length }
}
