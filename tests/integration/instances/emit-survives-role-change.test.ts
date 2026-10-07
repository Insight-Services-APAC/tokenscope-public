// @vitest-environment node
/*
 * #414 — a benign role or region change must not stop a device emitting.
 *
 * Granting a teammate a role bumped teammate.revoked_at, ended their devices and
 * revoked every oauth_token, and refreshAccessToken refused the device's emit
 * refresh token: the device went silent until a full re-enrolment. The emit
 * anchor is now teammate.emit_revoked_at (mig 0152), which only revoke-sessions
 * and retirement bump. Interactive credentials still die on a role change.
 *
 * Each scenario drives the REAL admin handler, then presents the device's
 * credentials at the real refresh function and the real /bearer route.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { resetHmacKeyForTests, hashSessionToken } from '../../../server/auth/hmac'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import { issueTokens, refreshAccessToken } from '../../../server/auth/oauth'
import { issueInstanceEmitCredentialTx } from '../../../server/auth/emit-provision'
import { requireOAuthBearer } from '../../../server/auth/oauth-bearer'
import bearerHandler from '../../../server/api/v1/instances/[instanceId]/bearer.get'
import rolePatchHandler from '../../../server/api/v1/admin/users/[id].patch'
import regionPatchHandler from '../../../server/api/v1/admin/users/[id]/region.patch'
import revokeSessionsHandler from '../../../server/api/v1/admin/users/[id]/revoke-sessions.post'
import { runReadJoiner, selectJoinableInstances } from '../../../server/workers/azure-monitor-reader'
import type { TelemetryReader, UsageRecord } from '../../../server/azure/reader'
import adminInstancesHandler from '../../../server/api/v1/admin/instances.get'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

let t: TestDb
let regionAId: string
let regionBId: string
let ouAId: string
let adminId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'emit-survives-role-change-key-padded-beyond-32'
  process.env.NUXT_SESSION_SECRET = 'emit-survives-role-change-padded-to-thirty-two'
  resetHmacKeyForTests()

  const [rA] = await t.db.insert(schema.region).values({ code: 'esr-a', displayName: 'ESR A' }).returning()
  const [rB] = await t.db.insert(schema.region).values({ code: 'esr-b', displayName: 'ESR B' }).returning()
  regionAId = rA!.id
  regionBId = rB!.id
  const [oA] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionAId, path: 'esr_a.svc', code: 'esr-a-svc', displayName: 'A Svc', unitType: 'bu' })
    .returning()
  ouAId = oA!.id
  const [adm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-esr-adm', email: 'esr-adm@x.test', role: 'platform-admin', regionId: regionAId, orgUnitId: ouAId })
    .returning()
  adminId = adm!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

const adminSession = (): Session => ({
  teammateId: adminId,
  email: 'esr-adm@x.test',
  displayName: 'Adm',
  role: 'platform-admin',
  regionId: regionAId,
  orgPath: 'esr_a.svc',
})

async function newTeammate(): Promise<string> {
  const tag = randomUUID().slice(0, 8)
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: `oid-esr-${tag}`, email: `esr-${tag}@x.test`, role: 'developer', regionId: regionAId, orgUnitId: ouAId })
    .returning()
  return tm!.id
}

async function enrolDevice(teammateId: string): Promise<string> {
  const instanceId = randomUUID()
  await t.client`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start, ts_expected_end,
       region_id, org_unit_id, attestation_state)
    VALUES (${instanceId}::uuid, 'oid-esr', 'esr@x.test', ${teammateId}::uuid, 'claude-code',
            now() - interval '1 hour', now() + interval '80 days', ${regionAId}::uuid, ${ouAId}::uuid, 'unassigned')`
  return instanceId
}

interface Fixture {
  teammateId: string
  instanceId: string
  /** The device's bound emit credential, with an access token minted while live. */
  device: { clientId: string; refreshToken: string; accessToken: string }
  /** An interactive read credential (the MCP consent shape). */
  read: { clientId: string; refreshToken: string; accessToken: string }
}

