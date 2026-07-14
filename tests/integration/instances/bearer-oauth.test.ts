// @vitest-environment node
/*
 * ADR-0005 — /bearer is OAuth-ONLY: a durable `tokenscope.emit` access token.
 * The legacy per-instance 12h session token has been removed entirely. Coverage:
 *   - OAuth token whose teammate OWNS the instance → mints.
 *   - OAuth token whose teammate does NOT own the instance → 403.
 *   - E2-revoked teammate's OAuth token → 401.
 *   - An owned instance that is ended → 401 (lifecycle gate).
 *   - A bogus/unknown bearer (incl. a would-be legacy session token) → 401.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { resetHmacKeyForTests } from '../../../server/auth/hmac'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import { refreshAccessToken } from '../../../server/auth/oauth'
import bearerHandler from '../../../server/api/v1/instances/[instanceId]/bearer.get'

let t: TestDb
let regionId: string
let ouId: string
let ownerId: string
let strangerId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'bearer-oauth-test-key-padded-well-beyond-32-chars'
  process.env.NUXT_SESSION_SECRET = 'bearer-oauth-test-padded-to-thirty-two-chars!!'
  resetHmacKeyForTests()

  const [r] = await t.db.insert(schema.region).values({ code: 'bo-r', displayName: 'BO R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'bo.svc', code: 'bo-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [owner] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-bo-owner', email: 'bo-owner@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  ownerId = owner!.id
  const [stranger] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-bo-stranger', email: 'bo-stranger@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  strangerId = stranger!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

/** Enrol an instance owned by `teammateId`. Returns its id. */
async function enrolInstance(teammateId: string, email: string, tsStart = new Date()): Promise<{ instanceId: string }> {
  const instanceId = randomUUID()
  // session_token_hash is vestigial (the legacy 12h token was removed) — omitted.
  await t.client.unsafe(`
    INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start, region_id, org_unit_id, attestation_state)
    VALUES ('${instanceId}','oid-bo','${email}','${teammateId}','claude-code','${tsStart.toISOString()}','${regionId}','${ouId}','unassigned')`)
  return { instanceId }
}

/** Mint a fresh emit-scoped OAuth access token for a teammate. */
async function emitAccessTokenFor(teammateId: string): Promise<string> {
  const cred = await issueEmitCredential(t.db as never, teammateId)
  return cred.tokens.access_token
}

function bearerEvent(instanceId: string, token: string) {
  // requireOAuthBearer sets a WWW-Authenticate header on the OAuth failure paths,
  // so provide a minimal res stub.
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

describe('ADR-0005 — /bearer OAuth emit credential', () => {
  it('mints for an OAuth token whose teammate OWNS the instance', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const access = await emitAccessTokenFor(ownerId)
    const out = (await bearerHandler(bearerEvent(instanceId, access) as never)) as { Authorization: string }
    expect(out.Authorization).toMatch(/^Bearer /)
  })

  it('403s for an OAuth token whose teammate does NOT own the instance', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const strangerAccess = await emitAccessTokenFor(strangerId)
    await expect(bearerHandler(bearerEvent(instanceId, strangerAccess) as never)).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('401s for an E2-revoked teammate OAuth token', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const access = await emitAccessTokenFor(ownerId)
    // Revoke the teammate AFTER the token was issued → E2 cascade.
    await t.client.unsafe(`UPDATE teammate SET revoked_at = NOW() WHERE id = '${ownerId}'`)
    await expect(bearerHandler(bearerEvent(instanceId, access) as never)).rejects.toMatchObject({
      statusCode: 401,
    })
    // Cleanup for later tests.
    await t.client.unsafe(`UPDATE teammate SET revoked_at = NULL WHERE id = '${ownerId}'`)
  })

  it('401s for an OAuth token on an ENDED instance (owned)', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const access = await emitAccessTokenFor(ownerId)
    await t.client.unsafe(`UPDATE instance_attestation SET ts_actual_end = NOW() WHERE instance_id = '${instanceId}'`)
    await expect(bearerHandler(bearerEvent(instanceId, access) as never)).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it('rejects a bogus / unknown bearer with 401 (OAuth-only; no legacy session-token path)', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    await expect(bearerHandler(bearerEvent(instanceId, 'totally-not-a-real-token') as never)).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it('a refreshed (rotated) emit access token still authenticates', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const cred = await issueEmitCredential(t.db as never, ownerId)
    const refreshed = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)
    const out = (await bearerHandler(bearerEvent(instanceId, refreshed.access_token) as never)) as {
      Authorization: string
    }
    expect(out.Authorization).toMatch(/^Bearer /)
  })
})

