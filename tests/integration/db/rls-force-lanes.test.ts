// @vitest-environment node
/*
 * THE READINESS HARNESS — docs/design/rls-enforcement.md §The readiness harness.
 *
 * "Coverage that has never run under FORCE is a belief, not a control." Every
 * other test in this repo runs as the table OWNER, for whom RLS is inert; a
 * handler that lost its RLS context passes all of them and fails in production.
 * This file is the one that would catch it: it creates a genuinely NON-OWNER
 * role, enables `FORCE ROW LEVEL SECURITY` on the design's phase-1 set, points
 * `getDb()` at that role, and drives converted route handlers through it.
 *
 * Generalises the precedent at tests/integration/workers/aggregate-rollup.test.ts
 * (the only test that exercised RLS as a non-owner) from a module call to a
 * ROUTE call — CLAUDE.md rule 10, "a module test is not a route test".
 *
 * EVERY GREEN ASSERTION HAS A RED TWIN. A test that only shows the converted
 * handler working proves nothing: it would pass just as well if RLS were inert
 * and the harness were broken. So each case pairs the handler's result with the
 * SAME query run on a context-less handle — the shape the handler had BEFORE the
 * conversion — and asserts that one comes back empty or errors. If the harness
 * ever stops enforcing RLS, the red twins go green and the file fails.
 *
 * WHAT PHASES A ROLLOUT, given that mechanic. `FORCE` changes nothing for a
 * NON-OWNER — Postgres applies a table's policies to every role except the
 * owner, so `ENABLE` alone binds them (a superuser bypasses unconditionally;
 * the default testcontainers user is one, which is why this file builds its own
 * login). §The mechanism, measured states that correction. Its CONSEQUENCE for
 * §The OAuth lane, which still reads as though omission from the FORCE set
 * were the mitigation, does not follow from it automatically: the moment the
 * §DBA runbook switches the app to `tokenscope_app`, every currently-ENABLE'd
 * table binds at once — `oauth_token` included, which §The OAuth lane requires
 * to stay open because `requireOAuthBearer` must read it before any GUC can
 * exist. Phasing therefore needs the INVERSE operation, `DISABLE ROW LEVEL
 * SECURITY` on the tables a phase has not reached. That is what this harness
 * does, and `the bootstrap tables are live for a non-owner` below proves the
 * consequence rather than asserting it in prose.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { recordAuditEvent } from '../../../server/db/audit'
import { withRlsContext } from '../../../server/db/rls'
import { pgErrorCode } from '../../../server/db/pg-error'

/**
 * Assert a promise was refused BY RLS specifically.
 *
 * `42501 insufficient_privilege` is the SQLSTATE a policy violation raises.
 * Matching on the message is not an option: Drizzle wraps the PostgresError, so
 * `err.message` is "Failed query: insert into …" and a `/row-level security/`
 * matcher passes on nothing and fails on everything. Matching the CODE also
 * stops this from passing for the wrong reason — a missing GRANT, a typo'd
 * column, or a constraint violation all raise different codes.
 */
async function expectRlsRefusal(p: Promise<unknown>): Promise<void> {
  let code: string | undefined
  let threw = false
  try {
    await p
  } catch (err) {
    threw = true
    code = pgErrorCode(err)
  }
  expect(threw, 'expected the statement to be refused, but it succeeded').toBe(true)
  expect(code, 'expected SQLSTATE 42501 (RLS policy violation)').toBe('42501')
}

/**
 * The phase-1 FORCE set, verbatim from docs/design/rls-enforcement.md §Rollout:
 * "the money and attribution tables, where cross-region leakage is the actual
 * risk and handler coverage is best".
 */
const PHASE_1_FORCE = [
  'attribution_record',
  'attribution_aggregate',
  'unaccounted_usage',
  'over_emission',
  'allocation',
  'project',
  'usage_signal_record',
] as const

