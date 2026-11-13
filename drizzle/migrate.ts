// TokenScope migration runner.
//
// Runs all numbered .sql files in drizzle/migrations/ in lexical order
// against $DATABASE_URL. Hand-written migrations (not drizzle-kit-managed)
// because the data model uses PG-native constructs Drizzle's diff doesn't
// render cleanly (EXCLUDE USING gist, RLS policies, custom triggers).
//
// Records applied migrations in `_drizzle_migrations(name TEXT PRIMARY KEY,
// applied_at TIMESTAMPTZ)` so re-runs skip already-applied steps.
//
// Each file runs in one transaction, except a concurrent-index-per-partition
// file (drizzle/concurrent-index.ts), which builds an index on each partition
// of a table outside any transaction and is recorded once every partition has it.

import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDbClient } from './connect'
import { RLS_PROVISION_LOCK_CLASS, MIGRATE_LOCK_KEY } from '../scripts/rls-roles'
import { applyConcurrentPerPartition, parseConcurrentPerPartition } from './concurrent-index'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

// Every replica runs this at boot, so they serialise on an advisory lock. A
// replica that cannot get it in LOCK_WAIT exits non-zero and the next boot
// retries (measured, see provision-app-role.ts LOCK_WAIT).
//
// The waiting replicas POLL with pg_try_advisory_lock rather than block in
// pg_advisory_lock. A blocked SELECT holds a snapshot for its whole wait, and a
// concurrent index build waits for every older snapshot to finish: the
// builder would wait on the replica that waits on the builder's lock.
const LOCK_WAIT = '120s'
const LOCK_WAIT_MS = 120_000
const LOCK_POLL_MS = 1_000
// Bounds each migration's wait for a table lock, so DDL queued behind a long
// query on the serving revision fails the boot instead of blocking that
// revision's traffic behind its ACCESS EXCLUSIVE request.
const MIGRATION_LOCK_TIMEOUT = '5s'
// A lock timeout is retried, so one slow reader on the serving revision does
// not fail the boot. Worst case ~45s, inside the other replicas' LOCK_WAIT.
const MIGRATION_LOCK_ATTEMPTS = 6
const LOCK_NOT_AVAILABLE = '55P03'
const DEADLOCK_DETECTED = '40P01'
// A concurrent build ends by waiting for every older transaction in the
// database to finish. It blocks nobody while it waits, and a timeout there
// would throw away a finished scan of the partition, so it waits as long as it
// takes ('0' = no lock timeout). If the container is stopped meanwhile, the
// server finishes the build on its own and the next boot finds it done.
const CONCURRENT_LOCK_TIMEOUT = '0'

/** A lock timeout, or a deadlock Postgres broke by cancelling us: both are worth another go. */
function isLockTimeout(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === LOCK_NOT_AVAILABLE || code === DEADLOCK_DETECTED
}

/** Runs `step`, retrying a lock timeout as the transactional path does. */
async function withLockRetries(file: string, step: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await step()
      return
    } catch (err) {
      if (!isLockTimeout(err) || attempt >= MIGRATION_LOCK_ATTEMPTS) throw err
      console.warn(`${file}: lock timeout, retry ${attempt}/${MIGRATION_LOCK_ATTEMPTS - 1}`)
      await new Promise((r) => setTimeout(r, attempt * 1000 + Math.random() * 500))
    }
  }
}

/*
 * Recording a migration and checking the lock are ONE statement: the row is
 * inserted only while THIS session holds the migration lock. If the connection
 * was replaced, the lock went with it, and recording would let another replica
 * apply the next file at the same time. A separate check before the insert
 * would leave a reconnect between the two.
 */
const LOCK_HELD_SQL = `EXISTS (
  SELECT 1 FROM pg_locks
   WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
     AND classid = ${RLS_PROVISION_LOCK_CLASS} AND objid = ${MIGRATE_LOCK_KEY} AND objsubid = 2)`
const LOST_LOCK = 'migrate: this session no longer holds the migration lock (connection replaced); stopping'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL not set')
    process.exit(1)
  }

  // max: 1 — the advisory lock belongs to one backend session. postgres.js
  // replaces a connection silently: after an idle timeout (a retry's back-off
  // can pass 5 s) and at the end of its default 30 to 60 minute lifetime. A
  // replaced connection has lost the advisory lock (and lock_timeout), so both
  // are off here, and every record (and build) checks the lock first.
  const sql = createDbClient(url, { max: 1, idle_timeout: 0, max_lifetime: 0 })
  let locked = false
  try {
    await sql.unsafe(`SET lock_timeout = '${LOCK_WAIT}'`)
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      const [got] = await sql<{ ok: boolean }[]>`
        SELECT pg_try_advisory_lock(${RLS_PROVISION_LOCK_CLASS}::int, ${MIGRATE_LOCK_KEY}::int) AS ok`
      if (got?.ok) break
      if (Date.now() >= deadline) throw new Error(`migrate: another replica held the migration lock for ${LOCK_WAIT}`)
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS))
    }
    locked = true

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS _drizzle_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort()

    const applied = new Set(
      (await sql`SELECT name FROM _drizzle_migrations`).map((r) => r.name as string),
    )

    let appliedCount = 0
    for (const file of files) {
      if (applied.has(file)) continue
      const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      console.warn(`Applying ${file}...`)
      const concurrent = parseConcurrentPerPartition(file, body)
      if (concurrent) {
        await applyConcurrentPerPartition(sql, file, concurrent, {
          lockTimeout: CONCURRENT_LOCK_TIMEOUT,
          restoreLockTimeout: LOCK_WAIT,
          // Each partition's build starts only while this session holds the lock.
          step: (run) =>
            withLockRetries(file, async () => {
              const [held] = await sql<{ ok: boolean }[]>`SELECT ${sql.unsafe(LOCK_HELD_SQL)} AS ok`
              if (!held?.ok) throw new Error(LOST_LOCK)
              await run()
            }),
        })
        const rec = await sql`INSERT INTO _drizzle_migrations (name) SELECT ${file} WHERE ${sql.unsafe(LOCK_HELD_SQL)}`
        if (rec.count !== 1) throw new Error(LOST_LOCK)
      } else {
        await withLockRetries(file, () =>
          sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`)
            await tx.unsafe(body)
            const rec = await tx`INSERT INTO _drizzle_migrations (name) SELECT ${file} WHERE ${tx.unsafe(LOCK_HELD_SQL)}`
            // Throwing rolls the migration back with the transaction.
            if (rec.count !== 1) throw new Error(LOST_LOCK)
          }),
        )
      }
      appliedCount += 1
    }

    console.warn(
      appliedCount
        ? `Applied ${appliedCount} migration${appliedCount === 1 ? '' : 's'}.`
        : 'All migrations already applied.',
    )
  } finally {
    if (locked) {
      await sql`SELECT pg_advisory_unlock(${RLS_PROVISION_LOCK_CLASS}::int, ${MIGRATE_LOCK_KEY}::int)`.catch(() => undefined)
    }
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