// Re-anchored went-silent: a rejected emit credential on a LIVE instance is the
// disaster signal; the endpoint records it (and clears it on recovery).
async function openBearerFailures(instanceId: string): Promise<number> {
  const rows = await t.client<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM instance_attestation_health
     WHERE instance_id = ${instanceId}::uuid AND status = 'bearer-auth-failed' AND resolved_at IS NULL`
  return Number(rows[0]!.c)
}

describe('/bearer records the bearer-auth-failed health signal (owner-gated)', () => {
  it('records when the OWNER\'s real credential is rejected (revoked) on a live instance', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const access = await emitAccessTokenFor(ownerId)
    // The owner's durable credential dies → the token it minted is now revoked.
    await t.client.unsafe(`UPDATE oauth_token SET revoked_at = NOW() WHERE teammate_id = '${ownerId}'`)
    await expect(bearerHandler(bearerEvent(instanceId, access) as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(await openBearerFailures(instanceId)).toBe(1)
    // Idempotent per episode: a second rejected hit does not open a second row.
    await expect(bearerHandler(bearerEvent(instanceId, access) as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(await openBearerFailures(instanceId)).toBe(1)
  })

  it('does NOT record for a garbage / unrecognised token (abuse guard — can\'t forge an alert)', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    await expect(bearerHandler(bearerEvent(instanceId, 'totally-bogus') as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(await openBearerFailures(instanceId)).toBe(0)
  })

  it('does NOT record a FOREIGN teammate\'s rejected token against this instance', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const strangerAccess = await emitAccessTokenFor(strangerId)
    await t.client.unsafe(`UPDATE oauth_token SET revoked_at = NOW() WHERE teammate_id = '${strangerId}'`)
    await expect(bearerHandler(bearerEvent(instanceId, strangerAccess) as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(await openBearerFailures(instanceId)).toBe(0)
  })

  it('a successful OWNER mint RESOLVES the open failure (recovery)', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    await t.db.insert(schema.instanceAttestationHealth).values({ instanceId, status: 'bearer-auth-failed', payload: {} })
    expect(await openBearerFailures(instanceId)).toBe(1)
    const access = await emitAccessTokenFor(ownerId)
    await bearerHandler(bearerEvent(instanceId, access) as never) // valid owner token → resolves
    expect(await openBearerFailures(instanceId)).toBe(0)
  })

  it('a FOREIGN valid token does NOT resolve the owner\'s open failure (403; resolve is after ownership)', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    await t.db.insert(schema.instanceAttestationHealth).values({ instanceId, status: 'bearer-auth-failed', payload: {} })
    const strangerAccess = await emitAccessTokenFor(strangerId)
    await expect(bearerHandler(bearerEvent(instanceId, strangerAccess) as never)).rejects.toMatchObject({ statusCode: 403 })
    expect(await openBearerFailures(instanceId)).toBe(1) // not resolved by a non-owner
  })

  it('does NOT record for an ENDED instance even with the owner\'s rejected token (lifecycle-expected)', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const access = await emitAccessTokenFor(ownerId)
    await t.client.unsafe(`UPDATE oauth_token SET revoked_at = NOW() WHERE teammate_id = '${ownerId}'`)
    await t.client.unsafe(`UPDATE instance_attestation SET ts_actual_end = NOW() WHERE instance_id = '${instanceId}'`)
    await expect(bearerHandler(bearerEvent(instanceId, access) as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(await openBearerFailures(instanceId)).toBe(0)
  })
})
