// @vitest-environment node
/*
 * Ending a device revokes the credentials bound to it (mig 0141). Before, only
 * re-provisioning did: every other path ended the device and left its
 * credential live, so an access token minted BEFORE the end kept working on
 * /instances/{id}/project-resolve (which does not re-check the device) until its
 * own 30-day expiry.
 *
 * The rule is a trigger, so each test ends the device through a DIFFERENT
 * writer and then presents the pre-end access token at the route.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { resetHmacKeyForTests, hashSessionToken } from '../../../server/auth/hmac'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import { refreshAccessToken } from '../../../server/auth/oauth'
import { issueInstanceEmitCredentialTx, mintEmitHandoff } from '../../../server/auth/emit-provision'
import redeemHandler from '../../../server/api/v1/setup/redeem.post'
import { revokeGrant } from '../../../server/utils/grant-revoke'
import { endLiveDevicesOf } from '../../../server/utils/device-lifecycle'
import { runSessionGc } from '../../../server/workers/session-gc'
import { runSoftPurge } from '../../../server/workers/soft-purge'
import projectResolveHandler from '../../../server/api/v1/instances/[instanceId]/project-resolve.get'
import endHandler from '../../../server/api/v1/instances/[instanceId]/end.post'
import bearerHandler from '../../../server/api/v1/instances/[instanceId]/bearer.get'

const DAY_MS = 24 * 60 * 60 * 1000
const CODE_HASH = 'a'.repeat(64)

let t: TestDb
let regionId: string
let ouId: string
let ownerId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'device-end-revokes-key-padded-well-beyond-32-chars'
  process.env.NUXT_SESSION_SECRET = 'device-end-revokes-padded-to-thirty-two-chars!!'
  resetHmacKeyForTests()

  const [r] = await t.db.insert(schema.region).values({ code: 'der-r', displayName: 'DER R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'der.svc', code: 'der-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [owner] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-der-owner', email: 'der-owner@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  ownerId = owner!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function enrolDevice(opts: { ageDays?: number; expectedEnd?: Date } = {}): Promise<string> {
  const instanceId = randomUUID()
  const ageDays = opts.ageDays ?? 1
  const expectedEnd = opts.expectedEnd ?? new Date(Date.now() + 80 * DAY_MS)
  await t.client`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start, ts_expected_end,
       region_id, org_unit_id, attestation_state)
    VALUES (${instanceId}::uuid, 'oid-der', 'der@x.test', ${ownerId}::uuid, 'claude-code',
            ${new Date(Date.now() - ageDays * DAY_MS).toISOString()}::timestamptz,
            ${expectedEnd.toISOString()}::timestamptz, ${regionId}::uuid, ${ouId}::uuid, 'unassigned')`
  return instanceId
}

/** A bound credential plus an access token minted from it while the device is live. */
async function liveDeviceCredential(instanceId: string) {
  const cred = await t.db.transaction((tx) =>
    issueInstanceEmitCredentialTx(tx as never, ownerId, instanceId, issueEmitCredential),
  )
  const { access_token } = await refreshAccessToken(t.db as never, cred.refreshToken, cred.clientId)
  return { ...cred, accessToken: access_token }
}