let t: TestDb
/** A connection as the NON-OWNER role — the thing that makes RLS execute. */
let appClient: ReturnType<typeof postgres>
let appDb: ReturnType<typeof drizzle<typeof schema>>

let regionId: string
let otherRegionId: string
let orgPath: string
let orgUnitId: string
let projectId: string
let adminTeammateId: string
let devTeammateId: string
let instanceId: string
/** RLS-enabled tables OUTSIDE phase 1, disabled so this really is phase 1. */
let otherRlsTables: string[] = []

// Real uuids (CLAUDE.md rule 18: z.string().uuid() enforces version + variant
// nibbles, so a convenient 0000…-0001 400s before reaching the behaviour).
const UNKNOWN_PROJECT_ID = '9a1e0000-0000-4000-8000-00000000f001'

beforeAll(async () => {
  t = await startTestDb()
  process.env.NUXT_SESSION_SECRET = 'rls-force-lanes-secret-padded-to-32-chars!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'rls-force-lanes-hmac-key-padded-well-beyond-32'

  // ── Seed AS THE OWNER, before FORCE is on ────────────────────────────────
  const [r] = await t.db.insert(schema.region).values({ code: 'rf1', displayName: 'RF One' }).returning()
  regionId = r!.id
  const [r2] = await t.db.insert(schema.region).values({ code: 'rf2', displayName: 'RF Two' }).returning()
  otherRegionId = r2!.id

  // A genuine root + a nested unit: placedBelowRegionRoot() requires the
  // caller's own home to be a real, non-root unit (0098 (d)).
  const [root] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'rf1', code: 'default', displayName: 'RF One (default)', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, parentId: root!.id, path: 'rf1.alpha', code: 'rf-alpha', displayName: 'Alpha', unitType: 'practice', isCostOwningUnit: true })
    .returning()
  orgUnitId = ou!.id
  orgPath = ou!.path

  const [proj] = await t.db
    .insert(schema.project)
    .values({ code: 'RF-A', codeHash: 'h-rf-a', displayName: 'RF A', type: 'billable', regionId, costOwningUnitId: orgUnitId })
    .returning({ id: schema.project.id })
  projectId = proj!.id

  const [admin] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'rf-oid-admin', email: 'rf-admin@example.com', displayName: 'RF Admin', role: 'admin', regionId, orgUnitId })
    .returning()
  adminTeammateId = admin!.id
  const [dev] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'rf-oid-dev', email: 'rf-dev@example.com', displayName: 'RF Dev', role: 'developer', regionId, orgUnitId })
    .returning()
  devTeammateId = dev!.id

  instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId, principalOid: 'rf-oid-att', principalEmail: 'rf-dev@example.com', teammateId: devTeammateId,
    tool: 'claude-code', sessionTokenHash: 'tok-' + instanceId, tsStart: new Date(),
    regionId, orgUnitId, costOwningUnitId: orgUnitId,
    // `instance_attestation_attested_has_project` — the default 'attested'
    // state requires a project_code_hash; this device is untagged.
    attestationState: 'unassigned',
  })

  const [rc] = await t.db.select({ id: schema.rateCard.id, version: schema.rateCard.version }).from(schema.rateCard).limit(1)
  await t.db.insert(schema.attributionRecord).values({
    instanceId, teammateId: devTeammateId, projectId, regionId, orgUnitId, costOwningUnitId: orgUnitId,
    tool: 'claude-code', model: 'claude-opus-4-1', tokenType: 'output', tokens: BigInt(1000), costUsd: '42.000000',
    rateCardId: rc!.id, rateCardVersion: rc!.version, fidelityTier: 'tier-1', costBasis: 'estimated', tsEvent: new Date(),
  })

  // An oauth_token for devTeammateId. Without this row the bearer-lookup test
  // below counts rows in an EMPTY table, so "the non-owner sees 0" is true for
  // the wrong reason and the assertion cannot fail.
  const [oc] = await t.db
    .insert(schema.oauthClient)
    .values({ clientSecretHash: 'csh-rf', clientName: 'RF Client', redirectUris: ['http://127.0.0.1:7777/callback'] })
    .returning()
  const tokenNow = Date.now()
  await t.db.insert(schema.oauthToken).values({
    accessTokenHash: `rf-acc-${randomUUID()}`, refreshTokenHash: `rf-ref-${randomUUID()}`,
    // NOT 'tokenscope.emit': oauth_token_one_live_emit_per_instance is a partial
    // unique index over emit-scoped rows, and the machine-lane tests below mint a
    // real emit credential for this instance. This fixture only has to EXIST for
    // the teammate so the bearer-lookup count is non-zero for the owner.
    clientId: oc!.clientId, teammateId: devTeammateId, scope: 'tokenscope.read',
    accessIssuedAt: new Date(tokenNow), accessExpiresAt: new Date(tokenNow + 3_600_000),
    refreshIssuedAt: new Date(tokenNow), refreshExpiresAt: new Date(tokenNow + 86_400_000),
  })

  // ── The NON-OWNER role (mirrors §The DBA runbook, and the aggregate-rollup
  //    precedent this generalises) ────────────────────────────────────────────
  await t.client.unsafe(`
    CREATE ROLE rls_force_app NOLOGIN;
    GRANT USAGE ON SCHEMA public TO rls_force_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_force_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rls_force_app;
    CREATE USER rls_force_login WITH LOGIN PASSWORD 'app';
    GRANT rls_force_app TO rls_force_login;
  `)

  // ── Phase 1, modelled HONESTLY for a non-owner (see the file header) ──────
  // FORCE the seven money tables, and DISABLE every other RLS-enabled table:
  // for a non-owner, "not in the FORCE set" does not mean "not enforced", so
  // disabling is the only thing that actually makes this phase 1 rather than
  // phase 1-2-3 at once. `oauth_token` in particular MUST be open here — §The OAuth lane
  // rules it the bootstrap for every lane.
  const enabled = await t.client<{ relname: string }[]>`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relkind = 'r'
  `
  otherRlsTables = enabled
    .map((r) => r.relname)
    .filter((name) => !(PHASE_1_FORCE as readonly string[]).includes(name))
  for (const table of otherRlsTables) {
    await t.client.unsafe(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`)
  }
  for (const table of PHASE_1_FORCE) {
    await t.client.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
  }

  const scopedUrl = new URL(t.url)
  scopedUrl.username = 'rls_force_login'
  scopedUrl.password = 'app'
  // Same connection options production uses (server/db/index.ts pins UTC).
  appClient = postgres(scopedUrl.toString(), { max: 4, idle_timeout: 5, connection: { TimeZone: 'UTC' } })
  appDb = drizzle(appClient, { schema })

  // THE HANDLERS' OWN POOL. getDb() memoises on first call and reads
  // DATABASE_URL then — so this must be set before any handler runs, and it
  // makes `getDb()` (and therefore withRequestRls / withMachineRls) the
  // NON-OWNER connection for the whole file.
  process.env.DATABASE_URL = scopedUrl.toString()
}, 120_000)

afterAll(async () => {
  await appClient?.end({ timeout: 5 })
  await stopTestDb(t)
}, 30_000)

function sessionFor(role: string, opts: { regionId?: string; teammateId?: string } = {}): Session {
  return {
    teammateId: opts.teammateId ?? adminTeammateId,
    email: `${role}@example.com`,
    displayName: role,
    role,
    regionId: opts.regionId ?? regionId,
    orgPath,
  } as Session
}

function ev(params: Record<string, string>, session: Session) {
  const e = {
    method: 'GET',
    path: '/x',
    context: { params },
    node: {
      req: { method: 'GET', url: '/x', headers: { host: 'localhost:3450' } },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e
}

describe('the harness itself is a real non-owner under FORCE', () => {
  it('the app role is NOT the table owner and FORCE is on for the phase-1 set', async () => {
    const rows = await t.client<{ relname: string; relforcerowsecurity: boolean; owner: string }[]>`
      SELECT c.relname, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY(${PHASE_1_FORCE as unknown as string[]})
    `
    expect(rows.length).toBe(PHASE_1_FORCE.length)
    for (const row of rows) {
      expect(row.relforcerowsecurity).toBe(true)
      expect(row.owner).not.toBe('rls_force_app')
      expect(row.owner).not.toBe('rls_force_login')
    }
  })

  it('RED: a context-less non-owner SELECT on a phase-1 table returns ZERO rows, silently', async () => {
    // This is §The mechanism, measured's own result and the reason an unconverted
    // handler is dangerous rather than merely broken: no error, no warning.
    const rows = await appDb.execute<{ n: string }>(
      sql`SELECT COUNT(*)::text AS n FROM attribution_record WHERE instance_id = ${instanceId}::uuid`,
    )
    expect(Number([...rows][0]!.n)).toBe(0)

    const projRows = await appDb.execute<{ n: string }>(
      sql`SELECT COUNT(*)::text AS n FROM project WHERE id = ${projectId}::uuid`,
    )
    expect(Number([...projRows][0]!.n)).toBe(0)
  })

  /*
   * A review claimed that under enforced RLS an in-subtree MANAGER loses the
   * project-consumption route's documented access — that `project`'s policies
   * admit region admins, project members and BU owners but not a manager
   * authorised by orgSubtreeScopePredicate, so they would 404 before the
   * admission query. The FORCE suite covered only admins, so the claim could not
   * be answered from the tests, which is a fair criticism of the coverage.
   *
   * Answering it rather than arguing: `project_region_scope` is
   * `region_id = app.user_region_id OR role IN ('global-finops','platform-admin')`
   * — the region arm carries NO role condition, so any caller in the region
   * passes, manager included. Pinned here so the next person gets evidence.
   */
  it('a MANAGER in-region sees the project under FORCE — the region arm has no role condition', async () => {
    const seen = await withRlsContext(
      appDb as never,
      { userRegionId: regionId, userOrgPath: orgPath, userRole: 'manager', userTeammateId: devTeammateId },
      async (tx) => {
        const pr = await tx.execute<{ n: string }>(
          sql`SELECT COUNT(*)::text AS n FROM project WHERE id = ${projectId}::uuid`,
        )
        return Number([...pr][0]!.n)
      },
    )
    expect(seen, 'an in-region manager must still see the project row').toBe(1)
  })

  it('a manager in ANOTHER region does NOT see it — the region arm is the boundary that holds', async () => {
    const seen = await withRlsContext(
      appDb as never,
      { userRegionId: otherRegionId, userOrgPath: orgPath, userRole: 'manager', userTeammateId: devTeammateId },
      async (tx) => {
        const pr = await tx.execute<{ n: string }>(
          sql`SELECT COUNT(*)::text AS n FROM project WHERE id = ${projectId}::uuid`,
        )
        return Number([...pr][0]!.n)
      },
    )
    expect(seen).toBe(0)
  })

  it('GREEN: the same reads under an RLS context see the rows', async () => {
    const seen = await withRlsContext(
      appDb as never,
      { userRegionId: regionId, userOrgPath: orgPath, userRole: 'admin', userTeammateId: adminTeammateId },
      async (tx) => {
        const ar = await tx.execute<{ n: string }>(
          sql`SELECT COUNT(*)::text AS n FROM attribution_record WHERE instance_id = ${instanceId}::uuid`,
        )
        const pr = await tx.execute<{ n: string }>(
          sql`SELECT COUNT(*)::text AS n FROM project WHERE id = ${projectId}::uuid`,
        )
        return { ar: Number([...ar][0]!.n), pr: Number([...pr][0]!.n) }
      },
    )
    expect(seen.ar).toBe(1)
    expect(seen.pr).toBe(1)
  })
})

describe('the bootstrap tables are live for a non-owner, FORCE or not', () => {
  /*
   * THE CONSEQUENCE THIS HARNESS EXISTS TO CATCH. §The OAuth lane decides that the
   * auth-plumbing tables "are NOT in the phase-1 FORCE set" and treats that as
   * sufficient to keep the OAuth bootstrap working. It is not: `FORCE` is only
   * about the OWNER. `oauth_token` has `ENABLE ROW LEVEL SECURITY` (mig 0002)
   * and a policy (mig 0098 `oauth_token_scope`) that denies when no GUCs are
   * set — and `requireOAuthBearer` MUST read it before any GUC can exist.
   *
   * So the moment the §DBA runbook points the app at the non-owner role, every
   * emit device's /bearer, /health, /end and /project-resolve 401s and the
   * whole fleet stops emitting — with nothing in the FORCE plan having been
   * enabled at all. The mitigation that section needs is `DISABLE ROW LEVEL SECURITY` on
   * the auth-plumbing tables (which this file's setup does), not omission from
   * a FORCE list.
   */
  it('re-ENABLING oauth_token RLS makes the bearer lookup find nothing on the non-owner pool', async () => {
    await t.client.unsafe('ALTER TABLE oauth_token ENABLE ROW LEVEL SECURITY')
    try {
      const rows = await appDb.execute<{ n: string }>(
        sql`SELECT COUNT(*)::text AS n FROM oauth_token WHERE teammate_id = ${devTeammateId}::uuid`,
      )
      expect(Number([...rows][0]!.n)).toBe(0)

      // The owner still sees them — proving the zero above is RLS hiding a row,
      // not an empty table. This assertion used to be `toBeGreaterThanOrEqual(0)`,
      // which is true of zero: a vacuity check that was itself vacuous, guarding
      // a count over a table this file never seeded. Both halves are fixed.
      const asOwner = await t.client<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM oauth_token WHERE teammate_id = ${devTeammateId}::uuid
      `
      expect(Number(asOwner[0]!.n)).toBeGreaterThan(0)
    } finally {
      await t.client.unsafe('ALTER TABLE oauth_token DISABLE ROW LEVEL SECURITY')
    }
  })

  it('none of the phase-1 tables needed FORCE to be enforced here — the non-owner is what does it', async () => {
    // Turning FORCE off changes nothing for this role; the row stays hidden.
    await t.client.unsafe('ALTER TABLE project NO FORCE ROW LEVEL SECURITY')
    try {
      const rows = await appDb.execute<{ n: string }>(
        sql`SELECT COUNT(*)::text AS n FROM project WHERE id = ${projectId}::uuid`,
      )
      expect(Number([...rows][0]!.n)).toBe(0)
    } finally {
      await t.client.unsafe('ALTER TABLE project FORCE ROW LEVEL SECURITY')
    }
  })
})

