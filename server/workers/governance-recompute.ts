/*
 * governance-recompute worker — the periodic, UNSCOPED counterpart to the
 * inline scoped recompute triggered by a billing PATCH (design §4.1: "Open:
 * verdict recomputed from current billing on each run"). Converges rows the
 * PATCH's 10 s newest-first budget did not reach, plus rows a scoped call never
 * touched: brand-new ingest before a governance-key backfill resolved them, or
 * a governance-key resweep that just un-parked previously-unresolved rows.
 *
 * Bounded + resumable (design §8.4): loops recomputeGovernanceVerdicts in
 * fixed-size batches within a wall-clock budget, mirroring
 * reconciliation-backfill.ts's BUDGET_MS pattern. Cron/HMAC-only — NOT in
 * UI_TRIGGERABLE_WORKER_NAMES (a money-adjacent bulk UPDATE is the wrong
 * one-click blast radius, per that registry's own stated bar).
 *
 * The scan covers EVERY period: recompute no longer excludes closed months
 * (recompute.ts), so the candidate set is the whole of actual_spend and grows
 * without bound. Restarting from the oldest row each run would therefore never
 * reach the newest rows once the table outgrows one 25 s budget. Instead the
 * `(date, id)` cursor persists in kv_store (mount 'governance-recompute', key
 * 'cursor'), written in the same transaction as the batch it follows, and each
 * run resumes ascending from it. A batch that finds no more rows clears the
 * cursor (`wrapped`), so the next run starts again from the oldest row.
 *
 * Convergence bound: a run always completes at least one batch, so with N rows
 * every row is revisited within ceil(N / R) + 1 runs, where R is the rows a run
 * scans (its reported `scanned`; at least RECOMPUTE_DEFAULT_BATCH unless the
 * table ends first). The +1 is the run that wraps part-way through its budget.
 * At the 15-minute cadence that is (ceil(N / R) + 1) × 15 minutes.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { sql } from 'drizzle-orm'
import { recomputeGovernanceVerdicts, RECOMPUTE_DEFAULT_BATCH } from '../governance/recompute'
import { isRealUtcDay } from '../../shared/schemas/activity'
import { isUuid } from '../utils/uuid'

type Db = PostgresJsDatabase<typeof schema>
type SqlRunner = Pick<Db, 'execute'>

const KV_MOUNT = 'governance-recompute'
const KV_CURSOR_KEY = 'cursor'

interface Cursor {
  date: string
  id: string
}

/*
 * Shape guard for the persisted cursor. A kv row is data at rest, so a corrupt
 * or stale-schema value is rejected, never cast: the run then starts from the
 * oldest row and its first batch overwrites the bad value.
 */
function parseCursor(raw: string | undefined): Cursor | null {
  if (raw == null) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o.date !== 'string' || !isRealUtcDay(o.date)) return null
  if (typeof o.id !== 'string' || !isUuid(o.id)) return null
  return { date: o.date, id: o.id }
}

async function loadCursor(db: SqlRunner): Promise<Cursor | null> {
  const rows = await db.execute<{ value: string }>(sql`
    SELECT value FROM kv_store WHERE mount = ${KV_MOUNT} AND key = ${KV_CURSOR_KEY}
  `)
  return parseCursor([...rows][0]?.value)
}

async function saveCursor(db: SqlRunner, cursor: Cursor): Promise<void> {
  const value = JSON.stringify(cursor)
  await db.execute(sql`
    INSERT INTO kv_store (mount, key, value, expires_at, updated_at)
    VALUES (${KV_MOUNT}, ${KV_CURSOR_KEY}, ${value}, NULL, now())
    ON CONFLICT (mount, key) DO UPDATE
      SET value = EXCLUDED.value, expires_at = NULL, updated_at = now()
  `)
}

async function clearCursor(db: SqlRunner): Promise<void> {
  await db.execute(sql`DELETE FROM kv_store WHERE mount = ${KV_MOUNT} AND key = ${KV_CURSOR_KEY}`)
}

/** Per-invocation budget — stays well under the run-worker HTTP gateway ceiling
 *  (see reconciliation-backfill.ts's identical rationale). */
export const GOVERNANCE_RECOMPUTE_BUDGET_MS = 25_000

export interface GovernanceRecomputeResult {
  batches: number
  scanned: number
  updated: number
  hasMore: boolean
  /** True when this run reached the end of the table and cleared the cursor,
   *  so the next run starts from the oldest row. */
  wrapped: boolean
}

export async function runGovernanceRecompute(
  db: Db,
  opts?: { budgetMs?: number; batchSize?: number },
): Promise<GovernanceRecomputeResult> {
  const budgetMs = opts?.budgetMs ?? GOVERNANCE_RECOMPUTE_BUDGET_MS
  const limit = opts?.batchSize ?? RECOMPUTE_DEFAULT_BATCH
  const deadline = Date.now() + budgetMs

  const start = await loadCursor(db)
  let afterDate = start?.date
  let afterId = start?.id
  let batches = 0
  let scanned = 0
  let updated = 0
  let hasMore = true
  let wrapped = false
  while (hasMore) {
    const r = await db.transaction(async (tx) => {
      const res = await recomputeGovernanceVerdicts(tx, { limit, afterDate, afterId })
      // Progress commits with the batch it describes: a crash between the two
      // can neither skip rows nor lose a committed batch's position.
      if (res.hasMore) await saveCursor(tx, { date: res.lastDate!, id: res.lastId! })
      else await clearCursor(tx)
      return res
    })
    batches += 1
    scanned += r.scanned
    updated += r.updated
    hasMore = r.hasMore
    if (!hasMore) {
      wrapped = true
      break // the next run starts from the oldest row
    }
    afterDate = r.lastDate
    afterId = r.lastId
    if (Date.now() >= deadline) break // resume next invocation from the stored cursor
  }
  return { batches, scanned, updated, hasMore, wrapped }
}