function instanceEvent(instanceId: string, token: string, opts: { method?: string; query?: Record<string, string> } = {}) {
  const url = '/x' + (opts.query ? '?' + new URLSearchParams(opts.query).toString() : '')
  return {
    path: url,
    context: { params: { instanceId } },
    node: {
      req: { method: opts.method ?? 'GET', url, headers: { authorization: `Bearer ${token}` } },
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

const resolveProject = (instanceId: string, token: string) =>
  projectResolveHandler(instanceEvent(instanceId, token, { query: { code_hash: CODE_HASH } }) as never)

async function isEnded(instanceId: string): Promise<boolean> {
  const [row] = await t.client<{ ended: boolean }[]>`
    SELECT ts_actual_end IS NOT NULL AS ended FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
  return row!.ended
}

async function isRevoked(refreshToken: string): Promise<boolean> {
  const [row] = await t.client<{ revoked: boolean }[]>`
    SELECT revoked_at IS NOT NULL AS revoked FROM oauth_token
     WHERE refresh_token_hash = ${hashSessionToken(refreshToken)}`
  return row!.revoked
}

describe('the pre-end access token stops working the moment its device ends', () => {
  it('fixture sanity: while the device is live the token resolves (so the refusals below are real)', async () => {
    const instanceId = await enrolDevice()
    const cred = await liveDeviceCredential(instanceId)
    await expect(resolveProject(instanceId, cred.accessToken)).resolves.toBeTruthy()
    expect(await isRevoked(cred.refreshToken)).toBe(false)
  })

  it('ended by the client (/end)', async () => {
    const instanceId = await enrolDevice()
    const cred = await liveDeviceCredential(instanceId)
    await endHandler(instanceEvent(instanceId, cred.accessToken, { method: 'POST' }) as never)

    expect(await isRevoked(cred.refreshToken)).toBe(true)
    await expect(resolveProject(instanceId, cred.accessToken)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('ended by session-gc (idle past its window)', async () => {
    const instanceId = await enrolDevice({ ageDays: 100, expectedEnd: new Date(Date.now() - DAY_MS) })
    const cred = await liveDeviceCredential(instanceId)
    await runSessionGc(t.db, new Date())

    expect(await isRevoked(cred.refreshToken)).toBe(true)
    await expect(resolveProject(instanceId, cred.accessToken)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('ended by any other writer (admin / region change / grant revoke all set ts_actual_end)', async () => {
    const instanceId = await enrolDevice()
    const cred = await liveDeviceCredential(instanceId)
    await t.client`UPDATE instance_attestation SET ts_actual_end = now()
                    WHERE teammate_id = ${ownerId}::uuid AND instance_id = ${instanceId}::uuid`

    expect(await isRevoked(cred.refreshToken)).toBe(true)
    await expect(resolveProject(instanceId, cred.accessToken)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('purged by soft-purge', async () => {
    const instanceId = await enrolDevice({ ageDays: 400 })
    const cred = await liveDeviceCredential(instanceId)
    // soft-purge retires ended devices only; end it without the trigger's
    // help first so the purge arm is what this test proves.
    await t.client.begin(async (tx) => {
      await tx`ALTER TABLE instance_attestation DISABLE TRIGGER instance_attestation_end_revokes_credentials`
      await tx`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
      await tx`ALTER TABLE instance_attestation ENABLE TRIGGER instance_attestation_end_revokes_credentials`
    })
    expect(await isRevoked(cred.refreshToken)).toBe(false)

    await runSoftPurge(t.db, new Date())
    expect(await isRevoked(cred.refreshToken)).toBe(true)
  })

  it('deleted: revoked BEFORE the FK de-binds it (ON DELETE SET NULL would otherwise leave it live and unbound)', async () => {
    const instanceId = await enrolDevice()
    const cred = await liveDeviceCredential(instanceId)
    await t.client`DELETE FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`

    const [row] = await t.client<{ revoked: boolean; instance_id: string | null }[]>`
      SELECT revoked_at IS NOT NULL AS revoked, instance_id::text AS instance_id FROM oauth_token
       WHERE refresh_token_hash = ${hashSessionToken(cred.refreshToken)}`
    expect(row).toEqual({ revoked: true, instance_id: null })
  })
})

function redeemEvent(handoffCode: string) {
  return {
    method: 'POST',
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method: 'POST',
        url: '/x',
        body: { handoff_code: handoffCode },
        headers: { host: 'localhost:3450', 'content-type': 'application/json' },
      },
      res: instanceEvent('', '').node.res,
    },
  }
}

async function liveBoundCredentials(instanceId: string): Promise<number> {
  const [row] = await t.client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM oauth_token WHERE instance_id = ${instanceId}::uuid AND revoked_at IS NULL`
  return row!.n
}

describe('a handoff cannot mint a credential for an ended device', () => {
  it('an outstanding handoff dies with its device, and redeeming it is refused', async () => {
    const instanceId = await enrolDevice()
    const { code } = await mintEmitHandoff(t.db as never, ownerId, instanceId)
    await t.client`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`

    await expect(redeemHandler(redeemEvent(code) as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(await liveBoundCredentials(instanceId)).toBe(0)
  })

  it('the binder refuses an ended device even for a handoff the end did not see (409, nothing minted)', async () => {
    const instanceId = await enrolDevice()
    await t.client`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
    const { code } = await mintEmitHandoff(t.db as never, ownerId, instanceId) // minted after the end

    await expect(redeemHandler(redeemEvent(code) as never)).rejects.toMatchObject({ statusCode: 409 })
    expect(await liveBoundCredentials(instanceId)).toBe(0)
  })
})

/** Resolves once another backend is parked on a lock (ordering by fact, not by sleep). */
async function untilBlockedOnRowLock(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [row] = await t.client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
    if (row!.n > 0) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('untilBlockedOnRowLock: nothing blocked; the race under test never happened')
}