describe('request lane — GET /projects/{id}/consumption under FORCE', () => {
  /*
   * The highest-value conversion in this story. The handler's FIRST statement
   * used to be `SELECT region_id FROM project WHERE id = …` on the bare pool,
   * OUTSIDE the withRequestRls block that wrapped the rest. `project` is in the
   * phase-1 FORCE set, so that read returns zero rows here and the handler 404s
   * a project that exists — for every caller, on the money path, with no error
   * anywhere. Moving it inside the transaction is what this proves.
   */
  it('GREEN: a same-region admin reads the real number', async () => {
    const handler = (await import('../../../server/api/v1/projects/[id]/consumption.get')).default
    const out = (await handler(ev({ id: projectId }, sessionFor('admin')) as never)) as {
      project_id: string
      total_cost_usd: string
      total_tokens: number
    }
    expect(out.project_id).toBe(projectId)
    expect(out.total_cost_usd).toBe('42.00')
    expect(out.total_tokens).toBe(1000)
  })

  it('RED: the pre-conversion shape — that same lookup on the context-less pool — finds nothing', async () => {
    // Byte-for-byte the statement the handler used to run outside the tx.
    const rows = await appDb.execute<{ region_id: string }>(
      sql`SELECT region_id::text AS region_id FROM project WHERE id = ${projectId}::uuid LIMIT 1`,
    )
    expect([...rows].length).toBe(0) // → `throw createError({ statusCode: 404 })`
  })

  it('a foreign-region admin is still refused — as a 404 under FORCE, where the owner connection gives 403', async () => {
    /*
     * A DELIBERATE, DOCUMENTED SHIFT, not a regression. As the owner (every
     * other test in the repo, and tests/integration/admin/project-consumption-
     * scope.test.ts specifically) `project_region_scope` is inert, the row is
     * read, and requireRegionScope answers 403. Under FORCE the policy hides
     * the row first, so the handler 404s before it can compare regions.
     *
     * Both refuse. The 404 is the tighter of the two — it stops the endpoint
     * being an existence oracle for other regions' project ids, which is the
     * same rule me/instances/{id}/revoke and me/grants/{id}/revoke already
     * apply deliberately. Recorded here so the rollout does not read the
     * status-code change as a break.
     */
    const handler = (await import('../../../server/api/v1/projects/[id]/consumption.get')).default
    await expect(
      handler(ev({ id: projectId }, sessionFor('admin', { regionId: otherRegionId })) as never),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('an unknown project id still 404s (the 404 has not become unreachable)', async () => {
    const handler = (await import('../../../server/api/v1/projects/[id]/consumption.get')).default
    await expect(
      handler(ev({ id: UNKNOWN_PROJECT_ID }, sessionFor('admin')) as never),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('machine lane — GET /instances/{id}/health under FORCE', () => {
  /*
   * The lane withRequestRls cannot serve: no cookie session, only an emit
   * credential. `last_emission` is MAX(attribution_record.ts_event) — a phase-1
   * FORCE table — so without withMachineRls every device would report itself
   * permanently silent, and the went-silent detector would be reading a NULL
   * that means "no context", not "no emission".
   */
  async function bearerEvent(sid: string, token: string) {
    return {
      method: 'GET',
      path: `/api/v1/instances/${sid}/health`,
      context: { params: { instanceId: sid } },
      node: {
        req: { method: 'GET', url: `/api/v1/instances/${sid}/health`, headers: { host: 'localhost:3450', authorization: `Bearer ${token}` } },
        res: {
          _headers: {} as Record<string, string | string[]>,
          statusCode: 200,
          getHeader(n: string) { return this._headers[n.toLowerCase()] },
          setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
          removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
          appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
          get headersSent() { return false },
        },
      },
    }
  }

  it('GREEN: the device sees its own landed emission', async () => {
    const { issueEmitCredential } = await import('../../../server/auth/emit-credential')
    // Mint as the OWNER — oauth_token is auth plumbing and out of the phase-1
    // set (§The OAuth lane), but the mint is setup, not the behaviour under test.
    const cred = await issueEmitCredential(t.db as never, devTeammateId)
    await t.client.unsafe(
      `UPDATE oauth_token SET instance_id = '${instanceId}' WHERE teammate_id = '${devTeammateId}' AND scope = 'tokenscope.emit'`,
    )

    const handler = (await import('../../../server/api/v1/instances/[instanceId]/health.get')).default
    const out = (await handler(
      (await bearerEvent(instanceId, cred.tokens.access_token)) as never,
    )) as { instance_id: string; last_emission: string | null; silent: boolean }

    expect(out.instance_id).toBe(instanceId)
    // THE assertion: a real timestamp, read from a FORCEd table, by a lane with
    // no session. Null here would be the silent failure this lane exists to stop.
    expect(out.last_emission).not.toBeNull()
    expect(out.silent).toBe(false)
  })

  it('RED: the pre-conversion shape — the same aggregate on the context-less pool — yields NULL', async () => {
    const rows = await appDb.execute<{ last_emission: string | null }>(sql`
      SELECT MAX(ar.ts_event)::text AS last_emission
        FROM attribution_record ar
       WHERE ar.instance_id = ${instanceId}::uuid
    `)
    // NOT an error — a NULL that reads exactly like "this device never emitted".
    expect([...rows][0]!.last_emission).toBeNull()
  })
})

describe('§audit_event is the cross-cutting one — recordAuditEvent must take the transaction, not the pool', () => {
  /*
   * `audit_event` is phase THREE (§Rollout), so it is FORCEd only inside this block:
   * the point is to prove that section's class fix is real BEFORE the rollout reaches
   * it, rather than discovering it during the rollout.
   */
  beforeAll(async () => {
    // ENABLE *and* FORCE. `FORCE` on a table whose RLS is DISABLEd is a no-op —
    // the same asymmetry the file header describes, met here in miniature: the
    // file's setup disabled every non-phase-1 table, so FORCE alone would leave
    // these assertions passing for the wrong reason (they did, first run).
    await t.client.unsafe('ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY')
    await t.client.unsafe('ALTER TABLE audit_event FORCE ROW LEVEL SECURITY')
  })
  afterAll(async () => {
    await t.client.unsafe('ALTER TABLE audit_event NO FORCE ROW LEVEL SECURITY')
    await t.client.unsafe('ALTER TABLE audit_event DISABLE ROW LEVEL SECURITY')
  })

  it('RED: recordAuditEvent on the context-less pool is REFUSED', async () => {
    await expectRlsRefusal(
      recordAuditEvent(appDb as never, {
        eventType: 'rls-force-probe',
        actorTeammateId: adminTeammateId,
        subjectKind: 'teammate',
        subjectId: adminTeammateId,
        payload: {},
      }),
    )
  })

  it('GREEN: the same call inside an RLS transaction succeeds', async () => {
    const { id } = await withRlsContext(
      appDb as never,
      { userRegionId: regionId, userOrgPath: orgPath, userRole: 'global-finops', userTeammateId: adminTeammateId },
      (tx) =>
        recordAuditEvent(tx as never, {
          eventType: 'rls-force-probe',
          actorTeammateId: adminTeammateId,
          subjectKind: 'teammate',
          subjectId: adminTeammateId,
          payload: { ok: true },
        }),
    )
    expect(id).toBeTruthy()
  })

  it('FINDING for phase 3: `audit_event_admin_only` admits ONLY global-finops / platform-admin, so a developer or region-admin actor is refused even WITH a context', async () => {
    /*
     * Not a defect in this story's fix — the handle is right; the POLICY is the
     * blocker. mig 0098 rewrote this policy's role list from
     * ('global-finops','admin') to ('global-finops','platform-admin'), and
     * withRequestRls maps only platform-admin onto global-finops. So under a
     * phase-3 FORCE every self-service audit write (identity-linked,
     * instance-revoked, inbox-acked, over-emission-resolved, the user-side
     * grant revoke) fails AFTER its handler has done its work.
     *
     * Asserted rather than described so phase 3 cannot enable `audit_event`
     * without this test turning red first. When the policy is widened to admit
     * a self-actor, flip these two expectations — that is the signal, not a
     * breakage.
     */
    const attempt = (role: 'developer' | 'admin' | 'global-finops') =>
      withRlsContext(
        appDb as never,
        { userRegionId: regionId, userOrgPath: orgPath, userRole: role, userTeammateId: devTeammateId },
        (tx) =>
          recordAuditEvent(tx as never, {
            eventType: 'rls-force-selfaudit-probe',
            actorTeammateId: devTeammateId,
            subjectKind: 'teammate',
            subjectId: devTeammateId,
            payload: { role },
          }),
      )

    await expectRlsRefusal(attempt('developer'))
    await expectRlsRefusal(attempt('admin'))
    await expect(attempt('global-finops')).resolves.toMatchObject({ id: expect.any(String) })
  })
})
