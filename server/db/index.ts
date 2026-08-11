/*
 * Postgres + Drizzle client.
 *
 * Provides a single `getDb()` per Nitro lifecycle. The connection-pool
 * checkout hook sets the RLS context (app.user_region_id, app.user_org_path,
 * app.user_role, app.user_teammate_id) — wired in Epic 3 (`setRlsContext`).
 *
 * Tests do NOT call this directly — they instantiate their own postgres
 * client against a testcontainers DB. See tests/integration/db/helper.ts.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import { createDbClient } from '../../drizzle/connect'
import * as schema from '../../drizzle/schema'

let client: ReturnType<typeof createDbClient> | null = null
let db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getDb() {
  if (db) return db
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL not set — TokenScope cannot reach Postgres')
  }
  // Pin the session timezone to UTC on EVERY connection (requests AND workers
  // share this pool), so all wall-clock SQL (date_trunc / EXTRACT(ISODOW) /
  // to_char week keys — the reporting trend + seasonality, and the worker rollup
  // writes) buckets identically regardless of the server's default TZ. The whole
  // app already treats ts_event as UTC; this enforces it at the connection so read
  // and write time can never disagree.
  client = createDbClient(url, { max: 10, idle_timeout: 30, connection: { TimeZone: 'UTC' } })
  db = drizzle(client, { schema })
  return db
}

export { schema }