describe('a historical PURGED-but-never-ended device (pre-fix soft-purge selected by age alone)', () => {
  async function purgedButOpenDevice() {
    const instanceId = await enrolDevice({ ageDays: 400 })
    const cred = await liveDeviceCredential(instanceId)
    await t.client.begin(async (tx) => {
      await tx`ALTER TABLE instance_attestation DISABLE TRIGGER instance_attestation_end_revokes_credentials`
      await tx`ALTER TABLE instance_attestation DISABLE TRIGGER instance_attestation_purge_only_ended`
      await tx`UPDATE instance_attestation SET ts_purged = now() WHERE instance_id = ${instanceId}::uuid`
      await tx`ALTER TABLE instance_attestation ENABLE TRIGGER instance_attestation_purge_only_ended`
      await tx`ALTER TABLE instance_attestation ENABLE TRIGGER instance_attestation_end_revokes_credentials`
    })
    return { instanceId, cred }
  }

  async function openBearerFailures(instanceId: string): Promise<number> {
    const [row] = await t.client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM instance_attestation_health
       WHERE instance_id = ${instanceId}::uuid AND status = 'bearer-auth-failed' AND resolved_at IS NULL`
    return row!.n
  }

  it("/bearer answers the owner 'Session ended' and raises no false health alert", async () => {
    const { instanceId, cred } = await purgedButOpenDevice()
    await t.client`UPDATE oauth_token SET revoked_at = now()
                    WHERE refresh_token_hash = ${hashSessionToken(cred.refreshToken)}`
    await expect(bearerHandler(instanceEvent(instanceId, cred.accessToken) as never)).rejects.toMatchObject({
      statusCode: 401,
      statusMessage: 'Session ended',
    })
    expect(await openBearerFailures(instanceId)).toBe(0)
  })

  it('mig 0141 ends it at its purge time and revokes its credential', async () => {
    const { instanceId, cred } = await purgedButOpenDevice()
    await t.client.unsafe(
      readFileSync(join(process.cwd(), 'drizzle', 'migrations', '0141_end_device_revokes_its_credentials.sql'), 'utf8'),
    )
    const [row] = await t.client<{ same: boolean }[]>`
      SELECT ts_actual_end = ts_purged AS same FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
    expect(row!.same).toBe(true)
    expect(await isRevoked(cred.refreshToken)).toBe(true)
  })
})

