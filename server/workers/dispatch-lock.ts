/*
 * Per-worker dispatch lock (ING-3) — at most ONE concurrent run per worker name.
 *
 * Nothing previously stopped the same worker running twice concurrently
 * (scheduler overlap/retry, manual + cron, or an HMAC replay inside the ±300 s
 * window). Verified consequences: duplicate inbox items (the hasOpenItem →
 * dispatchInbox check-then-insert in reconciliation/budget-alert/went-silent is
 * non-atomic, with no unique constraint on inbox_item) and Copilot per-span
 * double-pricing.
 *
 * Mechanism: a SESSION-level `pg_try_advisory_lock(hashtext('worker:'||name))`
 * held on a RESERVED connection for the duration of the run. Session grain (not
 * xact) because the worker must run OUTSIDE a transaction; the reserved
 * connection pins the lock to one backend so the unlock can't land on a
 * different pooled connection. If the process dies mid-run the backend closes
 * and PG releases the lock automatically — no stuck-lock janitor needed.
 * A hashtext collision between worker names only ever over-serializes.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Sql } from 'postgres'
import type * as schema from '../../drizzle/schema'

// `drizzle(client, …)` exposes the underlying postgres-js pool as `$client`
// (drizzle-orm/postgres-js driver.d.ts) — both getDb() and the test helper
// construct the db that way. The bare PostgresJsDatabase type doesn't carry it,
// so widen explicitly.
type Db = PostgresJsDatabase<typeof schema> & { $client: Sql }

export interface WorkerDispatchLock {
  /** False when another dispatch of this worker currently holds the lock. */
  acquired: boolean
  /** Release the lock + return the reserved connection to the pool. Idempotent. */
  release: () => Promise<void>
}

export async function acquireWorkerDispatchLock(db: Db, workerName: string): Promise<WorkerDispatchLock> {
  const reserved = await db.$client.reserve()
  let released = false
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    try {
      await reserved`SELECT pg_advisory_unlock(hashtext('worker:' || ${workerName}))`
    } catch {
      // The reserved backend is gone → PG already dropped the session lock.
    } finally {
      reserved.release()
    }
  }
  try {
    const [row] = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext('worker:' || ${workerName})) AS locked
    `
    if (!row?.locked) {
      released = true
      reserved.release()
      return { acquired: false, release: async () => undefined }
    }
    return { acquired: true, release }
  } catch (err) {
    released = true
    reserved.release()
    throw err
  }
}
