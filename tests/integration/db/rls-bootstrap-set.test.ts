/*
 * The RLS BOOTSTRAP SET is load-bearing and was got wrong twice — so it is
 * tested, not listed.
 *
 * A non-owner is bound by `ENABLE ROW LEVEL SECURITY` alone; `FORCE` only adds
 * the owner. So on the day DATABASE_URL points at the app role, every RLS-enabled
 * table starts filtering — including the ones a request must read BEFORE it can
 * know whose identity to set. Those reads return zero rows, every device fails to
 * authenticate, and emission stops fleet-wide with nothing forced.
 *
 * `server/db/rls-bootstrap.ts` names the tables that must be DISABLED first. The
 * first version of that list named `oauth_token`; the second added `teammate`;
 * an external review found `org_unit` and `instance_attestation` still missing.
 * Each time the list was written by reading one query and reasoning about the
 * rest — which is why this file EXERCISES the bootstrap paths against a real
 * non-owner instead of reasoning about them. (Exercises, not "runs the real
 * queries": see the HONEST LIMIT below, which this sentence used to
 * contradict — the correction was added without deleting the claim it
 * corrected, so both shipped.)
 *
 * WHY THIS IS NOT COVERED BY rls-force-lanes.test.ts: that harness DISABLES every
 * RLS table outside its phase-1 FORCE set, so the bootstrap paths there run with
 * org_unit and instance_attestation already open. It is more permissive than the
 * runbook, and therefore structurally unable to catch a runbook that under-lists.
 *
 * This file does the opposite: it disables EXACTLY the documented set and leaves
 * every other RLS table enabled, then proves (a) the bootstrap paths work, and
 * (b) every entry is load-bearing, by re-enabling one at a time and watching a
 * path fail.
 *
 * HONEST LIMIT — the runtime cases below execute query SHAPES COPIED from the
 * production files, not the production code itself. An earlier version of this
 * comment claimed they were "the REAL bootstrap queries" and that adding a join
 * upstream would turn this red; a review pointed out that a copy cannot notice
 * an upstream edit, which made the claim exactly the sort of confident-and-false
 * prose this sprint exists to remove. The `drift` suite at the bottom is what
 * actually makes that promise good: it reads the production sources and fails if
 * any RLS-enabled table appears in a pre-identity file's SQL without being in the
 * constant. The runtime cases prove the SET WORKS; the drift guard proves the SET
 * IS COMPLETE.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { RLS_BOOTSTRAP_TABLE_NAMES } from '../../../server/db/rls-bootstrap'

let t: TestDb
let appClient: postgres.Sql
let teammateId = ''
let instanceId = ''
let accessHash = ''

/** The bearer bootstrap read, verbatim in shape from server/auth/oauth-bearer.ts. */
const bearerLookup = (client: postgres.Sql, hash: string) => client`
  SELECT t.teammate_id::text AS teammate_id, ou.path::text AS org_path
    FROM oauth_token t
    JOIN teammate tm ON tm.id = t.teammate_id
    JOIN org_unit ou ON ou.id = tm.org_unit_id
   WHERE t.access_token_hash = ${hash}
   LIMIT 1
`

/*
 * The /setup/enroll audit WRITE. That handler never adopts an identity at all
 * (it is provisioning one), and audits itself at enroll.post.ts:144. This is a
 * write, not a read, so it fails LOUDLY under RLS rather than returning nothing —
 * and it rolls the whole enrolment back with it.
 */
const enrollAuditWrite = (client: postgres.Sql) => client`
  INSERT INTO audit_event (event_type, payload)
  VALUES ('bootstrap-probe', '{}'::jsonb)
`