describe('one lock order: a redeem racing a device end resolves cleanly, never a deadlock', () => {
  it('the end commits, the redeem is refused (401), no credential is minted', async () => {
    const instanceId = await enrolDevice()
    const { code } = await mintEmitHandoff(t.db as never, ownerId, instanceId)
    let redeem: Promise<unknown> | undefined
    await t.client.begin(async (tx) => {
      // The ender holds the device row, as every device-ending UPDATE does...
      await tx`SELECT 1 FROM instance_attestation WHERE instance_id = ${instanceId}::uuid FOR UPDATE`
      redeem = redeemHandler(redeemEvent(code) as never)
      redeem.catch(() => {})
      await untilBlockedOnRowLock()
      // ...then ends it, which (trigger) touches the handoff. A redeem that had
      // claimed the handoff first would now be waiting on us: a deadlock.
      await tx`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
    })
    await expect(redeem).rejects.toMatchObject({ statusCode: 401 })
    expect(await liveBoundCredentials(instanceId)).toBe(0)
  })
})

describe('one lock order: a grant revoke racing a credential rotation resolves cleanly', () => {
  it('revokeGrant waits on the device first, so the rotating transaction commits and the grant still ends', async () => {
    const instanceId = await enrolDevice()
    const cred = await liveDeviceCredential(instanceId)
    const [grant] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM oauth_token WHERE refresh_token_hash = ${hashSessionToken(cred.refreshToken)}`
    let revoking: Promise<unknown> | undefined
    await t.client.begin(async (tx) => {
      // The binder's shape: device row, then this device's oauth_token rows.
      await tx`SELECT 1 FROM instance_attestation WHERE instance_id = ${instanceId}::uuid FOR UPDATE`
      // In a transaction, as both production callers (me/admin grant revoke) run it.
      revoking = t.db.transaction((rtx) =>
        revokeGrant(rtx as never, {
          id: grant!.id,
          teammateId: ownerId,
          scope: 'tokenscope.emit',
          revokedAt: null,
          instanceId,
        }),
      )
      revoking.catch(() => {})
      await untilBlockedOnRowLock()
      await tx`UPDATE oauth_token SET last_used_at = now() WHERE id = ${grant!.id}::uuid`
    })
    await expect(revoking).resolves.toMatchObject({ revoked: true, instancesEnded: 1 })
    expect(await isRevoked(cred.refreshToken)).toBe(true)
  })
})

describe('mig 0143: the database refuses binding a live credential to a device that is not live and owned', () => {
  // Raw SQL is the point: a binder that predates issueInstanceEmitCredentialTx's
  // check (an old replica mid-rollout) writes exactly this.
  const bind = (refreshToken: string, instanceId: string) => t.client`
    UPDATE oauth_token SET instance_id = ${instanceId}::uuid
     WHERE refresh_token_hash = ${hashSessionToken(refreshToken)}`

  it('an ENDED device: refused', async () => {
    const instanceId = await enrolDevice()
    await t.client`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
    const cred = await issueEmitCredential(t.db as never, ownerId)
    await expect(bind(cred.tokens.refresh_token, instanceId)).rejects.toThrow(/cannot be bound/)
  })

  it("another teammate's device: refused", async () => {
    const [other] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: `oid-der-${randomUUID()}`, email: `der-${randomUUID()}@x.test`, role: 'developer', regionId, orgUnitId: ouId })
      .returning()
    const theirs = randomUUID()
    await t.client`
      INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, attestation_state)
      VALUES (${theirs}::uuid, 'oid-der-x', ${other!.id}::uuid, 'claude-code', ${regionId}::uuid, ${ouId}::uuid, 'unassigned')`
    const cred = await issueEmitCredential(t.db as never, ownerId)
    await expect(bind(cred.tokens.refresh_token, theirs)).rejects.toThrow(/cannot be bound/)
  })

  it('re-applying mig 0143 revokes a live credential a pre-guard binder left on an ended device', async () => {
    const instanceId = await enrolDevice()
    await t.client`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
    const cred = await issueEmitCredential(t.db as never, ownerId)
    await t.client.begin(async (tx) => {
      await tx`ALTER TABLE oauth_token DISABLE TRIGGER oauth_token_bind_only_to_live_device`
      await tx`UPDATE oauth_token SET instance_id = ${instanceId}::uuid
                WHERE refresh_token_hash = ${hashSessionToken(cred.tokens.refresh_token)}`
      await tx`ALTER TABLE oauth_token ENABLE TRIGGER oauth_token_bind_only_to_live_device`
    })
    expect(await isRevoked(cred.tokens.refresh_token)).toBe(false) // the gap state

    await t.client.unsafe(
      readFileSync(join(process.cwd(), 'drizzle', 'migrations', '0143_bind_only_to_live_device.sql'), 'utf8'),
    )
    expect(await isRevoked(cred.tokens.refresh_token)).toBe(true)
  })

  it("re-pointing a bound live credential to another teammate: refused", async () => {
    const instanceId = await enrolDevice()
    const cred = await liveDeviceCredential(instanceId)
    const [other] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: `oid-der-${randomUUID()}`, email: `der-${randomUUID()}@x.test`, role: 'developer', regionId, orgUnitId: ouId })
      .returning()
    await expect(
      t.client`UPDATE oauth_token SET teammate_id = ${other!.id}::uuid
                WHERE refresh_token_hash = ${hashSessionToken(cred.refreshToken)}`,
    ).rejects.toThrow(/cannot be bound/)
  })

  it('a live owned device: allowed; and a REVOKED credential may carry an ended binding', async () => {
    const instanceId = await enrolDevice()
    const cred = await issueEmitCredential(t.db as never, ownerId)
    await bind(cred.tokens.refresh_token, instanceId)
    await t.client`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
    expect(await isRevoked(cred.tokens.refresh_token)).toBe(true)
  })
})

describe('grant re-revoke of a STALE grant leaves the re-provisioned device alone', () => {
  it('re-revoking the old grant neither ends the reused device nor revokes its new credential', async () => {
    const instanceId = await enrolDevice()
    const old = await liveDeviceCredential(instanceId)
    const fresh = await liveDeviceCredential(instanceId) // re-provision: same device, old grant rotated out
    expect(await isRevoked(old.refreshToken)).toBe(true)
    const [row] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM oauth_token WHERE refresh_token_hash = ${hashSessionToken(old.refreshToken)}`

    const res = await t.db.transaction((tx) =>
      revokeGrant(tx as never, { id: row!.id, teammateId: ownerId, scope: 'tokenscope.emit', revokedAt: new Date(), instanceId }),
    )
    expect(res).toMatchObject({ revoked: false, instancesEnded: 0 })
    expect(await isRevoked(fresh.refreshToken)).toBe(false)
    await expect(resolveProject(instanceId, fresh.accessToken)).resolves.toBeTruthy()
  })
})

