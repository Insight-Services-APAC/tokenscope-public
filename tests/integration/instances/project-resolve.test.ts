// @vitest-environment node
/*
 * GET /instances/{id}/project-resolve — emit-authed "is this code_hash billable
 * for the bearer's teammate on this env?". Same gate as /bearer (emit scope +
 * ownership). No existence oracle: unknown AND not-a-member both → billable:false.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { resetHmacKeyForTests } from '../../../server/auth/hmac'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import resolveHandler from '../../../server/api/v1/instances/[instanceId]/project-resolve.get'

const hashOf = (code: string) => createHash('sha256').update(code).digest('hex')
const MEMBER_CODE = 'tokenscope-public'
const MEMBER_HASH = hashOf(MEMBER_CODE)
const NONMEMBER_CODE = 'other-budget'
const NONMEMBER_HASH = hashOf(NONMEMBER_CODE)
const UNKNOWN_HASH = hashOf('does-not-exist-anywhere')

let t: TestDb
let regionId: string
let ouId: string
let ownerId: string
let strangerId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'project-resolve-test-key-padded-well-beyond-32-chars'
  process.env.NUXT_SESSION_SECRET = 'project-resolve-test-padded-to-thirty-two-chars!!'
  resetHmacKeyForTests()

  const [r] = await t.db.insert(schema.region).values({ code: 'pr-r', displayName: 'PR R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'pr.svc', code: 'pr-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [owner] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-pr-owner', email: 'pr-owner@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  ownerId = owner!.id
  const [stranger] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-pr-stranger', email: 'pr-stranger@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  strangerId = stranger!.id

  // A project the OWNER is a member of, and one they are NOT a member of.
  await t.client.unsafe(`
    INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      VALUES ('${randomUUID()}','${MEMBER_CODE}','${MEMBER_HASH}','TokenScope AppDev','billable','${regionId}','${ouId}'),
             ('${randomUUID()}','${NONMEMBER_CODE}','${NONMEMBER_HASH}','Other Budget','billable','${regionId}','${ouId}');
    INSERT INTO project_assignment (project_id, teammate_id, effective)
      SELECT id, '${ownerId}', '[2020-01-01, 2099-01-01)'::tstzrange FROM project WHERE code = '${MEMBER_CODE}';
  `)
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function enrolInstance(teammateId: string): Promise<string> {
  const instanceId = randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start, region_id, org_unit_id, attestation_state)
    VALUES ('${instanceId}','oid-pr','pr@x.test','${teammateId}','claude-code',NOW(),'${regionId}','${ouId}','unassigned')`)
  return instanceId
}

async function emitTokenFor(teammateId: string): Promise<string> {
  const cred = await issueEmitCredential(t.db as never, teammateId)
  return cred.tokens.access_token
}

function evt(instanceId: string, token: string, codeHash: string | null) {
  const qs = codeHash === null ? '' : `?code_hash=${encodeURIComponent(codeHash)}`
  return {
    // h3 getQuery() reads event.path — provide it (real Nitro sets it from the URL).
    path: `/x${qs}`,
    context: { params: { instanceId } },
    node: {
      req: { method: 'GET', url: `/x${qs}`, headers: { authorization: `Bearer ${token}` } },
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
const call = (e: ReturnType<typeof evt>) => resolveHandler(e as never) as Promise<Record<string, unknown>>

describe('GET /instances/{id}/project-resolve', () => {
  it('member code_hash → billable:true + project', async () => {
    const instanceId = await enrolInstance(ownerId)
    const token = await emitTokenFor(ownerId)
    const out = await call(evt(instanceId, token, MEMBER_HASH))
    expect(out.billable).toBe(true)
    expect((out.project as { code: string }).code).toBe(MEMBER_CODE)
  })

  it('unknown code_hash → billable:false + your_projects (no oracle)', async () => {
    const instanceId = await enrolInstance(ownerId)
    const token = await emitTokenFor(ownerId)
    const out = await call(evt(instanceId, token, UNKNOWN_HASH))
    expect(out.billable).toBe(false)
    const codes = (out.your_projects as { code: string }[]).map((p) => p.code)
    expect(codes).toContain(MEMBER_CODE)
  })

  it('real project the caller is NOT a member of → billable:false (same as unknown — no oracle)', async () => {
    const instanceId = await enrolInstance(ownerId)
    const token = await emitTokenFor(ownerId)
    const out = await call(evt(instanceId, token, NONMEMBER_HASH))
    expect(out.billable).toBe(false)
  })

  it('non-64-hex code_hash → 400', async () => {
    const instanceId = await enrolInstance(ownerId)
    const token = await emitTokenFor(ownerId)
    await expect(call(evt(instanceId, token, 'not-a-hash'))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('missing code_hash → 400', async () => {
    const instanceId = await enrolInstance(ownerId)
    const token = await emitTokenFor(ownerId)
    await expect(call(evt(instanceId, token, null))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('bogus bearer → 401', async () => {
    const instanceId = await enrolInstance(ownerId)
    await expect(call(evt(instanceId, 'totally-not-a-token', MEMBER_HASH))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('stranger token (does not own the instance) → 404, byte-identical to an unknown instance (S5 — no ownership oracle)', async () => {
    const instanceId = await enrolInstance(ownerId)
    const strangerToken = await emitTokenFor(strangerId)
    const notOwned = (await call(evt(instanceId, strangerToken, MEMBER_HASH)).catch((e) => e)) as {
      statusCode?: number
      statusMessage?: string
      data?: unknown
    }
    const unknown = (await call(evt(randomUUID(), strangerToken, MEMBER_HASH)).catch((e) => e)) as {
      statusCode?: number
      statusMessage?: string
      data?: unknown
    }
    expect(notOwned.statusCode).toBe(404)
    // Byte-identical to an unknown instance — a 403 (or any body difference)
    // here would re-open the ownership oracle S5 deliberately closed (de1c74d).
    expect(
      { statusCode: notOwned.statusCode, statusMessage: notOwned.statusMessage, data: notOwned.data },
    ).toEqual({ statusCode: unknown.statusCode, statusMessage: unknown.statusMessage, data: unknown.data })
  })

  it('unknown instance → 404', async () => {
    const token = await emitTokenFor(ownerId)
    await expect(call(evt(randomUUID(), token, MEMBER_HASH))).rejects.toMatchObject({ statusCode: 404 })
  })
})