async function fixture(): Promise<Fixture> {
  const teammateId = await newTeammate()
  const instanceId = await enrolDevice(teammateId)
  const bound = await t.db.transaction((tx) =>
    issueInstanceEmitCredentialTx(tx as never, teammateId, instanceId, issueEmitCredential),
  )
  const { access_token } = await refreshAccessToken(t.db as never, bound.refreshToken, bound.clientId)
  const emitClient = await issueEmitCredential(t.db as never, teammateId) // only to reuse its client id
  const readTokens = await issueTokens(t.db as never, { teammateId, clientId: emitClient.clientId, scope: 'tokenscope.read' })
  // Every anchor comparison is strict (>), so make sure the admin action lands
  // strictly after issuance.
  await new Promise((r) => setTimeout(r, 5))
  return {
    teammateId,
    instanceId,
    device: { clientId: bound.clientId, refreshToken: bound.refreshToken, accessToken: access_token },
    read: { clientId: emitClient.clientId, refreshToken: readTokens.refresh_token, accessToken: readTokens.access_token },
  }
}

function resStub() {
  return {
    _headers: {} as Record<string, string | string[]>,
    statusCode: 200,
    getHeader(n: string) { return this._headers[n.toLowerCase()] },
    setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
    removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
    appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
    get headersSent() { return false },
  }
}

function bearerEvent(instanceId: string, token: string) {
  return {
    context: { params: { instanceId } },
    node: { req: { method: 'GET', url: '/x', headers: { authorization: `Bearer ${token}` } }, res: resStub() },
  }
}

function adminEvent(method: string, id: string, body: unknown, session: Session = adminSession()) {
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    'content-type': 'application/json',
  }
  const e = {
    method,
    path: '/x',
    context: { params: { id } },
    node: { req: { method, url: '/x', body, get headers() { return headers } }, res: resStub() },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as never
}

async function mintsBearer(f: Fixture, accessToken: string): Promise<boolean> {
  try {
    const out = (await bearerHandler(bearerEvent(f.instanceId, accessToken) as never)) as { Authorization?: string }
    return typeof out.Authorization === 'string' && out.Authorization.startsWith('Bearer ')
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 401) return false
    throw err
  }
}

async function refreshes(cred: { refreshToken: string; clientId: string }): Promise<string | null> {
  try {
    return (await refreshAccessToken(t.db as never, cred.refreshToken, cred.clientId)).access_token
  } catch (err) {
    if ((err as { code?: string }).code === 'invalid_grant') return null
    throw err
  }
}

async function readTokenWorks(accessToken: string): Promise<boolean> {
  try {
    await requireOAuthBearer(bearerEvent('x', accessToken) as never, 'tokenscope.read', t.db as never)
    return true
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 401) return false
    throw err
  }
}

