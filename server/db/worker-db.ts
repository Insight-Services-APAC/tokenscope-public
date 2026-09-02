/*
 * server/db/worker-db.ts — the WORKER LANE's Postgres pool.
 *
 * WHAT THIS IS FOR (docs/design/rls-enforcement.md §2). Every connection to
 * Postgres carries an RLS identity, and which identity it carries is decided by
 * the LANE it belongs to — not by the code that happens to run on it. There are
 * three lanes: request (the session's scope, via `withRequestRls`'s SET LOCAL),
 * machine (derived from the presented credential), and worker — this one, whose
 * identity is the estate-wide `global-finops`.
 *
 * Workers are estate-wide by definition: reconciliation reconciles every scope,
 * identity-sync sweeps the whole enterprise, the rollup materialises every
 * region. Under `FORCE ROW LEVEL SECURITY` a worker on a context-less
 * connection does not error loudly — its SELECTs return ZERO ROWS silently and
 * only its writes fail. A partial bill that reports success is the failure mode
 * this file exists to prevent.
 *
 * ── WHY A POOL AND NOT A TRANSACTION WRAPPER ────────────────────────────────
 * Do NOT "improve" this into a `withWorkerRls(db, fn)` that opens a transaction
 * and SET LOCALs the GUCs. §2 of the design doc lists four independent
 * mechanisms that break, all evidenced in the tree:
 *   1. `dispatchWorker` keys its single-flight lock pool on `db.$client`
 *      (dispatch-lock.ts) and holds the advisory lock on a connection OUTSIDE
 *      the pool the run queries through. A transaction handle has no `$client`
 *      — the lock breaks before the worker runs.
 *   2. Fault isolation inverts. Five workers wrap raw `db.execute` in try/catch
 *      for per-item isolation; inside one transaction the first caught SQL error
 *      leaves the backend in 25P02 and every later statement fails.
 *   3. Fifteen call sites open `db.transaction(...)` on the handle they are
 *      given; nested transactions demote to savepoints, so `advisoryXactLock`
 *      would scope to the whole run instead of its unit of work.
 *   4. Snapshot and lock duration: `region-reenrichment` ran 134,520 ms on Dev
 *      with third-party HTTP mid-loop, and `archive-ledger.ts` takes ACCESS
 *      EXCLUSIVE to detach a partition.
 *
 * ── THE MECHANISM ───────────────────────────────────────────────────────────
 * libpq's `options` startup parameter accepts `-c name=value`, and postgres.js
 * sends every key of `connection` as a wire-protocol STARTUP PARAMETER — so the
 * GUC rides EVERY physical connection the pool opens, reconnects included, with
 * no transaction and no per-call-site ceremony. Measured (design §1, 10/10):
 * the GUC applies to every pooled checkout, persists across statements outside
 * any transaction, is visible inside a transaction the caller opens, and
 * `SET LOCAL` still narrows it locally and restores the default afterwards — so
 * the request lane is unaffected by anything this lane does.
 *
 * ONE role value is sufficient: every RLS-enabled table has at least one policy
 * carrying the `IN ('global-finops', 'platform-admin')` disjunct, and every
 * policy reads its GUCs through `current_setting(…, true)` (missing_ok), so the
 * three GUCs this lane does NOT set evaluate to NULL rather than erroring.
 *
 * ── WHY THE READBACK ASSERTION IS NOT PARANOIA ──────────────────────────────
 * A typo in the GUC NAME fails OPEN. `app.*` is a custom (extension) namespace,
 * so Postgres accepts `-c app.user_rôle=…` without complaint: the connection
 * succeeds, the policies read the name they expect, find nothing, and deny
 * silently. Every worker would then behave exactly as it does today — right up
 * until FORCE lands, at which point the estate goes quiet. So the identity is
 * READ BACK off a real connection before any handle is handed out, once per
 * process. Same argument for the TimeZone pin, which is checked in the same
 * round-trip.
 *
 * ── THE REQUEST POOL KEEPS NO DEFAULT ───────────────────────────────────────
 * `server/db/index.ts` must NOT gain a connection-level `app.user_role`. If it
 * did, the ~47 handlers that have not been converted to `withRequestRls` would
 * keep working — estate-wide — and FORCE would be silently pointless. They have
 * to fail. That is what `scripts/check-handler-rls-context.mjs` is driving to
 * zero.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import type postgres from 'postgres'
import { createDbClient, runtimeDatabaseUrl } from '../../drizzle/connect'
import * as schema from '../../drizzle/schema'

/**
 * The estate-wide RLS identity the worker lane runs as. Matches the
 * `('global-finops', 'platform-admin')` disjunct every RLS policy carries —
 * see `drizzle/migrations/0098_rls_policy_convergence.sql`.
 */
export const WORKER_RLS_ROLE = 'global-finops'

/**
 * The libpq `options` startup-parameter string that installs {@link
 * WORKER_RLS_ROLE} as a connection-level GUC. Exported so the integration test
 * harness installs the SAME identity rather than a hand-copied second spelling.
 */
