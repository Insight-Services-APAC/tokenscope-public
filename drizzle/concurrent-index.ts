/*
 * drizzle/concurrent-index.ts: the one migration shape that cannot run in a
 * transaction (#619, #611). Used by drizzle/migrate.ts (every boot) and by the
 * integration suite's migration helper, so both build the schema the same way.
 *
 * A migration file whose FIRST line is
 *   -- migrate: concurrent-index-per-partition <partitioned table>
 * holds ONE statement:
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS <name with {partition}> ON {partition} (...)
 * It runs outside any transaction, once per leaf partition of that table, with
 * {partition} replaced by the partition's name. CONCURRENTLY cannot run in a
 * transaction, and on a partitioned table it cannot run at all; hence the loop.
 * The build does not block inserts.
 *
 * A build that fails part-way leaves an INVALID index, which IF NOT EXISTS would
 * keep for good. So before each build, an invalid index of exactly that name on
 * exactly that partition (and nothing else) is dropped and built again. A run cut
 * short keeps every partition already finished.
 *
 * A later, ordinary migration creates the parent index ON ONLY and attaches the
 * partitions' indexes (0174 is the example).
 */
import type postgres from 'postgres'

type Sql = ReturnType<typeof postgres>

const DIRECTIVE = /^--\s*migrate:\s*concurrent-index-per-partition\s+([a-z_][a-z0-9_]*)\s*$/
const STATEMENT =
  /^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+("?)([a-z_{}][a-z0-9_{}]*)\2\s+ON\s+\{partition\}\s/i

export interface ConcurrentPerPartition {
  table: string
  unique: boolean
  /** The index name, with {partition} still in it. */
  indexTemplate: string
  /** The statement after `ON {partition} `: columns, INCLUDE, WHERE. */
  tail: string
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** The parsed file, or null for an ordinary (transactional) migration. Throws on a malformed one. */
export function parseConcurrentPerPartition(file: string, body: string): ConcurrentPerPartition | null {
  const [first = '', ...rest] = body.split('\n')
  const directive = DIRECTIVE.exec(first.trim())
  if (!directive) return null
  const statement = rest
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .trim()
    .replace(/;\s*$/, '')
  const shape = STATEMENT.exec(statement)
  const tail = shape ? statement.slice(shape[0].length) : ''
  // Lower case only: the name is quoted when used, so an upper-case one would
  // not fold as Postgres folds an unquoted name.
  const name = shape?.[3] ?? ''
  if (
    !shape ||
    statement.includes(';') ||
    tail.includes('{partition}') ||
    !name.includes('{partition}') ||
    name !== name.toLowerCase()
  ) {
    throw new Error(
      `${file}: expected one CREATE INDEX CONCURRENTLY IF NOT EXISTS <name with {partition}> ON {partition} statement`,
    )
  }
  return { table: directive[1]!, unique: Boolean(shape[1]), indexTemplate: shape[3]!, tail }
}

export interface ApplyOptions {
  /** lock_timeout for each build; restored to `restoreLockTimeout` afterwards. */
  lockTimeout: string
  restoreLockTimeout: string
  /** Wraps each partition's step (the runner retries lock timeouts). */
  step?: (run: () => Promise<void>) => Promise<void>
  log?: (line: string) => void
}

/**
 * Builds the index on every leaf partition, in name order. Returns the number
 * of partitions built or found built. `sql` must be ONE session (max: 1, no idle
 * timeout): lock_timeout is a session setting.
 */
export async function applyConcurrentPerPartition(
  sql: Sql,
  file: string,
  m: ConcurrentPerPartition,
  opts: ApplyOptions,
): Promise<number> {
  const log = opts.log ?? ((l: string) => console.warn(l))
  const step = opts.step ?? ((run) => run())
  const partitions = await sql<{ name: string }[]>`
    SELECT c.relname AS name
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = ${m.table}::regclass AND c.relkind = 'r'
     ORDER BY c.relname`
  if (!partitions.length) throw new Error(`${file}: ${m.table} has no partitions`)

  let done = 0
  let failed = false
  await sql.unsafe(`SET lock_timeout = '${opts.lockTimeout}'`)
  try {
    for (const { name } of partitions) {
      const indexName = m.indexTemplate.replaceAll('{partition}', name)
      // Postgres would truncate a longer name, and the invalid-index check
      // below would then look for a name that does not exist.
      if (indexName.length > 63) throw new Error(`${file}: index name ${indexName} is over 63 characters`)
      const create = `CREATE ${m.unique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(indexName)} ON ${quoteIdent(name)} ${m.tail}`
      let skipped = false
      await step(async () => {
        // The archive worker may have detached (and dropped) it since the list
        // was read; a partition that has left the table needs no index.
        const [still] = await sql<{ attached: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
             WHERE i.inhparent = ${m.table}::regclass AND c.relname = ${name}) AS attached`
        if (!still?.attached) {
          skipped = true
          return
        }
        const [stale] = await sql<{ invalid: boolean }[]>`
          SELECT NOT x.indisvalid AS invalid
            FROM pg_index x
            JOIN pg_class ic ON ic.oid = x.indexrelid
            JOIN pg_class t ON t.oid = x.indrelid
           WHERE t.relname = ${name} AND ic.relname = ${indexName}`
        if (stale?.invalid) {
          log(`${file}: ${indexName} was left invalid by an earlier attempt; building it again`)
          await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(indexName)}`)
        }
        const started = Date.now()
        await sql.unsafe(create)
        log(`${file}: ${indexName} ready in ${Date.now() - started} ms`)
      })
      if (skipped) log(`${file}: ${name} is no longer a partition of ${m.table}; skipped`)
      else done += 1
    }
  } catch (err) {
    failed = true
    throw err
  } finally {
    const restore = sql.unsafe(`SET lock_timeout = '${opts.restoreLockTimeout}'`)
    // After a failure, a failed restore (a dropped connection) must not replace
    // the real error. After success it must fail the run: a lost connection
    // means the runner's advisory lock went with it, and carrying on would
    // record this file and run the next without the lock.
    if (failed) await restore.catch(() => undefined)
    else await restore
  }
  log(`${file}: built on ${done} partitions of ${m.table}`)
  return done
}
