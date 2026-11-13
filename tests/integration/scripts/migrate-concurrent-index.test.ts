// @vitest-environment node
/*
 * #619 / #611: the runner's concurrent-index-per-partition migration (0173) and
 * the parent index that attaches its indexes (0174). The index must end valid
 * on every partition and on the parent, a build cut short must be rebuilt
 * rather than kept invalid, and the devices read must be able to use it.
 *
 * The database is migrated by drizzle/migrate.ts itself (not the suite's
 * helper), so _drizzle_migrations is real and a second run applies only what a
 * test un-records.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { RLS_PROVISION_LOCK_CLASS, MIGRATE_LOCK_KEY } from '../../../scripts/rls-roles'

const ROOT = resolve(__dirname, '../../..')
const PARTS_MIGRATION = '0173_attribution_record_instance_ts_parts.sql'
const PARENT_MIGRATION = '0174_attribution_record_instance_ts.sql'
const PARENT_INDEX = 'attribution_record_instance_ts'
const DB_NAME = 'tokenscope_concurrent_idx'

let t: TestDb
let url = ''
let db: ReturnType<typeof postgres>

function runMigrate(timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve(ROOT, 'node_modules/.bin/tsx'), 'drizzle/migrate.ts'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url },
    })
    let out = ''
    child.stdout.on('data', (b) => (out += String(b)))
    child.stderr.on('data', (b) => (out += String(b)))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, out })
    })
  })
}

/** Every leaf partition, with its _instance_ts index's state (null: no index). */
async function partitionIndexes() {
  return db<{ part: string; valid: boolean | null; attached: boolean | null }[]>`
    SELECT c.relname AS part,
           x.indisvalid AS valid,
           EXISTS (SELECT 1 FROM pg_inherits ii
                    WHERE ii.inhrelid = ic.oid
                      AND ii.inhparent = to_regclass(${PARENT_INDEX})) AS attached
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid AND c.relkind = 'r'
      LEFT JOIN pg_class ic ON ic.relname = c.relname || '_instance_ts'
      LEFT JOIN pg_index x ON x.indexrelid = ic.oid AND x.indrelid = c.oid
     WHERE i.inhparent = 'attribution_record'::regclass
     ORDER BY c.relname`
}

async function parentValid(): Promise<boolean | null> {
  const [r] = await db<{ valid: boolean | null }[]>`
    SELECT (SELECT x.indisvalid FROM pg_index x WHERE x.indexrelid = to_regclass(${PARENT_INDEX})) AS valid`
  return r!.valid
}

function expectAllValidAndAttached(rows: Awaited<ReturnType<typeof partitionIndexes>>) {
  expect(rows.length).toBeGreaterThan(1)
  for (const r of rows) {
    expect(r.valid, `${r.part} has a valid index`).toBe(true)
    expect(r.attached, `${r.part}'s index is attached to the parent`).toBe(true)
  }
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`CREATE DATABASE ${DB_NAME}`)
  const u = new URL(t.url)
  u.pathname = `/${DB_NAME}`
  url = u.toString()
  const run = await runMigrate(170_000)
  if (run.code !== 0) throw new Error(`migrate.ts failed:\n${run.out}`)
  db = postgres(url, { max: 2 })
}, 240_000)

afterAll(async () => {
  await db?.end({ timeout: 5 })
  if (t) {
    await t.client.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => undefined)
    await stopTestDb(t)
  }
}, 60_000)