async function deviceEnded(instanceId: string): Promise<boolean> {
  const [row] = await t.client<{ ended: boolean }[]>`
    SELECT ts_actual_end IS NOT NULL AS ended FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
  return row!.ended
}

async function tokenRevoked(refreshToken: string): Promise<boolean> {
  const [row] = await t.client<{ revoked: boolean }[]>`
    SELECT revoked_at IS NOT NULL AS revoked FROM oauth_token WHERE refresh_token_hash = ${hashSessionToken(refreshToken)}`
  return row!.revoked
}

async function joinable(instanceId: string): Promise<boolean> {
  const { ids } = await selectJoinableInstances(t.db as never, { limit: 10_000 })
  return ids.includes(instanceId)
}

async function anchors(teammateId: string) {
  const [row] = await t.client<{ revoked: boolean; emit_revoked: boolean }[]>`
    SELECT revoked_at IS NOT NULL AS revoked, emit_revoked_at IS NOT NULL AS emit_revoked
      FROM teammate WHERE id = ${teammateId}::uuid`
  return row!
}

describe('#414 — a benign admin change leaves the device emitting', () => {
  it('fixture sanity: before any admin action every credential works', async () => {
    const f = await fixture()
    expect(await mintsBearer(f, f.device.accessToken)).toBe(true)
    expect(await readTokenWorks(f.read.accessToken)).toBe(true)
    expect(await refreshes(f.device)).not.toBeNull()
  })

  it('a role grant: the device refreshes and mints; interactive credentials are voided', async () => {
    const f = await fixture()
    await rolePatchHandler(adminEvent('PATCH', f.teammateId, { role: 'manager' }))

    // Interactive access is re-validated exactly as before.
    expect(await anchors(f.teammateId)).toEqual({ revoked: true, emit_revoked: false })
    expect(await tokenRevoked(f.read.refreshToken)).toBe(true)
    expect(await readTokenWorks(f.read.accessToken)).toBe(false)
    expect(await refreshes(f.read)).toBeNull()

    // The device is untouched: the access token minted BEFORE the grant still
    // mints, the refresh still works, and a token from that refresh mints too.
    expect(await deviceEnded(f.instanceId)).toBe(false)
    expect(await tokenRevoked(f.device.refreshToken)).toBe(false)
    expect(await mintsBearer(f, f.device.accessToken)).toBe(true)
    const fresh = await refreshes(f.device)
    expect(fresh).not.toBeNull()
    expect(await mintsBearer(f, fresh!)).toBe(true)
    // ...and what it emits is still attributed: the joiner keeps selecting it.
    expect(await joinable(f.instanceId)).toBe(true)
  })

  it('a region move: the device refreshes and mints; interactive credentials are voided', async () => {
    const f = await fixture()
    await regionPatchHandler(adminEvent('PATCH', f.teammateId, { region_id: regionBId }))

    expect(await anchors(f.teammateId)).toEqual({ revoked: true, emit_revoked: false })
    expect(await readTokenWorks(f.read.accessToken)).toBe(false)
    expect(await refreshes(f.read)).toBeNull()

    expect(await deviceEnded(f.instanceId)).toBe(false)
    expect(await mintsBearer(f, f.device.accessToken)).toBe(true)
    const fresh = await refreshes(f.device)
    expect(fresh).not.toBeNull()
    expect(await mintsBearer(f, fresh!)).toBe(true)
  })

  it('an unbound (legacy) emit credential is NOT spared by a role change', async () => {
    const f = await fixture()
    const legacy = await issueEmitCredential(t.db as never, f.teammateId)
    await new Promise((r) => setTimeout(r, 5))
    await rolePatchHandler(adminEvent('PATCH', f.teammateId, { role: 'manager' }))
    expect(await refreshes({ refreshToken: legacy.tokens.refresh_token, clientId: legacy.clientId })).toBeNull()
  })
})

describe('#414 — the events that must end emission still do', () => {
  it('revoke-sessions: the device refresh is refused and /bearer 401s', async () => {
    const f = await fixture()
    await revokeSessionsHandler(adminEvent('POST', f.teammateId, {}))

    expect(await anchors(f.teammateId)).toEqual({ revoked: true, emit_revoked: true })
    expect(await joinable(f.instanceId)).toBe(false)
    expect(await refreshes(f.device)).toBeNull()
    expect(await mintsBearer(f, f.device.accessToken)).toBe(false)
    expect(await readTokenWorks(f.read.accessToken)).toBe(false)
  })

  it('the emit anchor alone refuses the device (no eager cascade to lean on)', async () => {
    // revoke-sessions also ends the device and revokes the token rows, so the
    // test above passes on the cascade alone. Bump only emit_revoked_at here to
    // prove the anchor is a gate in its own right on refresh AND on /bearer.
    const f = await fixture()
    await t.client`UPDATE teammate SET emit_revoked_at = now() WHERE id = ${f.teammateId}::uuid`
    expect(await refreshes(f.device)).toBeNull()
    expect(await mintsBearer(f, f.device.accessToken)).toBe(false)
    // revoked_at was never touched, so interactive credentials are unaffected.
    expect(await readTokenWorks(f.read.accessToken)).toBe(true)
  })

  it('retirement (is_active = false): the device refresh is refused and /bearer 401s', async () => {
    const f = await fixture()
    await t.client`UPDATE teammate SET is_active = false WHERE id = ${f.teammateId}::uuid`
    expect(await refreshes(f.device)).toBeNull()
    expect(await mintsBearer(f, f.device.accessToken)).toBe(false)
  })
})

/** A reader that serves a fixed record list per device, like the real one. */
function readerOf(byDevice: Map<string, UsageRecord[]>): TelemetryReader {
  return { getSessionUsage: async (id: string) => byDevice.get(id) ?? [] } as unknown as TelemetryReader
}

const record = (minutesAgo: number, tokens: number): UsageRecord => ({
  tokens,
  tokenType: 'input',
  model: 'claude-sonnet-4-7',
  tsEvent: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
})

describe('#414 — a region move takes the live device with it', () => {
  it('new records attribute to the new region/BU, old ones keep theirs, and the new region admin sees the device', async () => {
    const f = await fixture()
    const ended = await enrolDevice(f.teammateId)
    await t.client`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${ended}::uuid`

    const before = record(90, 111)
    await runReadJoiner(t.db as never, readerOf(new Map([[f.instanceId, [before]]])), { sessionIds: [f.instanceId] })

    const [ouB] = await t.db
      .insert(schema.orgUnit)
      .values({ regionId: regionBId, path: `esr_b.u${randomUUID().slice(0, 8)}`, code: `esr-b-${randomUUID().slice(0, 8)}`, displayName: 'B Unit', unitType: 'bu' })
      .returning()
    await regionPatchHandler(adminEvent('PATCH', f.teammateId, { region_id: regionBId, org_unit_id: ouB!.id }))

    // The live device moved with the teammate; the ended one did not.
    const devices = await t.client<{ id: string; region_id: string; org_unit_id: string }[]>`
      SELECT instance_id::text AS id, region_id::text AS region_id, org_unit_id::text AS org_unit_id
        FROM instance_attestation WHERE instance_id IN (${f.instanceId}::uuid, ${ended}::uuid)`
    const byId = new Map(devices.map((d) => [d.id, d]))
    expect(byId.get(f.instanceId)).toMatchObject({ region_id: regionBId, org_unit_id: ouB!.id })
    expect(byId.get(ended)).toMatchObject({ region_id: regionAId, org_unit_id: ouAId })

    // The move is audited with the devices it re-placed.
    const [audit] = await t.client<{ ids: string[] }[]>`
      SELECT payload->'rehomedInstanceIds' AS ids FROM audit_event
       WHERE event_type = 'teammate-region-reassigned' AND subject_id = ${f.teammateId}::uuid`
    expect(audit!.ids).toEqual([f.instanceId])

    // The reader re-serves the old record too (the joiner's overlap re-read).
    const after = record(10, 222)
    await runReadJoiner(t.db as never, readerOf(new Map([[f.instanceId, [before, after]]])), { sessionIds: [f.instanceId] })
    const rows = await t.client<{ tokens: string; region_id: string; org_unit_id: string }[]>`
      SELECT tokens::text AS tokens, region_id::text AS region_id, org_unit_id::text AS org_unit_id
        FROM attribution_record WHERE instance_id = ${f.instanceId}::uuid ORDER BY ts_event`
    expect(rows).toEqual([
      { tokens: '111', region_id: regionAId, org_unit_id: ouAId },
      { tokens: '222', region_id: regionBId, org_unit_id: ouB!.id },
    ])

    // Region B's admin lists the device; region A's no longer does.
    const [admB] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: `oid-esr-admb-${randomUUID().slice(0, 8)}`, email: `esr-admb-${randomUUID().slice(0, 8)}@x.test`, role: 'admin', regionId: regionBId, orgUnitId: ouB!.id })
      .returning()
    const listFor = async (session: Session) => {
      const out = (await adminInstancesHandler(adminEvent('GET', 'x', undefined, session))) as { instances: { instance_id: string }[] }
      return out.instances.map((i) => i.instance_id)
    }
    expect(await listFor({ teammateId: admB!.id, email: 'b@x.test', displayName: 'B', role: 'admin', regionId: regionBId, orgPath: 'esr_b' })).toContain(f.instanceId)
    expect(await listFor({ ...adminSession(), role: 'admin' })).not.toContain(f.instanceId)
  })

  it('revoke-sessions still ends the live devices', async () => {
    const f = await fixture()
    await revokeSessionsHandler(adminEvent('POST', f.teammateId, {}))
    expect(await deviceEnded(f.instanceId)).toBe(true)
  })
})
