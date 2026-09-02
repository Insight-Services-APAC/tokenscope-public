// @vitest-environment node
/*
 * Confirm-on-auth merge — emit-on-install slice 5 (the ONLY provisional→confirmed
 * path). docs/design/emit-on-install-provisional-attribution.md §Flows 3.
 *
 * Real DB via testcontainers (AGENTS.md: never mock Drizzle). The provisional
 * instance is minted through the REAL enroll handler so the fixtures match
 * production exactly; the merge + listing run through their real handlers.
 *
 * Invariants under test:
 *   1. GET /me/provisional-instances lists ONLY instances that claimed the
 *      caller's email (email-scoped, no peer leak).
 *   2. confirm re-points the attestation to the real teammate, flips to
 *      'confirmed', re-binds the live emit credential, audits 'instance-confirmed',
 *      and retires the freed shadow teammate.
 *   3. THE anti-laundering gate: a user whose email != claimed_email gets 403.
 *   4. idempotent re-confirm → no-op success.
 *   5. confirming makes the spend eligible for the normal (confirmed) me/instances
 *      surface (owner-scoped by teammate_id).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import enrollHandler from '../../../server/api/v1/setup/enroll.post'
import listProvisional from '../../../server/api/v1/me/provisional-instances.get'
import confirmHandler from '../../../server/api/v1/me/provisional-instances/[instanceId]/confirm.post'
import meInstances from '../../../server/api/v1/me/instances.get'

let t: TestDb
let regionId: string
let ouId: string
let aliceId: string
let bobId: string

const BOOTSTRAP_SECRET = 'confirm-bootstrap-secret-value-1234567'
const ALICE = 'alice@example.com'
const BOB = 'bob@example.com'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'confirm-test-padded-to-thirty-two-chars!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'confirm-test-hmac-key-padded-well-beyond-32-chars'
  process.env.NUXT_ENROLLMENT_SECRET = BOOTSTRAP_SECRET

  const [r] = await t.db
    .insert(schema.region)
    .values({ code: 'cf', displayName: 'CF Region' })
    .returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'cf.svc',
      code: 'cf-svc',
      displayName: 'CF Svc',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  ouId = ou!.id

  const [alice] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'cf-oid-alice',
      email: ALICE,
      displayName: 'Alice',
      role: 'developer',
      regionId,
      orgUnitId: ouId,
    })
    .returning()
  aliceId = alice!.id
  const [bob] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'cf-oid-bob',
      email: BOB,
      displayName: 'Bob',
      role: 'developer',
      regionId,
      orgUnitId: ouId,
    })
    .returning()
  bobId = bob!.id
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

// ── harness (combines the enroll + me-endpoint event shapes) ──────────────────

function ev(opts: { params?: Record<string, string>; body?: unknown; session?: Session } = {}) {
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
  }
  const e = {
    method: 'POST',
    path: '/x',
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method: 'POST',
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
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
  if (opts.session)
    injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown
}

type AnyHandler = (e: unknown) => Promise<unknown>
async function call<R = unknown>(h: unknown, e: unknown): Promise<R> {
  return (h as AnyHandler)(e) as Promise<R>
}

const sess = (id: string, email: string): Session =>
  ({
    teammateId: id,
    email,
    displayName: email,
    role: 'developer',
    regionId,
    orgPath: 'cf.svc',
  }) as Session

interface EnrollResponse {
  instance_id: string
}
async function enrollProvisional(claimedEmail: string, device: string): Promise<string> {
  const out = await call<EnrollResponse>(
    enrollHandler,
    ev({
      body: {
        enrollment_secret: BOOTSTRAP_SECRET,
        claimed_email: claimedEmail,
        device_binding: device,
      },
    }),
  )
  return out.instance_id
}

async function shadowTeammateOf(instanceId: string): Promise<string> {
  const rows = await t.client<{ teammate_id: string }[]>`
    SELECT teammate_id::text AS teammate_id FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
  return rows[0]!.teammate_id
}

async function seedSpend(instanceId: string, shadowTeammateId: string, costUsd: string) {
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    claudeSessionId: 'conv-' + instanceId.slice(0, 8),
    teammateId: shadowTeammateId,
    regionId,
    orgUnitId: ouId,
    tool: 'claude-code',
    model: 'claude-fable-5',
    tokenType: 'input',
    tokens: 1_000n,
    costUsd,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: new Date(),
    identityState: 'provisional',
  } as never)
}

// ── 1. listing ────────────────────────────────────────────────────────────────

describe('GET /me/provisional-instances — email-scoped listing', () => {
  it('lists only instances that claimed the caller email, with device hint + spend', async () => {
    const inst = await enrollProvisional(ALICE, 'list-dev-alice')
    const shadow = await shadowTeammateOf(inst)
    await seedSpend(inst, shadow, '2.500000')
    // A foil: an instance claiming Bob's email must NOT show for Alice.
    await enrollProvisional(BOB, 'list-dev-bob')

    const out = await call<{
      provisional_instances: {
        instance_id: string
        device_hint: string | null
        provisional_spend_usd: string
      }[]
    }>(listProvisional, ev({ session: sess(aliceId, ALICE) }))
    const row = out.provisional_instances.find((r) => r.instance_id === inst)
    expect(row).toBeTruthy()
    expect(row!.provisional_spend_usd).toBe('2.50')
    expect(row!.device_hint).toBeTruthy()
    // No Bob instance leaks into Alice's list.
    expect(out.provisional_instances.every((r) => r.instance_id !== undefined)).toBe(true)
    const bobInstanceIds = (
      await t.client<{ instance_id: string }[]>`
        SELECT instance_id::text AS instance_id FROM instance_attestation WHERE claimed_email = ${BOB}`
    ).map((r) => r.instance_id)
    expect(out.provisional_instances.some((r) => bobInstanceIds.includes(r.instance_id))).toBe(
      false,
    )
  })
})

// ── 2. confirm merge ───────────────────────────────────────────────────────────

describe('POST confirm — the merge', () => {
  it('re-points + confirms + re-binds the emit token + audits + retires the shadow', async () => {
    const inst = await enrollProvisional(ALICE, 'confirm-dev-1')
    const shadow = await shadowTeammateOf(inst)
    await seedSpend(inst, shadow, '1.000000')
    // Backdate the write instant so the dr-H4 assertion below can only pass if
    // the merge itself bumps it (performance-observability-baseline.md O5).
    await t.client`UPDATE attribution_record
      SET ts_recorded = now() - interval '3 days' WHERE instance_id = ${inst}::uuid`

    const out = await call<{ id: string; confirmed: boolean; already_confirmed: boolean }>(
      confirmHandler,
      ev({ params: { instanceId: inst }, session: sess(aliceId, ALICE) }),
    )
    expect(out).toMatchObject({ id: inst, confirmed: true, already_confirmed: false })

    // Attestation re-pointed + confirmed + claimed_email nulled + identity stamped.
    const att = await t.client<
      {
        teammate_id: string
        identity_state: string
        claimed_email: string | null
        principal_email: string | null
        principal_oid: string
        region_id: string
      }[]
    >`
      SELECT teammate_id::text AS teammate_id, identity_state, claimed_email, principal_email,
             principal_oid, region_id::text AS region_id
        FROM instance_attestation WHERE instance_id = ${inst}::uuid`
    expect(att[0]!.teammate_id).toBe(aliceId)
    expect(att[0]!.identity_state).toBe('confirmed')
    expect(att[0]!.claimed_email).toBeNull()
    expect(att[0]!.principal_email).toBe(ALICE)
    expect(att[0]!.principal_oid).toBe('cf-oid-alice')
    expect(att[0]!.region_id).toBe(regionId)

    // FIX 2: the already-written attribution history is re-pointed to the real
    // teammate AND upgraded to identity_state='confirmed' (+ re-stamped dims),
    // so the pre-confirm spend isn't orphaned on the retired shadow.
    const ar = await t.client<
      {
        teammate_id: string
        identity_state: string
        region_id: string
        org_unit_id: string
        bumped: boolean
      }[]
    >`
      SELECT teammate_id::text AS teammate_id, identity_state,
             region_id::text AS region_id, org_unit_id::text AS org_unit_id,
             (ts_recorded > now() - interval '1 minute') AS bumped
        FROM attribution_record WHERE instance_id = ${inst}::uuid`
    expect(ar.length).toBe(1)
    expect(ar[0]!.teammate_id).toBe(aliceId)
    expect(ar[0]!.identity_state).toBe('confirmed')
    expect(ar[0]!.region_id).toBe(regionId)
    expect(ar[0]!.org_unit_id).toBe(ouId)
    // dr-H4: the historical rewrite bumps ts_recorded in the SAME update — the
    // ledger-mutation contract (tag-session.ts:181-200) the usage-rollup
    // source-write signal depends on. Seeded 3 days stale above; must be fresh.
    expect(ar[0]!.bumped).toBe(true)
    // No attribution row remains bound to the shadow teammate.
    const orphan = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM attribution_record WHERE teammate_id = ${shadow}::uuid`
    expect(Number(orphan[0]!.c)).toBe(0)

    // The live emit credential is now bound to the REAL teammate.
    const tok = await t.client<{ teammate_id: string }[]>`
      SELECT teammate_id::text AS teammate_id FROM oauth_token
       WHERE instance_id = ${inst}::uuid AND scope = 'tokenscope.emit' AND revoked_at IS NULL`
    expect(tok.length).toBe(1)
    expect(tok[0]!.teammate_id).toBe(aliceId)

    // Audit row with the dispute-reconstruction payload.
    const audit = await t.client<{ payload: Record<string, unknown>; actor_teammate_id: string }[]>`
      SELECT payload, actor_teammate_id::text AS actor_teammate_id FROM audit_event
       WHERE event_type = 'instance-confirmed' AND subject_id = ${inst}::uuid`
    expect(audit.length).toBe(1)
    expect(audit[0]!.actor_teammate_id).toBe(aliceId)
    expect(audit[0]!.payload.prior_provisional_teammate_id).toBe(shadow)
    expect(audit[0]!.payload.claimed_email).toBe(ALICE)

    // Shadow teammate retired (mark-revoke, never deleted) — still present (FKs
    // from attribution_record/audit pin it) but provisional + revoked.
    const sh = await t.client<
      { provisional: boolean; revoked_at: string | null; is_active: boolean }[]
    >`
      SELECT provisional, revoked_at, is_active FROM teammate WHERE id = ${shadow}::uuid`
    expect(sh.length).toBe(1)
    expect(sh[0]!.revoked_at).not.toBeNull()
    expect(sh[0]!.is_active).toBe(false)
  })

  it('does NOT retire a shadow teammate that still owns another instance', async () => {
    // One shadow teammate, but enroll only mints a fresh shadow per (email,device);
    // to share a shadow we point a second instance at it directly.
    const inst = await enrollProvisional(ALICE, 'confirm-dev-multi')
    const shadow = await shadowTeammateOf(inst)
    const sibling = '00000000-0000-4000-8000-00000000ce11'
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: sibling,
      principalOid: 'provisional:sibling',
      teammateId: shadow,
      tool: 'claude-code',
      regionId,
      orgUnitId: ouId,
      attestationState: 'unassigned',
      identityState: 'provisional',
      claimedEmail: ALICE,
    } as never)

    await call(confirmHandler, ev({ params: { instanceId: inst }, session: sess(aliceId, ALICE) }))

    const sh = await t.client<{ revoked_at: string | null }[]>`
      SELECT revoked_at FROM teammate WHERE id = ${shadow}::uuid`
    expect(sh[0]!.revoked_at).toBeNull() // still owns `sibling` → not retired
  })
})

// ── 3. anti-laundering gate ────────────────────────────────────────────────────

describe('POST confirm — anti-laundering gate', () => {
  it('a user whose email != claimed_email CANNOT confirm (403)', async () => {
    const inst = await enrollProvisional(ALICE, 'laundering-dev')
    // Bob (a real, authenticated teammate) tries to confirm Alice's claimed device.
    await expect(
      call(confirmHandler, ev({ params: { instanceId: inst }, session: sess(bobId, BOB) })),
    ).rejects.toMatchObject({ statusCode: 403 })
    // Untouched: still provisional, still bound to the shadow teammate.
    const att = await t.client<{ identity_state: string; teammate_id: string }[]>`
      SELECT identity_state, teammate_id::text AS teammate_id FROM instance_attestation WHERE instance_id = ${inst}::uuid`
    expect(att[0]!.identity_state).toBe('provisional')
    expect(att[0]!.teammate_id).not.toBe(bobId)
  })
})

// ── 4. idempotency ─────────────────────────────────────────────────────────────

describe('POST confirm — idempotent', () => {
  it('re-confirming an already-confirmed own instance is a no-op success', async () => {
    const inst = await enrollProvisional(ALICE, 'idem-confirm-dev')
    const first = await call<{ confirmed: boolean; already_confirmed: boolean }>(
      confirmHandler,
      ev({ params: { instanceId: inst }, session: sess(aliceId, ALICE) }),
    )
    expect(first.already_confirmed).toBe(false)
    const second = await call<{ confirmed: boolean; already_confirmed: boolean }>(
      confirmHandler,
      ev({ params: { instanceId: inst }, session: sess(aliceId, ALICE) }),
    )
    expect(second).toMatchObject({ confirmed: true, already_confirmed: true })
  })

  it('an unknown instance → 404', async () => {
    await expect(
      call(
        confirmHandler,
        ev({
          params: { instanceId: '00000000-0000-4000-8000-0000000404ff' },
          session: sess(aliceId, ALICE),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

// ── 5. confirmed-surface eligibility ───────────────────────────────────────────

describe('confirm → spend appears on the normal (confirmed) me/instances surface', () => {
  it('after confirm the device + its spend show in the real teammate me/instances', async () => {
    const inst = await enrollProvisional(ALICE, 'surface-dev')
    const shadow = await shadowTeammateOf(inst)
    await seedSpend(inst, shadow, '4.000000')

    // Before confirm: NOT on Alice's owner-scoped surface (owned by the shadow).
    const before = await call<{ instances: { instance_id: string }[] }>(
      meInstances,
      ev({ session: sess(aliceId, ALICE) }),
    )
    expect(before.instances.some((i) => i.instance_id === inst)).toBe(false)

    await call(confirmHandler, ev({ params: { instanceId: inst }, session: sess(aliceId, ALICE) }))

    // After confirm: present, with its spend (owner-scoped by teammate_id).
    const after = await call<{ instances: { instance_id: string; spend_usd_mtd: string }[] }>(
      meInstances,
      ev({ session: sess(aliceId, ALICE) }),
    )
    const row = after.instances.find((i) => i.instance_id === inst)
    expect(row).toBeTruthy()
    expect(Number(row!.spend_usd_mtd)).toBeGreaterThanOrEqual(4)
  })
})

/*
 * Cap enforcement on the confirm transition.
 *
 * Confirmation is the third door into the confirmed population. The other two
 * count and refuse; this one used to do neither, so both caps were bypassable
 * by routing devices through the unauthenticated enrol door and then confirming
 * them. These tests drive the real handlers end to end, so they fail if the
 * locks or the counts are removed from confirm-instance.ts.
 */
