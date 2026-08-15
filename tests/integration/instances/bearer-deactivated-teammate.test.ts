// @vitest-environment node
/*
 * A DEACTIVATED teammate's device must go silent QUIETLY.
 *
 * Two independent axes retire a teammate, and they are not interchangeable:
 * `revoked_at` is a session anchor (ADR-0005 §E2, compared against issuance),
 * while `is_active = false` is durable state written by the
 * privileged-identity-cleanup worker — whose ONLY identity mutation it is. Round
 * 2 added the `is_active` gate to the credential paths, so such a device now
 * correctly 401s at /bearer.
 *
 * THIS FILE PINS THE OTHER HALF OF THAT CHANGE. A 401 at /bearer is normally the
 * went-silent DISASTER signal — the durable emit credential was rejected, so
 * OTLP export stops with no other symptom — and the handler records it as an
 * instance-health row that surfaces to the operator. `instanceLifecycleSilent`
 * is what separates "expected" from "disaster", and it reasoned only about
 * `ts_actual_end` and `revoked_at`. So the moment deactivation started producing
 * 401s, every poll from a deliberately retired device began raising a false
 * "your emit credential failed" alert about a control working exactly as
 * designed — a regression created BY the security fix, invisible to it.
 *
 * The retirement worker runs unattended and the emit helper re-polls every
 * ~29 minutes, so this is not a one-off: it is a recurring alert per retired
 * device, on the alarm whose whole value is that it is rare.
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
let teammateId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'bearer-deactivated-test-key-padded-beyond-32ch'
  process.env.NUXT_SESSION_SECRET = 'bearer-deactivated-test-padded-to-thirty-two-c'
  resetHmacKeyForTests()

  const [r] = await t.db.insert(schema.region).values({ code: 'da-r', displayName: 'DA R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'da.svc', code: 'da-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-da', email: 'da@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  teammateId = tm!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function enrolInstance(): Promise<string> {
  const instanceId = randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start, region_id, org_unit_id, attestation_state)
    VALUES ('${instanceId}','oid-da','da@x.test','${teammateId}','claude-code',NOW(),'${regionId}','${ouId}','unassigned')`)
  return instanceId
}

function bearerEvent(instanceId: string, token: string) {
  return {
    context: { params: { instanceId } },
    node: {
      req: { method: 'GET', url: '/x', headers: { authorization: `Bearer ${token}` } },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) {
          return this._headers[n.toLowerCase()]
        },
        setHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        removeHeader(n: string) {
          this._headers[n.toLowerCase()] = ''
        },
        appendHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        get headersSent() {
          return false
        },
      },
    },
  }
}

async function openHealthSignals(instanceId: string): Promise<number> {
  const rows = await t.client.unsafe(`
    SELECT count(*)::int AS n FROM instance_attestation_health
     WHERE instance_id = '${instanceId}' AND resolved_at IS NULL`)
  return (rows as unknown as { n: number }[])[0]!.n
}

const setActive = (v: boolean) =>
  t.client.unsafe(`UPDATE teammate SET is_active = ${v} WHERE id = '${teammateId}'`)

describe('/bearer and a deactivated teammate', () => {
  it('mints normally while the teammate is active (the control case)', async () => {
    await setActive(true)
    const instanceId = await enrolInstance()
    const { tokens } = await issueEmitCredential(t.db as never, teammateId)
    const out = (await bearerHandler(
      bearerEvent(instanceId, tokens.access_token) as never,
    )) as { Authorization: string }
    expect(out.Authorization).toMatch(/^Bearer /)
    expect(await openHealthSignals(instanceId)).toBe(0)
  })

  it('401s once the teammate is deactivated', async () => {
    await setActive(true)
    const instanceId = await enrolInstance()
    // Mint while ACTIVE — issueTokens refuses outright otherwise, so this is the
    // only way to hold a credential that was legitimately issued and is then
    // retired underneath its holder. That is exactly what the cleanup worker does.
    const { tokens } = await issueEmitCredential(t.db as never, teammateId)
    await setActive(false)

    await expect(
      bearerHandler(bearerEvent(instanceId, tokens.access_token) as never),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('does NOT raise a bearer-auth-failed health signal for that 401', async () => {
    // The regression this file exists for. Every other input to the recorder is
    // satisfied — the instance is live (no ts_actual_end), the token is the
    // owner's, it carries tokenscope.emit, it is bound here — so
    // instanceLifecycleSilent is the ONLY thing standing between a deliberate
    // retirement and a false "your emit credential failed" alert.
    await setActive(true)
    const instanceId = await enrolInstance()
    const { tokens } = await issueEmitCredential(t.db as never, teammateId)
    await setActive(false)

    await expect(
      bearerHandler(bearerEvent(instanceId, tokens.access_token) as never),
    ).rejects.toMatchObject({ statusCode: 401 })

    expect(await openHealthSignals(instanceId)).toBe(0)
  })

  it('STILL raises the signal for a genuine credential failure (the alarm is not just muted)', async () => {
    // The other direction, so a fix that simply stopped recording would fail
    // here: an active teammate whose token has been revoked is the real
    // went-silent disaster, and it must still surface.
    await setActive(true)
    const instanceId = await enrolInstance()
    const { tokens } = await issueEmitCredential(t.db as never, teammateId)
    await t.client.unsafe(`UPDATE oauth_token SET revoked_at = NOW() WHERE teammate_id = '${teammateId}'`)

    await expect(
      bearerHandler(bearerEvent(instanceId, tokens.access_token) as never),
    ).rejects.toMatchObject({ statusCode: 401 })

    expect(await openHealthSignals(instanceId)).toBe(1)
  })
})

/*
 * NOT named "atomically". These cases prove the GATE (refusal + no row written);
 * they deliberately do not claim to prove the absence of a race, because a
 * sequential deactivate-then-issue would pass against the old
 * SELECT-then-INSERT implementation too. Proving atomicity needs two connections
 * with a barrier between the snapshot and the commit; the honest scope here is
 * the gate, and `issueTokens`' own comment states the residual window.
 */
describe('issueTokens refuses to mint for a deactivated teammate', () => {
  it('raises invalid_grant and writes NO oauth_token row', async () => {
    await setActive(false)
    const before = await t.client.unsafe(
      `SELECT count(*)::int AS n FROM oauth_token WHERE teammate_id = '${teammateId}'`,
    )
    await expect(issueEmitCredential(t.db as never, teammateId)).rejects.toMatchObject({
      code: 'invalid_grant',
    })
    const after = await t.client.unsafe(
      `SELECT count(*)::int AS n FROM oauth_token WHERE teammate_id = '${teammateId}'`,
    )
    // The gate is the INSERT's own WHERE EXISTS, so "refused" and "wrote
    // nothing" are one statement rather than two. (That the two cannot be
    // straddled by an application-level window is a property of the SQL, not
    // something this sequential test observes — see the describe block above.)
    expect((after as unknown as { n: number }[])[0]!.n).toBe(
      (before as unknown as { n: number }[])[0]!.n,
    )
    await setActive(true)
  })
})