export const WORKER_RLS_STARTUP_OPTIONS = `-c app.user_role=${WORKER_RLS_ROLE}`

/**
 * The startup parameters every worker-lane connection carries.
 *
 * `TimeZone: 'UTC'` is NOT decoration and NOT separable from the identity: it
 * is the single line that holds ~23 bare `timestamptz::date` day-bucket casts
 * correct (`docs/design/clock-rot-audit.md` §A, `tests/integration/db/
 * utc-pin.test.ts`). Both compose on one connection — verified against the dev
 * server across multiple physical backends.
 */
export const WORKER_CONNECTION_PARAMETERS = {
  TimeZone: 'UTC',
  options: WORKER_RLS_STARTUP_OPTIONS,
} as const

type PgOptions = postgres.Options<Record<string, postgres.PostgresType>>

/**
 * Worker-lane connection options, mirroring `server/db/index.ts`'s pool shape.
 * `overrides.connection` is merged ON TOP of {@link
 * WORKER_CONNECTION_PARAMETERS} rather than replacing it, so a caller asking
 * for (say) a `statement_timeout` cannot accidentally drop the identity.
 */
export function workerConnectionOptions(overrides: PgOptions = {}): PgOptions {
  const { connection, ...rest } = overrides
  return {
    max: 10,
    // Cron-burst lane: workers spike every 5-15 min, so 60s idle drains the
    // pool between runs — the fleet connection arithmetic lives at
    // server/db/index.ts (docs/design/request-floor-performance.md F3).
    idle_timeout: 60,
    connect_timeout: 10,
    ...rest,
    connection: { ...WORKER_CONNECTION_PARAMETERS, ...connection },
  }
}

/**
 * Read the lane's identity back off a real connection and throw if it is not
 * what we asked for. See the header: a mistyped `app.*` GUC name fails OPEN, so
 * "we passed the string" is not evidence that the identity is installed.
 */
export async function assertWorkerRlsIdentity(
  client: postgres.Sql<Record<string, unknown>>,
): Promise<void> {
  const [row] = await client<{ role: string | null; tz: string }[]>`
    SELECT current_setting('app.user_role', true) AS role,
           current_setting('TimeZone')            AS tz
  `
  if (row?.role !== WORKER_RLS_ROLE) {
    throw new Error(
      `worker pool has no RLS identity: app.user_role is ${row?.role ?? 'unset'}, expected '${WORKER_RLS_ROLE}'. ` +
        'Under FORCE ROW LEVEL SECURITY this connection would read part of the estate and report success — refusing to hand it out.',
    )
  }
  if (row.tz !== 'UTC') {
    throw new Error(
      `worker pool is not pinned to UTC: TimeZone is '${row.tz}'. Day-bucket SQL would bucket in the server's zone.`,
    )
  }
}

/**
 * Mint a NEW worker-lane pool against an explicit URL — for CLI scripts, dev/ops
 * tooling and the test harness, which own their own lifecycle and must
 * `client.end()`. The identity is proven before the handle is returned.
 */
export async function createWorkerDb(
  url: string,
  overrides?: PgOptions,
): Promise<{
  client: ReturnType<typeof createDbClient>
  db: ReturnType<typeof drizzle<typeof schema>>
}> {
  const client = createDbClient(url, workerConnectionOptions(overrides))
  try {
    await assertWorkerRlsIdentity(client)
  } catch (err) {
    await client.end({ timeout: 5 }).catch(() => undefined)
    throw err
  }
  return { client, db: drizzle(client, { schema }) }
}

let lane: {
  db: ReturnType<typeof drizzle<typeof schema>>
  identity: Promise<void>
} | null = null

/**
 * The process-wide worker-lane handle for the Nitro app (the HMAC cron surface
 * and the admin "Run now" trigger). Async on purpose: the identity readback
 * happens ONCE per process and is awaited before any caller gets a handle, so
 * there is no window in which worker code runs on an unproven connection. A
 * failed check is memoised as a rejection — the lane stays closed rather than
 * retrying its way into a silent partial run.
 */
export async function getWorkerDb(): Promise<ReturnType<typeof drizzle<typeof schema>>> {
  if (!lane) {
    // Same resolution as the request lane: TOKENSCOPE_APP_DATABASE_URL (the
    // NON-OWNER role) when set, else DATABASE_URL. The identity readback below
    // is unchanged and still runs against whichever credential that resolves to
    // — the lane's GUC has to be proven on the connection it will actually use.
    const url = runtimeDatabaseUrl()
    if (!url) {
      throw new Error('DATABASE_URL not set — TokenScope cannot reach Postgres')
    }
    const client = createDbClient(url, workerConnectionOptions())
    lane = { db: drizzle(client, { schema }), identity: assertWorkerRlsIdentity(client) }
  }
  await lane.identity
  return lane.db
}
