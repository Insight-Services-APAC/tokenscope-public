// @vitest-environment node
/*
 * POST /api/v1/instances/{instanceId}/end — OAuth-ONLY (ADR-0005; the legacy
 * session-token auth was removed). Coverage (R2 M1 — the auth-critical rewrite
 * was previously untested):
 *   - owner's emit token → closes (204), sets ts_actual_end.
 *   - non-owner's emit token → 404, byte-identical to an unknown id (S5,
 *     de1c74d — the 403 ownership oracle was deliberately collapsed).
 *   - bogus bearer → 401.
 *   - double-end by the owner → idempotent 204.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { resetHmacKeyForTests } from '../../../server/auth/hmac'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import endHandler from '../../../server/api/v1/instances/[instanceId]/end.post'

let t: TestDb
let regionId: string
let ouId: string
let ownerId: string
let strangerId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'end-test-key-padded-well-beyond-thirty-two-chars'
  process.env.NUXT_SESSION_SECRET = 'end-test-secret-padded-to-thirty-two-chars!!'
  resetHmacKeyForTests()

  const [r] = await t.db.insert(schema.region).values({ code: 'end-r', displayName: 'END R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'end.svc', code: 'end-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [owner] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-end-owner', email: 'end-owner@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  ownerId = owner!.id
  const [stranger] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-end-stranger', email: 'end-stranger@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  strangerId = stranger!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function enrolInstance(teammateId: string): Promise<string> {
  const instanceId = randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start, region_id, org_unit_id, attestation_state)
    VALUES ('${instanceId}','oid-end','end@x.test','${teammateId}','claude-code',NOW(),'${regionId}','${ouId}','unassigned')`)
  return instanceId
}

async function emitAccessTokenFor(teammateId: string): Promise<string> {
  const cred = await issueEmitCredential(t.db as never, teammateId)
  return cred.tokens.access_token
}

function endEvent(instanceId: string, token: string) {
  return {
    context: { params: { instanceId } },
    node: {
      req: { method: 'POST', url: '/x', headers: { authorization: `Bearer ${token}` } },
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

async function tsActualEnd(instanceId: string): Promise<string | null> {
  const rows = await t.client<{ ts_actual_end: string | null }[]>`
    SELECT ts_actual_end::text AS ts_actual_end FROM instance_attestation WHERE instance_id = ${instanceId}`
  return rows[0]!.ts_actual_end
}

describe('POST /instances/:id/end — OAuth-only', () => {
  it("owner's emit token closes the instance (204 + ts_actual_end set)", async () => {
    const instanceId = await enrolInstance(ownerId)
    const access = await emitAccessTokenFor(ownerId)
    const ev = endEvent(instanceId, access)
    await endHandler(ev as never)
    expect(ev.node.res.statusCode).toBe(204)
    expect(await tsActualEnd(instanceId)).not.toBeNull()
  })

  it("404s a non-owner's emit token, byte-identical to an unknown id (S5 — no ownership oracle)", async () => {
    const instanceId = await enrolInstance(ownerId)
    const strangerAccess = await emitAccessTokenFor(strangerId)
    const notOwned = (await endHandler(endEvent(instanceId, strangerAccess) as never).catch((e) => e)) as {
      statusCode?: number
      statusMessage?: string
      data?: unknown
    }
    const unknown = (await endHandler(endEvent(randomUUID(), strangerAccess) as never).catch((e) => e)) as {
      statusCode?: number
      statusMessage?: string
      data?: unknown
    }
    expect(notOwned.statusCode).toBe(404)
    // Byte-identical to an unknown id — a 403 (or any body difference) here
    // would re-open the ownership oracle S5 deliberately closed (de1c74d).
    expect(
      { statusCode: notOwned.statusCode, statusMessage: notOwned.statusMessage, data: notOwned.data },
    ).toEqual({ statusCode: unknown.statusCode, statusMessage: unknown.statusMessage, data: unknown.data })
    expect(await tsActualEnd(instanceId)).toBeNull() // untouched
  })

  it('401s a bogus bearer (OAuth-only; no legacy session-token path)', async () => {
    const instanceId = await enrolInstance(ownerId)
    await expect(endHandler(endEvent(instanceId, 'not-a-real-token') as never)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('is idempotent — a second end by the owner still 204s', async () => {
    const instanceId = await enrolInstance(ownerId)
    const access = await emitAccessTokenFor(ownerId)
    await endHandler(endEvent(instanceId, access) as never)
    const ev2 = endEvent(instanceId, access)
    await endHandler(ev2 as never)
    expect(ev2.node.res.statusCode).toBe(204)
  })
})