describe('confirm — cap enforcement', () => {
  it('refuses to confirm past the per-teammate cap, and says how to recover', async () => {
    const prior = process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE
    // Relative to what Alice already holds: earlier tests in this file confirm
    // devices of hers, so an absolute cap would refuse the setup rather than
    // the case under test.
    const seedRows = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM instance_attestation
       WHERE teammate_id = ${aliceId}::uuid AND ts_actual_end IS NULL AND ts_purged IS NULL`
    const seed = Number(seedRows[0]!.n)
    process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE = String(seed + 2)
    try {
      const ids: string[] = []
      for (let i = 0; i < 3; i++) {
        ids.push(await enrollProvisional(ALICE, `cap-teammate-device-${i}`))
      }
      // The first two fit under the cap of 2.
      for (const id of ids.slice(0, 2)) {
        await call(
          confirmHandler,
          ev({ params: { instanceId: id }, session: sess(aliceId, ALICE) }),
        )
      }
      // The third is the one the cap exists to stop. Before this fix it
      // succeeded, and Alice ended up with three live devices under a cap of two.
      await expect(
        call(
          confirmHandler,
          ev({ params: { instanceId: ids[2]! }, session: sess(aliceId, ALICE) }),
        ),
      ).rejects.toMatchObject({ statusCode: 429 })

      // The refusal must be observable in the data, not just the status code.
      const live = await t.client<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM instance_attestation
         WHERE teammate_id = ${aliceId}::uuid AND ts_actual_end IS NULL AND ts_purged IS NULL`
      expect(Number(live[0]!.n)).toBe(seed + 2)

      // And the refused instance must be left untouched, not half-merged.
      const still = await t.client<{ identity_state: string }[]>`
        SELECT identity_state FROM instance_attestation WHERE instance_id = ${ids[2]!}::uuid`
      expect(still[0]!.identity_state).toBe('provisional')
    } finally {
      if (prior === undefined) delete process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE
      else process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE = prior
    }
  })

  it('refuses to confirm past the global confirmed cap', async () => {
    const prior = process.env.MAX_LIVE_EMIT_INSTANCES
    // Count what is already confirmed so the cap is set relative to it; earlier
    // tests in this file confirm instances of their own.
    const seed = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM instance_attestation
       WHERE identity_state = 'confirmed' AND ts_actual_end IS NULL AND ts_purged IS NULL`
    process.env.MAX_LIVE_EMIT_INSTANCES = String(Number(seed[0]!.n))
    try {
      const id = await enrollProvisional(BOB, 'cap-global-device')
      await expect(
        call(confirmHandler, ev({ params: { instanceId: id }, session: sess(bobId, BOB) })),
      ).rejects.toMatchObject({ statusCode: 429 })
      const still = await t.client<{ identity_state: string }[]>`
        SELECT identity_state FROM instance_attestation WHERE instance_id = ${id}::uuid`
      expect(still[0]!.identity_state).toBe('provisional')
    } finally {
      if (prior === undefined) delete process.env.MAX_LIVE_EMIT_INSTANCES
      else process.env.MAX_LIVE_EMIT_INSTANCES = prior
    }
  })

  it('still lets an already-confirmed device re-confirm at the cap', async () => {
    // The cap must gate the TRANSITION, not the endpoint. A no-op re-confirm
    // adds no row, so refusing it would break idempotency for anyone sitting
    // exactly at their limit -- which is precisely who retries.
    const id = await enrollProvisional(ALICE, 'cap-idempotent-device')
    await call(confirmHandler, ev({ params: { instanceId: id }, session: sess(aliceId, ALICE) }))

    const live = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM instance_attestation
       WHERE teammate_id = ${aliceId}::uuid AND ts_actual_end IS NULL AND ts_purged IS NULL`
    const prior = process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE
    process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE = live[0]!.n
    try {
      const again = await call<{ already_confirmed: boolean }>(
        confirmHandler,
        ev({ params: { instanceId: id }, session: sess(aliceId, ALICE) }),
      )
      expect(again.already_confirmed).toBe(true)
    } finally {
      if (prior === undefined) delete process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE
      else process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE = prior
    }
  })
})