describe('grant revoke racing a re-provision decides on the grant AFTER the locks', () => {
  it('the grant is rotated out while the revoke waits: no cascade, the reused device stays live', async () => {
    const instanceId = await enrolDevice()
    const old = await liveDeviceCredential(instanceId)
    const [row] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM oauth_token WHERE refresh_token_hash = ${hashSessionToken(old.refreshToken)}`
    let revoking: Promise<{ revoked: boolean; instancesEnded: number }> | undefined
    await t.client.begin(async (tx) => {
      // A re-provision: holds the device, then rotates the old grant out.
      await tx`SELECT 1 FROM instance_attestation WHERE instance_id = ${instanceId}::uuid FOR UPDATE`
      // The caller read the grant as LIVE before either lock existed.
      revoking = t.db.transaction((rtx) =>
        revokeGrant(rtx as never, { id: row!.id, teammateId: ownerId, scope: 'tokenscope.emit', revokedAt: null, instanceId }),
      )
      revoking.catch(() => {})
      await untilBlockedOnRowLock()
      await tx`UPDATE oauth_token SET revoked_at = now() WHERE id = ${row!.id}::uuid`
    })
    await expect(revoking).resolves.toMatchObject({ revoked: false, instancesEnded: 0 })
    expect(await isEnded(instanceId)).toBe(false)
  })
})

describe('/bearer: the idle-window renewal is required, not best-effort', () => {
  it('if the renewal write fails, no bearer is minted (the helper retries) and the window is untouched', async () => {
    const instanceId = await enrolDevice()
    const cred = await liveDeviceCredential(instanceId)
    const [before] = await t.client<{ e: string }[]>`
      SELECT ts_expected_end::text AS e FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
    await t.client.unsafe(`
      CREATE FUNCTION der_fail_renewal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.last_bearer_at IS DISTINCT FROM OLD.last_bearer_at THEN RAISE EXCEPTION 'renewal down'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER der_fail_renewal BEFORE UPDATE ON instance_attestation
        FOR EACH ROW EXECUTE FUNCTION der_fail_renewal();`)
    try {
      await expect(bearerHandler(instanceEvent(instanceId, cred.accessToken) as never)).rejects.toThrow()
    } finally {
      await t.client.unsafe(`DROP TRIGGER der_fail_renewal ON instance_attestation; DROP FUNCTION der_fail_renewal();`)
    }
    const [after] = await t.client<{ e: string }[]>`
      SELECT ts_expected_end::text AS e FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
    expect(after!.e).toBe(before!.e)
  })
})

describe('multi-device ends lock in instance_id order (server/utils/device-lifecycle.ts)', () => {
  it('a bulk end waits on the LOWEST device first, holding nothing, so it cannot deadlock', async () => {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: `oid-der-${randomUUID()}`, email: `der-${randomUUID()}@x.test`, role: 'developer', regionId, orgUnitId: ouId })
      .returning()
    // Inserted HIGH id first, so heap (scan) order is the reverse of id order:
    // an unordered UPDATE would lock `high` first.
    const high = 'ffffffff-ffff-4fff-bfff-ffffffffffff'
    const low = '00000000-0000-4000-8000-000000000001'
    for (const id of [high, low]) {
      await t.client`
        INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, attestation_state)
        VALUES (${id}::uuid, 'oid-der-bulk', ${tm!.id}::uuid, 'claude-code', ${regionId}::uuid, ${ouId}::uuid, 'unassigned')`
    }
    let bulk: Promise<string[]> | undefined
    await t.client.begin(async (tx) => {
      await tx`SELECT 1 FROM instance_attestation WHERE instance_id = ${low}::uuid FOR UPDATE`
      bulk = t.db.transaction((btx) => endLiveDevicesOf(btx as never, tm!.id))
      bulk.catch(() => {})
      await untilBlockedOnRowLock()
      // A second multi-device path now takes `high`. If the bulk end held it, this deadlocks.
      await tx`SELECT 1 FROM instance_attestation WHERE instance_id = ${high}::uuid FOR UPDATE`
    })
    expect((await bulk)!.sort()).toEqual([low, high])
  })
})

describe('mig 0144: only an ended device can be purged', () => {
  it('purging a LIVE device is refused, so an old soft-purge mid-rollout cannot cut it off', async () => {
    const instanceId = await enrolDevice({ ageDays: 400 })
    await expect(
      t.client`UPDATE instance_attestation SET ts_purged = now() WHERE instance_id = ${instanceId}::uuid`,
    ).rejects.toThrow(/cannot be purged while it is live/)
  })

  it('purging an ENDED device is allowed', async () => {
    const instanceId = await enrolDevice({ ageDays: 400 })
    await t.client`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
    await t.client`UPDATE instance_attestation SET ts_purged = now() WHERE instance_id = ${instanceId}::uuid`
  })
})

