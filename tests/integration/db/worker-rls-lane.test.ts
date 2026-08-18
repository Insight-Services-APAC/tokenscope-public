// @vitest-environment node
/*
 * The worker lane's RLS identity, exercised the ONLY way that proves anything:
 * as a genuine NON-OWNER role, against tables that really have
 * `FORCE ROW LEVEL SECURITY` set.
 *
 * ── WHY NON-OWNER + FORCE, AND NOT "the GUC is set" ─────────────────────────
 * Production connects as the table OWNER, and an owner bypasses RLS unless the
 * table sets FORCE. So every RLS assertion in this repo that runs as the owner
 * certifies a control that is not switched on. `aggregate-rollup.test.ts:124`
 * is the standing precedent for doing it properly — it creates a real non-owner
 * login — and this file generalises it to the worker lane
 * (docs/design/rls-enforcement.md §7, "coverage that has never run under FORCE
 * is a belief, not a control").
 *
 * ── BOTH HALVES, BECAUSE ONLY ONE OF THEM IS LOUD ───────────────────────────
 * A test that only shows the fixed path passing certifies nothing, and the
 * failure that matters here is the QUIET one:
 *
 *   READ side  → a context-less connection SELECTs ZERO ROWS and the worker
 *                returns a clean success. This is the whole reason the design
 *                exists: reconciliation reporting "nothing to do" is
 *                indistinguishable from reconciliation being blind.
 *   WRITE side → the INSERT errors (42501), which at least announces itself.
 *
 * Both are asserted below against the same worker (runAggregateRollup), the same
 * fixture and the same non-owner role — the only variable is whether the pool
 * carries the lane's identity.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { createDbClient } from '../../../drizzle/connect'
import { createWorkerDb, WORKER_RLS_ROLE, workerConnectionOptions } from '../../../server/db/worker-db'
import { runAggregateRollup } from '../../../server/workers/aggregate-rollup'

let t: TestDb

/** The worker lane, as production will run it: non-owner login + lane identity. */
let laneClient: Awaited<ReturnType<typeof createWorkerDb>>['client']
let laneDb: PostgresJsDatabase<typeof schema>

/** The same non-owner login with NO identity — what every worker is today. */
let bareClient: ReturnType<typeof createDbClient>
let bareDb: PostgresJsDatabase<typeof schema>

/** Real uuids: z.string().uuid() enforces the version/variant nibbles. */
const TEAMMATE_ID = '9a1e0000-0000-4000-8000-000000000a01'
const REGION_ID = '9a1e0000-0000-4000-8000-000000000b01'
const ORG_UNIT_ID = '9a1e0000-0000-4000-8000-000000000c01'
const INSTANCE_ID = randomUUID()
const SESSION_ID = 'sess-worker-rls-lane'

/** Test-local role names so this file never collides with rls.test.ts / aggregate-rollup.test.ts. */
const ROLE = 'wrl_app'
const LOGIN = 'wrl_login'

/** Non-owner URL for the same test database. */
function scopedUrl(): string {
  const u = new URL(t.url)
  u.username = LOGIN
  u.password = 'app'
  return u.toString()
}

