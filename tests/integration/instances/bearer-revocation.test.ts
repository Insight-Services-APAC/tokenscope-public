// @vitest-environment node
/*
 * E2 (ADR-0005) — /bearer must honour teammate.revoked_at, and revoking a
 * teammate must eager-cascade-end their emit instances. Removing the 12h TTL
 * deletes the implicit offboarding kill-switch; these are its replacement.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { resetHmacKeyForTests } from '../../../server/auth/hmac'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import bearerHandler from '../../../server/api/v1/instances/[instanceId]/bearer.get'
import revokeHandler from '../../../server/api/v1/admin/users/[id]/revoke-sessions.post'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

let t: TestDb
let regionId: string
let ouId: string
let teammateId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'bearer-revocation-test-key-padded-well-beyond-32'
  process.env.NUXT_SESSION_SECRET = 'bearer-revocation-test-padded-to-thirty-two-chars'
  resetHmacKeyForTests()

  const [r] = await t.db.insert(schema.region).values({ code: 'e2-r', displayName: 'E2 R' }).returning()
  regionId = r!.id
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'e2.svc', code: 'e2-svc', displayName: 'Svc', unitType: 'bu' }).returning()
  ouId = o!.id
  const [tm] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-e2', email: 'e2@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  teammateId = tm!.id
}, 60_000)

afterAll(async () => { await stopTestDb(t) }, 30_000)

async function enrolInstance(tsStart: Date): Promise<{ instanceId: string }> {
  const instanceId = randomUUID()
  // session_token_hash is vestigial (legacy 12h token removed) — omitted.
  await t.client.unsafe(`
    INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start, region_id, org_unit_id, attestation_state)
    VALUES ('${instanceId}','oid-e2','e2@x.test','${teammateId}','claude-code','${tsStart.toISOString()}','${regionId}','${ouId}','unassigned')`)
  return { instanceId }
}

/** Mint a fresh emit-scoped OAuth access token for the teammate (the emit credential). */
async function emitAccessToken(): Promise<string> {
  const cred = await issueEmitCredential(t.db as never, teammateId)
  return cred.tokens.access_token
}

function bearerEvent(instanceId: string, token: string) {
  // requireOAuthBearer sets a WWW-Authenticate header on its 401 paths, so the
  // event needs a minimal res stub (the bearer handler is now OAuth-only).
  return {
    context: { params: { instanceId } },
    node: {
      req: { method: 'GET', url: '/x', headers: { authorization: `Bearer ${token}` } },
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

function revokeEvent(targetId: string, session: Session) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450', 'content-type': 'application/json' }
  const e = {
    method: 'POST', path: '/x',
    context: { params: { id: targetId } },
    node: {
      req: { method: 'POST', url: '/x', body: {}, get headers() { return headers } },
      res: { _h: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e
}
const adminSession = (): Session => ({ teammateId, email: 'admin@x.test', displayName: 'A', role: 'global-finops', regionId, orgPath: 'e2.svc' })

describe('E2 — /bearer revocation enforcement', () => {
  it('mints for an active (non-revoked) teammate', async () => {
    await t.client.unsafe(`UPDATE teammate SET revoked_at = NULL WHERE id = '${teammateId}'`)
    const { instanceId } = await enrolInstance(new Date())
    const access = await emitAccessToken()
    const out = (await bearerHandler(bearerEvent(instanceId, access) as never)) as { Authorization: string }
    expect(out.Authorization).toMatch(/^Bearer /)
  })

  it('401s when the teammate is revoked AFTER enrolment', async () => {
    await t.client.unsafe(`UPDATE teammate SET revoked_at = NULL WHERE id = '${teammateId}'`)
    const enrolledAt = new Date(Date.now() - 60_000)
    const { instanceId } = await enrolInstance(enrolledAt)
    // Token issued BEFORE the revoke → requireOAuthBearer's own E2 gate (teammate
    // revoked after issuance) is what 401s here. /bearer's instance-level gate
    // (revoked_at vs ts_start) is the same defense one layer down; either way a
    // revoked teammate cannot mint. We assert the behaviour (revoked → 401).
    const access = await emitAccessToken()
    await t.client.unsafe(`UPDATE teammate SET revoked_at = NOW() WHERE id = '${teammateId}'`)
    await expect(bearerHandler(bearerEvent(instanceId, access) as never)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('still mints for an instance enrolled AFTER the revocation (re-enrol)', async () => {
    // teammate.revoked_at is set (prior test); a NEW instance enrolled now has
    // ts_start > revoked_at, and a freshly-minted access token is issued after the
    // revocation too (so requireOAuthBearer's E2 gate also passes).
    const { instanceId } = await enrolInstance(new Date())
    const access = await emitAccessToken()
    const out = (await bearerHandler(bearerEvent(instanceId, access) as never)) as { Authorization: string }
    expect(out.Authorization).toMatch(/^Bearer /)
  })

  it("401s via /bearer's own instance gate ('Session revoked') for a token issued AFTER the revoke", async () => {
    // Revoke FIRST, then mint: requireOAuthBearer's E2 gate (teammate_revoked_at >
    // access_issued_at) does NOT fire (token issued after the revoke), so /bearer's
    // instance-level gate (revoked_at > ts_start) is the layer that 401s. Covers the
    // redundant defense directly (R2 L2 — previously only requireOAuthBearer's gate fired).
    await t.client.unsafe(`UPDATE teammate SET revoked_at = NULL WHERE id = '${teammateId}'`)
    const { instanceId } = await enrolInstance(new Date(Date.now() - 60_000))
    await t.client.unsafe(`UPDATE teammate SET revoked_at = NOW() WHERE id = '${teammateId}'`)
    const access = await emitAccessToken() // issued AFTER the revoke
    await expect(bearerHandler(bearerEvent(instanceId, access) as never)).rejects.toMatchObject({
      statusMessage: 'Session revoked',
    })
    await t.client.unsafe(`UPDATE teammate SET revoked_at = NULL WHERE id = '${teammateId}'`)
  })
})

describe('E2 — revoke cascades to instances', () => {
  it('revoke-sessions sets ts_actual_end on the teammate active instances', async () => {
    await t.client.unsafe(`UPDATE teammate SET revoked_at = NULL WHERE id = '${teammateId}'`)
    const { instanceId } = await enrolInstance(new Date())
    await revokeHandler(revokeEvent(teammateId, adminSession()) as never)
    const rows = await t.client<{ ended: string | null }[]>`SELECT ts_actual_end::text AS ended FROM instance_attestation WHERE instance_id = ${instanceId}`
    expect(rows[0]!.ended).not.toBeNull()
  })
})
