// @vitest-environment node
/*
 * /bearer captures the CLIENT-ASSERTED version headers (mig 0092).
 *
 * The motivating incident: a live device eight days behind on attribution, and
 * "does that user need to update?" was unanswerable because nothing recorded the
 * plugin or CLI version per device. The capture rides the mint that already
 * stamps last_bearer_at.
 *
 * What these tests pin, in order of how badly getting it wrong would hurt:
 *   1. the columns are written on a successful, OWNED mint;
 *   2. an unauthenticated or NON-OWNING caller cannot write a version claim onto
 *      someone else's instance row (the version is untrusted, but it must not be
 *      untrusted AND cross-tenant);
 *   3. a mint that reports NOTHING does not erase a previous reading — "was on
 *      0.1.27, stopped reporting" and "never reported" are different diagnoses;
 *   4. junk is stored as NULL rather than as a mangled value;
 *   5. reporting nothing never breaks the mint (the mint is the load-bearing part).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { resetHmacKeyForTests } from '../../../server/auth/hmac'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import bearerHandler from '../../../server/api/v1/instances/[instanceId]/bearer.get'

let t: TestDb
let regionId: string
let ouId: string
let ownerId: string
let strangerId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'bearer-cv-test-key-padded-well-beyond-32-chars'
  process.env.NUXT_SESSION_SECRET = 'bearer-cv-test-padded-to-thirty-two-chars!!'
  resetHmacKeyForTests()

  const [r] = await t.db.insert(schema.region).values({ code: 'cv-r', displayName: 'CV R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'cv.svc', code: 'cv-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [owner] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-cv-owner', email: 'cv-owner@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  ownerId = owner!.id
  const [stranger] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-cv-stranger', email: 'cv-stranger@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  strangerId = stranger!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function enrolInstance(teammateId: string): Promise<string> {
  const instanceId = randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start, region_id, org_unit_id, attestation_state)
    VALUES ('${instanceId}','oid-cv','cv-owner@x.test','${teammateId}','claude-code',NOW(),'${regionId}','${ouId}','unassigned')`)
  return instanceId
}

async function emitAccessTokenFor(teammateId: string): Promise<string> {
  const cred = await issueEmitCredential(t.db as never, teammateId)
  return cred.tokens.access_token
}

function bearerEvent(instanceId: string, token: string, extra: Record<string, string | string[]> = {}) {
  const headers = { authorization: `Bearer ${token}`, ...extra }
  return {
    context: { params: { instanceId } },
    node: {
      req: { method: 'GET', url: '/x', headers },
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

interface VersionRow {
  client_plugin_version: string | null
  client_cli_version: string | null
  client_version_at: string | null
  last_bearer_at: string | null
}
async function versions(instanceId: string): Promise<VersionRow> {
  const [row] = await t.client<VersionRow[]>`
    SELECT client_plugin_version, client_cli_version,
           client_version_at::text AS client_version_at,
           last_bearer_at::text AS last_bearer_at
      FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
  return row!
}

describe('/bearer — client version capture (mig 0092)', () => {
  it('records both versions on a successful owned mint', async () => {
    const instanceId = await enrolInstance(ownerId)
    const access = await emitAccessTokenFor(ownerId)
    await bearerHandler(
      bearerEvent(instanceId, access, {
        'x-tokenscope-plugin-version': '0.1.27',
        'x-tokenscope-client-version': '2.1.212',
      }) as never,
    )
    const v = await versions(instanceId)
    expect(v.client_plugin_version).toBe('0.1.27')
    expect(v.client_cli_version).toBe('2.1.212')
    expect(v.client_version_at).not.toBeNull()
  })

  it('leaves the columns NULL when the client reports nothing — "never reported" is the signal', async () => {
    const instanceId = await enrolInstance(ownerId)
    const access = await emitAccessTokenFor(ownerId)
    await bearerHandler(bearerEvent(instanceId, access) as never)
    const v = await versions(instanceId)
    expect(v.client_plugin_version).toBeNull()
    expect(v.client_cli_version).toBeNull()
    expect(v.client_version_at).toBeNull()
    // …but the mint still happened and the heartbeat still moved.
    expect(v.last_bearer_at).not.toBeNull()
  })

  it('does NOT erase a previous reading when a later mint reports nothing', async () => {
    // The two states must stay distinguishable: "was on 0.1.27, stopped
    // reporting" (a downgrade) vs "never reported". Nulling on every silent mint
    // collapses them, and client_version_at is what tells them apart.
    const instanceId = await enrolInstance(ownerId)
    const access = await emitAccessTokenFor(ownerId)
    await bearerHandler(
      bearerEvent(instanceId, access, { 'x-tokenscope-plugin-version': '0.1.27' }) as never,
    )
    const before = await versions(instanceId)
    await bearerHandler(bearerEvent(instanceId, access) as never)
    const after = await versions(instanceId)
    expect(after.client_plugin_version).toBe('0.1.27')
    expect(after.client_version_at).toBe(before.client_version_at) // stamp did NOT move
    expect(after.last_bearer_at).not.toBe(before.last_bearer_at) // heartbeat DID
  })

  it('preserves the other field when only one is reported', async () => {
    // A Copilot CLI client, or a launch where the CLI version is not discoverable,
    // reports one field. Blanking the other would lose a good reading.
    const instanceId = await enrolInstance(ownerId)
    const access = await emitAccessTokenFor(ownerId)
    await bearerHandler(
      bearerEvent(instanceId, access, {
        'x-tokenscope-plugin-version': '0.1.27',
        'x-tokenscope-client-version': '2.1.212',
      }) as never,
    )
    await bearerHandler(
      bearerEvent(instanceId, access, { 'x-tokenscope-plugin-version': '0.1.28' }) as never,
    )
    const v = await versions(instanceId)
    expect(v.client_plugin_version).toBe('0.1.28')
    expect(v.client_cli_version).toBe('2.1.212')
  })

  it('stores a junk header as NULL rather than as a mangled version', async () => {
    const instanceId = await enrolInstance(ownerId)
    const access = await emitAccessTokenFor(ownerId)
    await bearerHandler(
      bearerEvent(instanceId, access, {
        'x-tokenscope-plugin-version': "0.1.27'; DROP TABLE instance_attestation--",
        'x-tokenscope-client-version': '2.1.212',
      }) as never,
    )
    const v = await versions(instanceId)
    expect(v.client_plugin_version).toBeNull()
    expect(v.client_cli_version).toBe('2.1.212') // the good field survived independently
  })

  it('an over-long value is rejected, not truncated', async () => {
    const instanceId = await enrolInstance(ownerId)
    const access = await emitAccessTokenFor(ownerId)
    await bearerHandler(
      bearerEvent(instanceId, access, { 'x-tokenscope-plugin-version': '9'.repeat(500) }) as never,
    )
    expect((await versions(instanceId)).client_plugin_version).toBeNull()
  })

  it('a NON-OWNING caller cannot write a version claim onto someone else\'s instance (404, byte-identical to an unknown instance)', async () => {
    // The claim is untrusted; it must not also be cross-tenant. The write sits
    // after the ownership check for exactly this reason. S5 (de1c74d)
    // deliberately collapsed that ownership check's 403 into the same 404 an
    // unknown instance gets — assert the parity explicitly, since that IS
    // the control (a body difference would re-open the oracle).
    const instanceId = await enrolInstance(ownerId)
    const strangerAccess = await emitAccessTokenFor(strangerId)
    const notOwned = (await bearerHandler(
      bearerEvent(instanceId, strangerAccess, { 'x-tokenscope-plugin-version': '6.6.6' }) as never,
    ).catch((e) => e)) as { statusCode?: number; statusMessage?: string; data?: unknown }
    const unknown = (await bearerHandler(
      bearerEvent(randomUUID(), strangerAccess, { 'x-tokenscope-plugin-version': '6.6.6' }) as never,
    ).catch((e) => e)) as { statusCode?: number; statusMessage?: string; data?: unknown }
    expect(notOwned.statusCode).toBe(404)
    expect(
      { statusCode: notOwned.statusCode, statusMessage: notOwned.statusMessage, data: notOwned.data },
    ).toEqual({ statusCode: unknown.statusCode, statusMessage: unknown.statusMessage, data: unknown.data })
    expect((await versions(instanceId)).client_plugin_version).toBeNull()
  })

  it('an UNAUTHENTICATED caller cannot write a version claim', async () => {
    const instanceId = await enrolInstance(ownerId)
    await expect(
      bearerHandler(
        bearerEvent(instanceId, 'not-a-real-token', { 'x-tokenscope-plugin-version': '6.6.6' }) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 401 })
    expect((await versions(instanceId)).client_plugin_version).toBeNull()
  })

  it('"which versions are in the fleet" is answerable in one grouped query', async () => {
    // The reason these are real columns rather than keys inside `notes` jsonb.
    // Asserted as a query that runs, not as a claim in a comment.
    const a = await enrolInstance(ownerId)
    const b = await enrolInstance(ownerId)
    const access = await emitAccessTokenFor(ownerId)
    await bearerHandler(bearerEvent(a, access, { 'x-tokenscope-plugin-version': '0.1.27' }) as never)
    await bearerHandler(bearerEvent(b, access, { 'x-tokenscope-plugin-version': '0.1.27' }) as never)
    const rows = await t.client<{ v: string | null; n: string }[]>`
      SELECT client_plugin_version AS v, COUNT(*)::text AS n
        FROM instance_attestation
       GROUP BY client_plugin_version`
    const onVersion = rows.find((r) => r.v === '0.1.27')
    expect(Number(onVersion?.n ?? 0)).toBeGreaterThanOrEqual(2)
    // The NULL bucket — devices that have never reported — is the population an
    // operator actually chases during a rollout, so it must be visible here.
    expect(rows.some((r) => r.v === null)).toBe(true)
  })
})
