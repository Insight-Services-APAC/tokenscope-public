/*
 * Worker dispatch lock (ING-3): at most one concurrent run per worker name.
 *
 * A session-level advisory lock held on a connection that stays open for the
 * whole run. Session-level on purpose: if the container dies mid-run, Postgres
 * drops the connection and the lock with it, so a redeploy never leaves a
 * worker undispatchable until the 180-minute reaper.
 *
 * INVARIANT: the lock connection comes from a DEDICATED pool, never from the
 * pool the run queries through. A dispatch that pins a request-pool connection
 * for its lock and then needs a second one from the same pool deadlocks the
 * whole batch once the pool is full (dev incident 2026-08-27 — see the
 * regression test in tests/integration/workers/dispatch-worker.test.ts and
 * CHANGELOG). A lock-pool holder never needs a second lock-pool connection, so
 * this pool cannot starve itself.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Sql } from 'postgres'
import type * as schema from '../../drizzle/schema'
import { clientUrl, createDbClient } from '../../drizzle/connect'

type Db = PostgresJsDatabase<typeof schema> & { $client: Sql }

/*
 * One lock connection per in-flight worker. 32 workers exist and the largest
 * cron coincidence (`:00`) dispatches 19, so 24 covers a full batch with room;
 * a 25th dispatch queues on the lock pool (and never deadlocks: a holder needs
 * nothing further from this pool). Short idle_timeout so the connections are
 * gone between batches — they count against Dev PG's max_connections 50
 * alongside the request (10) and worker (10) lanes per replica
 * (server/db/index.ts).
 */
export const DISPATCH_LOCK_POOL_MAX = 24

const lockClients = new WeakMap<object, Sql>()

/**
 * The lock pool for the database `db` points at — one per parent client,
 * opened on first use. Throws if the parent was not made by createDbClient
 * (its URL is unknown): falling back to reserving off the parent pool would
 * silently restore the deadlock this module exists to prevent.
 */
function lockClientFor(db: Db): Sql {
  const parent = db.$client
  const existing = lockClients.get(parent)
  if (existing) return existing
  const url = clientUrl(parent)
  if (!url) {
    throw new Error(
      'dispatch-lock: db client has no registered URL — open it via createDbClient (drizzle/connect.ts)',
    )
  }
  const client = createDbClient(url, {
    max: DISPATCH_LOCK_POOL_MAX,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: { TimeZone: 'UTC' },
  })
  lockClients.set(parent, client)
  return client
}

export interface WorkerDispatchLock {
  acquired: boolean
  release: () => Promise<void>
}

/**
 * Try to take the per-worker advisory lock. Non-blocking: a second dispatch of
 * the same name gets `acquired: false` immediately (the caller turns that into
 * a 409). `release` unlocks and returns the connection to the lock pool; it is
 * idempotent and safe to call on a loser.
 */
export async function acquireWorkerDispatchLock(db: Db, workerName: string): Promise<WorkerDispatchLock> {
  const reserved = await lockClientFor(db).reserve()
  let released = false
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    try {
      await reserved`SELECT pg_advisory_unlock(hashtext('worker:' || ${workerName}))`
    } catch {
      // The connection may already be gone; Postgres released the lock with it.
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

/** Close the lock pool opened for `db` (tests / shutdown). No-op if none was opened. */
export async function closeDispatchLockPool(db: Db): Promise<void> {
  const client = lockClients.get(db.$client)
  if (!client) return
  lockClients.delete(db.$client)
  await client.end({ timeout: 5 })
}