describe('attribution_record (instance_id, ts_event) INCLUDE (cost_usd)', () => {
  it('a migrated database has it valid on every partition and on the parent', async () => {
    expectAllValidAndAttached(await partitionIndexes())
    expect(await parentValid()).toBe(true)
    const applied = await db<{ name: string }[]>`
      SELECT name FROM _drizzle_migrations WHERE name IN (${PARTS_MIGRATION}, ${PARENT_MIGRATION})`
    expect(applied).toHaveLength(2)
  })

  it("the devices read's latest-row and month-spend lookups can use it", async () => {
    const reserved = await db.reserve()
    try {
      await reserved`BEGIN`
      // Empty test tables would otherwise be scanned whatever the indexes. This
      // shows the index fits the predicates; the plan on real data is checked on dev.
      await reserved`SET LOCAL enable_seqscan = off`
      await reserved`SET LOCAL enable_bitmapscan = off`
      // On empty tables the (instance_id) index ties with this one on cost (no
      // statistics say the ts_event range is narrow), so the planner may take
      // either. Taken away inside this rolled-back transaction, it shows whether
      // the new index can serve the query by itself.
      await reserved`DROP INDEX attribution_record_session`
      const plan = async (q: string) =>
        (await reserved.unsafe(q)).map((r) => String((r as Record<string, unknown>)['QUERY PLAN'])).join('\n')
      const latest = await plan(`EXPLAIN SELECT MAX(ts_event) FROM attribution_record
        WHERE instance_id = '9a1e0000-0000-4000-8000-000000000001' AND ts_event >= now() - interval '30 days'`)
      expect(latest).toMatch(/using \S+_instance_ts/)
      const spend = await plan(`EXPLAIN SELECT SUM(cost_usd) FROM attribution_record
        WHERE instance_id = '9a1e0000-0000-4000-8000-000000000001' AND ts_event >= date_trunc('month', now())`)
      // An index-only scan once the visibility map is set; an empty test table
      // has none, so either scan type on this index is the right plan here.
      expect(spend).toMatch(/using \S+_instance_ts/)
    } finally {
      await reserved`ROLLBACK`.catch(() => undefined)
      reserved.release()
    }
  })

  it('a runner waiting for the migration lock polls (no blocked statement, so no snapshot a build would wait on) and then migrates', async () => {
    const holder = await db.reserve()
    try {
      await holder`SELECT pg_advisory_lock(${RLS_PROVISION_LOCK_CLASS}::int, ${MIGRATE_LOCK_KEY}::int)`
      await db`DELETE FROM _drizzle_migrations WHERE name = ${PARENT_MIGRATION}`
      const run = runMigrate(90_000)
      // While it waits, no backend sits blocked on that advisory lock.
      await new Promise((r) => setTimeout(r, 3_000))
      const [blocked] = await db<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted
           AND classid = ${RLS_PROVISION_LOCK_CLASS} AND objid = ${MIGRATE_LOCK_KEY}`
      expect(blocked!.n).toBe(0)
      await holder`SELECT pg_advisory_unlock(${RLS_PROVISION_LOCK_CLASS}::int, ${MIGRATE_LOCK_KEY}::int)`
      const done = await run
      expect(done.code, done.out).toBe(0)
      const [row] = await db<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM _drizzle_migrations WHERE name = ${PARENT_MIGRATION}`
      expect(row!.n).toBe(1)
    } finally {
      holder.release()
    }
  }, 120_000)

  it('a build cut short is rebuilt concurrently, and 0174 builds any partition index still missing', async () => {
    const rows = await partitionIndexes()
    const victim = rows[0]!.part
    // Undo both migrations: dropping the parent index drops every attached one.
    await db.unsafe(`DROP INDEX ${PARENT_INDEX}`)
    await db`DELETE FROM _drizzle_migrations WHERE name IN (${PARTS_MIGRATION}, ${PARENT_MIGRATION})`
    // What a timed-out CREATE INDEX CONCURRENTLY leaves behind: an INVALID index.
    await db.unsafe(`CREATE INDEX "${victim}_instance_ts" ON "${victim}" (instance_id, ts_event) INCLUDE (cost_usd)`)
    await db`
      UPDATE pg_index SET indisvalid = false
       WHERE indexrelid = ${`"${victim}_instance_ts"`}::regclass`

    const first = await runMigrate(170_000)
    expect(first.code, first.out).toBe(0)
    expect(first.out).toContain(`${victim}_instance_ts was left invalid by an earlier attempt`)
    expect(first.out).toMatch(/0173_attribution_record_instance_ts_parts\.sql: built on \d+ partitions/)
    expectAllValidAndAttached(await partitionIndexes())
    expect(await parentValid()).toBe(true)

    // 0174 alone. Dropping the parent index drops every partition's too, so
    // here 0174 builds them all (in its transaction), including one partition
    // 0173 never saw.
    await db.unsafe(`DROP INDEX ${PARENT_INDEX}`)
    await db`DELETE FROM _drizzle_migrations WHERE name = ${PARENT_MIGRATION}`
    await db.unsafe(`CREATE TABLE attribution_record_2099_01 PARTITION OF attribution_record
      FOR VALUES FROM ('2099-01-01 00:00:00+00') TO ('2099-02-01 00:00:00+00')`)
    const second = await runMigrate(170_000)
    expect(second.code, second.out).toBe(0)
    const after = await partitionIndexes()
    expect(after.map((r) => r.part)).toContain('attribution_record_2099_01')
    expectAllValidAndAttached(after)
    expect(await parentValid()).toBe(true)
  }, 360_000)
})
