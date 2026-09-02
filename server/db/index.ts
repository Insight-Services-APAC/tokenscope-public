/*
 * Postgres + Drizzle client — THE REQUEST LANE.
 *
 * Provides a single `getDb()` per Nitro lifecycle.
 *
 * ── THIS POOL CARRIES NO RLS IDENTITY, DELIBERATELY ─────────────────────────
 * There is no connection-checkout hook here and there must not be one. The
 * request lane's identity is the SESSION's, and it is set per request by
 * `server/db/request-rls.ts::withRequestRls` → `rls.ts::withRlsContext`, which
 * `SET LOCAL`s the four GUCs (app.user_region_id, app.user_org_path,
 * app.user_role, app.user_teammate_id) inside a transaction.
 *
 * A permissive connection-level default on THIS pool would be a security
 * regression, not a convenience: the handlers that have not been converted to
 * `withRequestRls` would keep working estate-wide once `FORCE ROW LEVEL
 * SECURITY` lands, and the enforcement would be silently pointless. They have
 * to fail. `scripts/check-handler-rls-context.mjs` is the CI guard driving that
 * count to zero. See docs/design/rls-enforcement.md §2, "the request lane keeps
 * NO default".
 *
 * Workers do NOT take their handle from here — they use
 * `server/db/worker-db.ts::getWorkerDb()`, a separate pool whose connections
 * carry the estate-wide `app.user_role=global-finops`.
 *
 * Tests do NOT call this directly — they instantiate their own postgres
 * client against a testcontainers DB. See tests/integration/helpers/db.ts.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import { createDbClient, runtimeDatabaseUrl } from '../../drizzle/connect'
import * as schema from '../../drizzle/schema'
import { instrumentRequestClient } from '../observability/request-timing'

let client: ReturnType<typeof createDbClient> | null = null
let db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getDb() {
  if (db) return db
  // TOKENSCOPE_APP_DATABASE_URL (the NON-OWNER role) when it is set, else
  // DATABASE_URL exactly as before — see drizzle/connect.ts. Unsetting it is
  // the rollback for the whole RLS-enforcement cutover.
  const url = runtimeDatabaseUrl()
  if (!url) {
    throw new Error('DATABASE_URL not set — TokenScope cannot reach Postgres')
  }
  // Pin the session timezone to UTC on EVERY connection of this REQUEST pool
  // (the worker lane is its own pool with the same pin —
  // server/db/worker-db.ts WORKER_CONNECTION_PARAMETERS), so all wall-clock
  // SQL (date_trunc / EXTRACT(ISODOW) / to_char week keys — the reporting
  // trend + seasonality, and the worker rollup
  // writes) buckets identically regardless of the server's default TZ. The whole
  // app already treats ts_event as UTC; this enforces it at the connection so read
  // and write time can never disagree.
  // idle_timeout 120 keeps warm connections through in-session navigation
  // (fresh TCP+TLS+SCRAM is the per-burst floor otherwise) while bounding the
  // fleet's steady-state hold. The budget is the SERVER's max_connections,
  // which is a function of the SKU's memory and therefore changes when the SKU
  // does — re-derive it after any scale, do not assume the number here
  // (`az postgres flexible-server parameter show --name max_connections`).
  // maxReplicas is 3, so 3 replicas x (10 here + the worker lane's 10, idle 60)
  // must stay under it — longer idles let a burst pin connections the next
  // replica needs. connect_timeout 10 bounds a hung connect.
  // docs/design/request-floor-performance.md F3.
  client = createDbClient(url, {
    max: 10,
    idle_timeout: 120,
    connect_timeout: 10,
    connection: { TimeZone: 'UTC' },
  })
  // O1 (docs/design/performance-observability-baseline.md, dr-H2): the REQUEST
  // pool only is wrapped for Server-Timing db/stmts attribution — an
  // API-preserving proxy that reads the ALS store at call time and is a pure
  // pass-through when none exists. The worker lane (worker-db.ts) and scripts
  // stay unwrapped.
  db = drizzle(instrumentRequestClient(client), { schema })
  return db
}

export { schema }