beforeAll(async () => {
  t = await startTestDb()

  await t.db.insert(schema.region).values({ id: REGION_ID, code: 'wrl', displayName: 'WRL' })
  await t.db.insert(schema.orgUnit).values({
    id: ORG_UNIT_ID,
    regionId: REGION_ID,
    path: 'wrl.svc',
    code: 'wrl-svc',
    displayName: 'WRL Services',
    unitType: 'bu',
  })
  await t.db.insert(schema.teammate).values({
    id: TEAMMATE_ID,
    entraOid: 'oid-wrl',
    email: 'wrl@example.com',
    regionId: REGION_ID,
    orgUnitId: ORG_UNIT_ID,
  })
  await t.db.insert(schema.instanceAttestation).values({
    instanceId: INSTANCE_ID,
    principalOid: 'oid-wrl',
    teammateId: TEAMMATE_ID,
    projectCodeHash: 'h-wrl',
    rawProjectCode: 'WRL-1',
    tool: 'claude-code',
    sessionTokenHash: `tok-${INSTANCE_ID}`,
    tsStart: new Date(),
    regionId: REGION_ID,
    orgUnitId: ORG_UNIT_ID,
  })

  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)
  // Clamp to the start of the current UTC day so a run in the first hours of a
  // UTC day cannot push the fixture into yesterday (aggregate-rollup.test.ts:100
  // records why that mattered).
  const now = Date.now()
  const todayStartUtc = new Date(now)
  todayStartUtc.setUTCHours(0, 0, 0, 0)
  const tsEvent = new Date(Math.max(todayStartUtc.getTime(), now - 2 * 3_600_000))
  await t.db.insert(schema.attributionRecord).values({
    instanceId: INSTANCE_ID,
    claudeSessionId: SESSION_ID,
    teammateId: TEAMMATE_ID,
    regionId: REGION_ID,
    orgUnitId: ORG_UNIT_ID,
    tool: 'claude-code',
    model: 'claude-fable-5',
    tokenType: 'input',
    tokens: 100_000n,
    costUsd: '0.300000',
    rateCardId: rc!.id,
    rateCardVersion: rc!.version,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent,
    sourceRunId: 'wrl-1',
  })

  // A genuine non-owner. NOLOGIN group + LOGIN member, mirroring
  // aggregate-rollup.test.ts:124-131 and the tokenscope_app role the DBA runbook
  // (design §8) provisions for real.
  await t.client.unsafe(`
    CREATE ROLE ${ROLE} NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE};
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE};
    CREATE USER ${LOGIN} WITH LOGIN PASSWORD 'app';
    GRANT ${ROLE} TO ${LOGIN};
  `)

  // PHASE 1 OF THE ROLLOUT (design §6), on the two tables this worker reads and
  // writes. Nothing in the repo enables FORCE — that is a DBA step gated on the
  // non-owner role existing — so the harness enables it here, which is the only
  // place the coverage can be honest about it.
  await t.client.unsafe(`
    ALTER TABLE attribution_record    FORCE ROW LEVEL SECURITY;
    ALTER TABLE attribution_aggregate FORCE ROW LEVEL SECURITY;
  `)

  const lane = await createWorkerDb(scopedUrl(), { max: 2, idle_timeout: 5 })
  laneClient = lane.client
  laneDb = lane.db

  // Deliberately NOT workerConnectionOptions(): same pool shape, same non-owner
  // login, no `options` startup parameter. This is every worker handle in the
  // tree before this change.
  bareClient = createDbClient(scopedUrl(), { max: 2, idle_timeout: 5, connection: { TimeZone: 'UTC' } })
  bareDb = drizzle(bareClient, { schema })
}, 180_000)

afterAll(async () => {
  await laneClient?.end({ timeout: 5 })
  await bareClient?.end({ timeout: 5 })
  await t?.client
    .unsafe(
      `DROP OWNED BY ${ROLE} CASCADE;
       DROP USER IF EXISTS ${LOGIN};
       DROP ROLE IF EXISTS ${ROLE};`,
    )
    .catch(() => undefined)
  if (t) await stopTestDb(t)
}, 30_000)