describe('grant revoke refuses a grant re-pointed since the caller read it', () => {
  it('confirm-instance moved the grant to another teammate meanwhile: 409, nothing ended', async () => {
    const instanceId = await enrolDevice()
    const cred = await liveDeviceCredential(instanceId)
    const [row] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM oauth_token WHERE refresh_token_hash = ${hashSessionToken(cred.refreshToken)}`
    await expect(
      t.db.transaction((tx) =>
        revokeGrant(tx as never, {
          id: row!.id,
          teammateId: '9a1e0000-0000-4000-8000-00000000beef', // the snapshot's (stale) owner
          scope: 'tokenscope.emit',
          revokedAt: null,
          instanceId,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(await isEnded(instanceId)).toBe(false)
    expect(await isRevoked(cred.refreshToken)).toBe(false)
  })
})

describe('/bearer still tells the OWNER why, and nobody else', () => {
  it("the owner's pre-end token gets 401 'Session ended', the diagnosis status surfaces", async () => {
    const instanceId = await enrolDevice()
    const cred = await liveDeviceCredential(instanceId)
    await t.client`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
    await expect(bearerHandler(instanceEvent(instanceId, cred.accessToken) as never)).rejects.toMatchObject({
      statusCode: 401,
      statusMessage: 'Session ended',
    })
  })

  it('a garbage token on the same ended device gets the uniform 401, not the lifecycle (no existence oracle)', async () => {
    const instanceId = await enrolDevice()
    await t.client`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
    const err = await bearerHandler(instanceEvent(instanceId, 'not-a-real-token') as never).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 401 })
    expect((err as { statusMessage?: string }).statusMessage).not.toBe('Session ended')
  })
})

describe('what the rule must NOT touch', () => {
  it('a live device: the /bearer-style heartbeat update does not revoke', async () => {
    const instanceId = await enrolDevice()
    const cred = await liveDeviceCredential(instanceId)
    await t.client`UPDATE instance_attestation
                      SET last_bearer_at = now(), ts_expected_end = now() + interval '90 days'
                    WHERE instance_id = ${instanceId}::uuid`
    expect(await isRevoked(cred.refreshToken)).toBe(false)
  })

  it("an UNBOUND credential survives the end of the teammate's device", async () => {
    const instanceId = await enrolDevice()
    const unbound = await issueEmitCredential(t.db as never, ownerId)
    await t.client`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
    expect(await isRevoked(unbound.tokens.refresh_token)).toBe(false)
  })

  it("another device's credential survives this device ending", async () => {
    const a = await enrolDevice()
    const b = await enrolDevice()
    const credB = await liveDeviceCredential(b)
    await t.client`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${a}::uuid`
    expect(await isRevoked(credB.refreshToken)).toBe(false)
  })
})

describe('mig 0141 backfill: devices ended BEFORE the rule existed', () => {
  it('re-applying the (idempotent) migration revokes a credential its ended device left live', async () => {
    const instanceId = await enrolDevice()
    const cred = await liveDeviceCredential(instanceId)
    await t.client.begin(async (tx) => {
      await tx`ALTER TABLE instance_attestation DISABLE TRIGGER instance_attestation_end_revokes_credentials`
      await tx`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
      await tx`ALTER TABLE instance_attestation ENABLE TRIGGER instance_attestation_end_revokes_credentials`
    })
    expect(await isRevoked(cred.refreshToken)).toBe(false) // the pre-0141 state

    const migration = readFileSync(
      join(process.cwd(), 'drizzle', 'migrations', '0141_end_device_revokes_its_credentials.sql'),
      'utf8',
    )
    await t.client.unsafe(migration)
    expect(await isRevoked(cred.refreshToken)).toBe(true)
  })
})