/** The /setup/redeem pre-adoption read, verbatim in shape from redeem.post.ts. */
const redeemLookup = (client: postgres.Sql, inst: string, tm: string) => client`
  SELECT ia.tool, tmm.region_id::text AS region_id, ou.path::text AS org_path
    FROM instance_attestation ia
    JOIN teammate tmm ON tmm.id = ia.teammate_id
    JOIN org_unit ou ON ou.id = tmm.org_unit_id
   WHERE ia.instance_id = ${inst}::uuid AND ia.teammate_id = ${tm}::uuid
   LIMIT 1
`

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db.insert(schema.region).values({ code: `bs-${randomUUID().slice(0, 6)}`, displayName: 'Bootstrap' }).returning()
  const suffix = randomUUID().slice(0, 6).replace(/-/g, '')
  const [root] = await t.db.insert(schema.orgUnit).values({
    regionId: region!.id, path: `bs${suffix}`, code: 'default', displayName: 'BS root', unitType: 'bu', isCostOwningUnit: true,
  }).returning()
  const [unit] = await t.db.insert(schema.orgUnit).values({
    regionId: region!.id, parentId: root!.id, path: `bs${suffix}.alpha`, code: `bs-alpha-${suffix}`,
    displayName: 'BS Alpha', unitType: 'practice', isCostOwningUnit: true,
  }).returning()
  const [tm] = await t.db.insert(schema.teammate).values({
    entraOid: `oid-bs-${randomUUID().slice(0, 8)}`, email: `bs-${randomUUID().slice(0, 6)}@x.test`,
    displayName: 'Bootstrap Dev', regionId: region!.id, orgUnitId: unit!.id, role: 'developer',
  }).returning()
  teammateId = tm!.id

  instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId, principalOid: `bs-oid-${randomUUID().slice(0, 8)}`, principalEmail: `bs-${randomUUID().slice(0, 6)}@x.test`,
    teammateId, tool: 'claude-code', sessionTokenHash: `tok-${instanceId}`, tsStart: new Date(),
    regionId: region!.id, orgUnitId: unit!.id, costOwningUnitId: unit!.id, attestationState: 'unassigned',
  })

  const [client] = await t.db.insert(schema.oauthClient).values({
    clientSecretHash: 'csh-bs', clientName: 'bootstrap', redirectUris: ['http://127.0.0.1:7777/callback'],
  }).returning()
  accessHash = `bs-hash-${randomUUID()}`
  const nowMs = Date.now()
  await t.db.insert(schema.oauthToken).values({
    accessTokenHash: accessHash, refreshTokenHash: `bs-refresh-${randomUUID()}`,
    clientId: client!.clientId, teammateId, scope: 'tokenscope.emit',
    accessIssuedAt: new Date(nowMs), accessExpiresAt: new Date(nowMs + 3_600_000),
    refreshIssuedAt: new Date(nowMs), refreshExpiresAt: new Date(nowMs + 86_400_000),
  })

  await t.client.unsafe(`
    CREATE ROLE bs_app NOLOGIN;
    GRANT USAGE ON SCHEMA public TO bs_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bs_app;
    CREATE USER bs_login WITH LOGIN PASSWORD 'app';
    GRANT bs_app TO bs_login;
  `)

  // EXACTLY the documented set, and nothing else. Every other RLS-enabled table
  // stays ENABLED — this is the production posture the runbook describes.
  for (const table of RLS_BOOTSTRAP_TABLE_NAMES) {
    await t.client.unsafe(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`)
  }

  const url = new URL(t.url)
  url.username = 'bs_login'
  url.password = 'app'
  appClient = postgres(url.toString(), { max: 2, idle_timeout: 5, connection: { TimeZone: 'UTC' } })
}, 120_000)

afterAll(async () => {
  await appClient?.end({ timeout: 5 }).catch(() => undefined)
  await stopTestDb(t)
})

describe('the RLS bootstrap set is sufficient', () => {
  it('runs as a genuine NON-OWNER (otherwise every assertion below is vacuous)', async () => {
    const [who] = await appClient<{ me: string; owner: string }[]>`
      SELECT current_user AS me, (SELECT tableowner FROM pg_tables WHERE tablename = 'oauth_token') AS owner
    `
    expect(who!.me).toBe('bs_login')
    expect(who!.owner).not.toBe('bs_login')
    const [su] = await appClient<{ su: boolean }[]>`SELECT usesuper AS su FROM pg_user WHERE usename = current_user`
    expect(su!.su, 'a superuser bypasses RLS unconditionally').toBe(false)
  })

  it('the bearer bootstrap read resolves a teammate with NO RLS context set', async () => {
    const rows = await bearerLookup(appClient, accessHash)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.teammate_id).toBe(teammateId)
  })

  it('the /setup/enroll audit write succeeds with NO RLS context set', async () => {
    // A device enrolling has no identity yet — that is what it is asking for.
    await expect(enrollAuditWrite(appClient)).resolves.toBeDefined()
  })

  it('the /setup/redeem pre-adoption read resolves an attestation with NO RLS context set', async () => {
    const rows = await redeemLookup(appClient, instanceId, teammateId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.org_path).toBeTruthy()
  })
})

describe('every entry in the bootstrap set is load-bearing', () => {
  // Re-enable ONE table at a time and watch the bootstrap paths fail. This is
  // what makes the constant honest: an entry that is not needed would leave both
  // paths working and fail this test, and a table MISSING from the constant
  // leaves the suite above red instead.
  it.each(RLS_BOOTSTRAP_TABLE_NAMES)('re-enabling %s breaks at least one bootstrap path', async (table) => {
    await t.client.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
    try {
      const bearer = await bearerLookup(appClient, accessHash)
      const redeem = await redeemLookup(appClient, instanceId, teammateId)
      const writeDenied = await enrollAuditWrite(appClient).then(
        () => false,
        () => true,
      )
      expect(
        bearer.length === 0 || redeem.length === 0 || writeDenied,
        `${table} is in RLS_BOOTSTRAP_TABLES but re-enabling it broke neither bootstrap path — either it does not belong in the set, or these queries have drifted from the real ones`,
      ).toBe(true)
    } finally {
      await t.client.unsafe(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`)
    }
  })

  it('with the whole set re-enabled, BOTH paths fail — the fleet-stop this exists to prevent', async () => {
    for (const table of RLS_BOOTSTRAP_TABLE_NAMES) {
      await t.client.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
    }
    try {
      expect(await bearerLookup(appClient, accessHash)).toHaveLength(0)
      expect(await redeemLookup(appClient, instanceId, teammateId)).toHaveLength(0)
      await expect(enrollAuditWrite(appClient)).rejects.toThrow()
    } finally {
      for (const table of RLS_BOOTSTRAP_TABLE_NAMES) {
        await t.client.unsafe(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`)
      }
    }
  })
})

/*
 * DRIFT GUARD — the half that makes "add a join and this goes red" true.
 *
 * The runtime cases above run copies of the production queries, so they cannot
 * notice an upstream edit. This suite reads the pre-identity source files, pulls
 * every table name out of their SQL, and fails if any RLS-enabled one is missing
 * from RLS_BOOTSTRAP_TABLES.
 *
 * Its reach is the named files' OWN SQL, not their transitive callees — stated so
 * nobody mistakes it for a proof of completeness. That is the honest bound, and
 * it is what caught nothing and what a human still has to think about; what it
 * DOES catch is the common case that has already bitten three times: somebody
 * adds a JOIN or a write to one of these handlers and does not think about RLS.
 */
describe('drift: pre-identity SQL only names tables in the bootstrap set', () => {
  // Files whose SQL runs BEFORE any RLS identity can be set. Adding a new
  // bootstrap surface means adding it here.
  const PRE_IDENTITY_SOURCES = [
    'server/auth/oauth-bearer.ts',
    'server/api/v1/setup/redeem.post.ts',
    'server/api/v1/setup/enroll.post.ts',
    'server/api/v1/oauth/token.post.ts',
    'server/api/v1/oauth/register.post.ts',
    'server/api/v1/oauth/revoke.post.ts',
  ]

  it('every RLS-enabled table named in those files is in RLS_BOOTSTRAP_TABLES', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const root = resolve(__dirname, '../../..')

    const rlsEnabled = new Set(
      (
        await t.client<{ relname: string }[]>`
          SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relkind = 'r'
        `
      ).map((r) => r.relname),
    )
    const allowed = new Set<string>(RLS_BOOTSTRAP_TABLE_NAMES)

    const offenders: string[] = []
    for (const rel of PRE_IDENTITY_SOURCES) {
      const src = readFileSync(resolve(root, rel), 'utf8')
      const named = new Set<string>()
      for (const m of src.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi)) {
        named.add(m[1]!.toLowerCase())
      }
      for (const table of named) {
        // `audit_event` is reached through recordAuditEvent rather than inline SQL
        // in some of these files; both forms land in the same place.
        if (rlsEnabled.has(table) && !allowed.has(table)) offenders.push(`${rel} → ${table}`)
      }
      if (/recordAuditEvent\s*\(/.test(src) && !allowed.has('audit_event')) {
        offenders.push(`${rel} → audit_event (via recordAuditEvent)`)
      }
    }

    expect(
      offenders,
      'A pre-identity file names an RLS-enabled table that is NOT in RLS_BOOTSTRAP_TABLES. ' +
        'Under a non-owner role that read returns no rows (or that write is denied) before any ' +
        'GUC exists. Add the table to server/db/rls-bootstrap.ts with the query that forced it, ' +
        'or move the work behind an adopted identity.',
    ).toEqual([])
  })

  it('is non-vacuous: it finds tables at all, and would reject one that is missing', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, '../../..', 'server/auth/oauth-bearer.ts'), 'utf8')
    const named = [...src.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]!.toLowerCase())
    // If the extractor stops matching, the suite above passes vacuously.
    expect(named).toContain('oauth_token')
    expect(named).toContain('teammate')
    expect(named).toContain('org_unit')
  })
})