describe('the worker lane carries an RLS identity', () => {
  it('GUARDS THE GUARD — the role is genuinely non-owner and FORCE is genuinely on', async () => {
    /*
     * Without this, every assertion below could pass while RLS never ran at all.
     * Two distinct facts, easy to conflate:
     *
     *   - RLS binds a NON-OWNER as soon as the table has it ENABLED. FORCE is
     *     not needed for that.
     *   - FORCE is what additionally binds the table's OWNER — which is what
     *     production connects as (`keyvault-secrets.bicep` administratorLogin),
     *     and why 40 policies in this repo are decoration today.
     *
     * The rollout (design §6/§8) creates a non-owner role AND sets FORCE, so the
     * harness sets up both. Note the harness's own `t.client` is the container's
     * SUPERUSER, which bypasses RLS unconditionally — superuser is not "owner",
     * and no amount of FORCE binds it. That is precisely why a separate
     * non-owner login is the only honest way to test this.
     */
    const [forced] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM pg_class
      WHERE relname IN ('attribution_record', 'attribution_aggregate')
        AND relrowsecurity AND relforcerowsecurity
    `
    expect(Number(forced!.n)).toBe(2)

    const [owner] = await t.client<{ owner: string }[]>`
      SELECT tableowner AS owner FROM pg_tables WHERE tablename = 'attribution_aggregate'
    `
    expect(owner!.owner).not.toBe(ROLE)
    expect(owner!.owner).not.toBe(LOGIN)

    // The harness (superuser) connection still sees the fixture — so a zero
    // below is RLS denying, not an empty table.
    const [ownerRows] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM attribution_record WHERE teammate_id = ${TEAMMATE_ID}::uuid
    `
    expect(Number(ownerRows!.n)).toBe(1)
  })

  it('the lane pool really carries app.user_role, on every backend it opens', async () => {
    const seen = await Promise.all(
      [0, 1].map(
        () => laneClient<{ pid: string; role: string | null; tz: string }[]>`
          SELECT pg_backend_pid()::text AS pid,
                 current_setting('app.user_role', true) AS role,
                 current_setting('TimeZone') AS tz,
                 pg_sleep(0.15)
        `,
      ),
    )
    const pids = new Set(seen.map((r) => r[0]!.pid))
    expect(pids.size).toBe(2) // two distinct physical connections
    for (const r of seen) {
      expect(r[0]!.role).toBe(WORKER_RLS_ROLE)
      expect(r[0]!.tz).toBe('UTC') // the pin composes with the identity
    }

    // …and the context-less pool, on the same login, carries neither.
    const [bare] = await bareClient<{ role: string | null }[]>`
      SELECT current_setting('app.user_role', true) AS role
    `
    expect(bare!.role).toBeNull()
  })

  it('RED (silent) — the same worker on a context-less pool sees NOTHING and reports success', async () => {
    /*
     * THE FAILURE THIS STORY EXISTS TO PREVENT. Not an error — a clean return.
     * The day-set SELECT reads attribution_record, RLS denies every row, so the
     * worker concludes there is no work, reports backfillComplete and exits 0.
     * A scheduler sees a green tick; an operator sees a fresh worker_run row.
     */
    const result = await runAggregateRollup(bareDb)
    expect(result.daysRecomputed).toBe(0)
    expect(result.teammateCells).toBe(0)
    expect(result.backfillComplete).toBe(true) // "success"

    // And nothing was materialised — read as the OWNER so this is the table's
    // truth, not another RLS-denied zero.
    const [cells] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM attribution_aggregate
       WHERE scope_type = 'teammate' AND scope_id = ${TEAMMATE_ID}::uuid
    `
    expect(Number(cells!.n)).toBe(0)
  })

  it('RED (loud) — when it CAN see the ledger, the context-less pool cannot write the rollup', async () => {
    // Let the read half through so execution reaches the INSERT. Only the write
    // half of the lane is under test here.
    // Let the READ half through so execution reaches the INSERT; only the write
    // half is under test here. RLS is DISABLED (not just un-FORCEd) because a
    // non-owner is bound by an RLS-enabled table whether or not FORCE is set —
    // FORCE is what additionally binds the OWNER. See the guard test.
    await t.client.unsafe(`ALTER TABLE attribution_record DISABLE ROW LEVEL SECURITY`)
    try {
      const [visible] = await bareClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM attribution_record`
      expect(Number(visible!.n)).toBe(1) // the ledger is readable, so the worker will find work

      // Asserted on the CAUSE, not the message: drizzle wraps the driver error
      // in "Failed query: <sql>", so matching the outer message would pass on
      // any SQL failure at all — a syntax error, a missing column, anything.
      // 42501 + this text is specifically "RLS refused the write".
      const err = await runAggregateRollup(bareDb).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Error)
      const cause = (err as { cause?: { code?: string; message?: string } }).cause
      expect(cause?.code).toBe('42501') // insufficient_privilege
      expect(cause?.message).toMatch(
        /new row violates row-level security policy for table "attribution_aggregate"/,
      )
    } finally {
      await t.client.unsafe(`
        ALTER TABLE attribution_record ENABLE ROW LEVEL SECURITY;
        ALTER TABLE attribution_record FORCE ROW LEVEL SECURITY;
      `)
    }
  })

  it('GREEN — on the worker pool the same worker sees the estate and materialises it', async () => {
    const result = await runAggregateRollup(laneDb)
    expect(result.daysRecomputed).toBeGreaterThan(0)
    expect(result.teammateCells).toBeGreaterThan(0)

    // Verified as the OWNER: the cells are really in the table, not merely
    // reported by a connection that can see its own writes.
    const [cells] = await t.client<{ n: string; cost: string }[]>`
      SELECT count(*)::text AS n, COALESCE(SUM(total_cost_usd), 0)::text AS cost
        FROM attribution_aggregate
       WHERE scope_type = 'teammate' AND scope_id = ${TEAMMATE_ID}::uuid
    `
    expect(Number(cells!.n)).toBeGreaterThan(0)
    expect(Number(cells!.cost)).toBeCloseTo(0.3, 6)

    // The lane can read them back too — estate-wide, with no per-call ceremony
    // and no transaction wrapper.
    const laneSees = await laneDb.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM attribution_aggregate
       WHERE scope_type = 'teammate' AND scope_id = ${TEAMMATE_ID}::uuid
    `)
    expect(Number([...laneSees][0]!.n)).toBe(Number(cells!.n))
  })

  it('SET LOCAL still narrows a lane connection, and the default restores after', async () => {
    // Why the request lane is unaffected by this one (design §1/§2): a
    // per-request `withRequestRls` narrowing composes with, and beats, a
    // connection-level default — and does not leak past its transaction.
    await laneDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_role', 'developer', true)`)
      const inner = await tx.execute<{ role: string }>(
        sql`SELECT current_setting('app.user_role', true) AS role`,
      )
      expect([...inner][0]!.role).toBe('developer')
    })
    const after = await laneDb.execute<{ role: string }>(
      sql`SELECT current_setting('app.user_role', true) AS role`,
    )
    expect([...after][0]!.role).toBe(WORKER_RLS_ROLE)
  })

  it('a mistyped GUC name fails CLOSED — the readback catches what Postgres will not', async () => {
    /*
     * `app.*` is a custom namespace, so Postgres accepts `-c app.user_rolle=…`
     * without complaint: the connection succeeds and the policies simply never
     * find the setting they read. Measured — the connection comes up and
     * `current_setting('app.user_role', true)` is NULL. That is a silent estate
     * outage waiting for FORCE, and the ONLY thing standing between us and it is
     * assertWorkerRlsIdentity reading the value back off a live connection.
     */
    await expect(
      createWorkerDb(scopedUrl(), {
        max: 1,
        idle_timeout: 5,
        connection: { options: `-c app.user_rolle=${WORKER_RLS_ROLE}` },
      }),
    ).rejects.toThrow(/worker pool has no RLS identity/)

    // The typo'd connection would otherwise have come up perfectly happily.
    const typo = createDbClient(
      scopedUrl(),
      workerConnectionOptions({
        max: 1,
        idle_timeout: 5,
        connection: { options: `-c app.user_rolle=${WORKER_RLS_ROLE}` },
      }),
    )
    try {
      const [row] = await typo<{ role: string | null }[]>`
        SELECT current_setting('app.user_role', true) AS role`
      expect(row!.role).toBeNull()
    } finally {
      await typo.end({ timeout: 5 })
    }
  })
})
