// @vitest-environment node
/*
 * Do the instance caps actually hold when callers race?
 *
 * The existing cap tests all provision SEQUENTIALLY, which proves the arithmetic
 * but not the concurrency control — and concurrency is the only thing the
 * advisory locks exist for. A sequential test passes with every lock removed.
 *
 * The specific failure these guard is a lost update: each transaction reads the
 * pre-insert count, all see a number below the cap, and all insert. A
 * per-principal lock cannot prevent it for the global cap, because concurrent
 * callers with DIFFERENT principals hold DIFFERENT locks and never contend —
 * and on the enrol path the attacker chooses the principal, so that is the
 * caller the backstop most needs to stop.
 *
 * Real parallel transactions on a real PG (AGENTS.md: never mock Drizzle).
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { locateOrCreateInstance } from '../../../server/auth/emit-provision'
import { locateOrCreateProvisionalInstance } from '../../../server/auth/enroll-provision'

let t: TestDb
let regionId: string
let ouId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'cap-conc-test-padded-to-thirty-two-chars!'
  process.env.NUXT_HMAC_SESSION_KEY = 'cap-conc-test-hmac-key-padded-well-beyond-32-chars'
  const [r] = await t.db.insert(schema.region).values({ code: 'cc', displayName: 'CC' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'cc.svc',
      code: 'cc-svc',
      displayName: 'CC Svc',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  ouId = ou!.id
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

afterEach(async () => {
  delete process.env.MAX_LIVE_EMIT_INSTANCES
  delete process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE
  delete process.env.MAX_PROVISIONAL_INSTANCES
  delete process.env.MAX_PROVISIONAL_INSTANCES_PER_EMAIL
  await t.client`DELETE FROM instance_attestation`
})

async function freshTeammate() {
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `cc-${randomUUID()}`,
      email: `cc-${randomUUID()}@example.com`,
      displayName: 'CC',
      role: 'developer',
      regionId,
      orgUnitId: ouId,
    })
    .returning()
  return {
    teammateId: tm!.id,
    principalOid: tm!.entraOid,
    email: tm!.email,
    regionId,
    orgUnitId: ouId,
  }
}

function liveConfirmed(): Promise<number> {
  return t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM instance_attestation
       WHERE identity_state = 'confirmed' AND ts_actual_end IS NULL AND ts_purged IS NULL`.then(
    (rows) => Number(rows[0]!.n),
  )
}

function liveProvisional(): Promise<number> {
  return t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM instance_attestation
       WHERE identity_state = 'provisional'`.then((rows) => Number(rows[0]!.n))
}

describe('global instance caps under concurrency', () => {
  it('the confirmed global cap holds when DISTINCT teammates race past it', async () => {
    // Distinct teammates is the load-bearing detail: they take distinct
    // per-principal locks, so only a lock on a key that is actually global can
    // serialise the whole-table count.
    process.env.MAX_LIVE_EMIT_INSTANCES = '3'
    process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE = '100'
    const teammates = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => freshTeammate()))

    const results = await Promise.all(
      teammates.map((tm) =>
        t.db.transaction((tx) => locateOrCreateInstance(tx, tm, undefined, 'claude-code')),
      ),
    )

    const created = results.filter((r) => !('capExceeded' in r)).length
    expect(created).toBe(3)
    expect(await liveConfirmed()).toBe(3)
  })

  it('the provisional global cap holds when DISTINCT emails race past it', async () => {
    // The enrol door is unauthenticated and the attacker picks claimed_email,
    // so "different principal every time" is the expected attack shape, not an
    // edge case.
    process.env.MAX_PROVISIONAL_INSTANCES = '3'
    process.env.MAX_PROVISIONAL_INSTANCES_PER_EMAIL = '100'
    const emails = [1, 2, 3, 4, 5, 6, 7, 8].map(() => `race-${randomUUID()}@example.com`)

    const results = await Promise.all(
      emails.map((email) =>
        t.db.transaction((tx) => locateOrCreateProvisionalInstance(tx, email, `dev-${email}`)),
      ),
    )

    const created = results.filter((r) => !('capExceeded' in r)).length
    expect(created).toBe(3)
    expect(await liveProvisional()).toBe(3)
  })

  it('provisional enrolments do NOT consume the confirmed global cap', async () => {
    // The confirmed cap's own docstring says it is deliberately not folded in
    // with the provisional population. An unfiltered COUNT(*) broke that: the
    // unauthenticated door could exhaust the authenticated one, disabling
    // self-provisioning deployment-wide for everyone.
    process.env.MAX_LIVE_EMIT_INSTANCES = '2'
    process.env.MAX_PROVISIONAL_INSTANCES = '100'
    process.env.MAX_PROVISIONAL_INSTANCES_PER_EMAIL = '100'

    for (let i = 0; i < 5; i++) {
      const res = await t.db.transaction((tx) =>
        locateOrCreateProvisionalInstance(tx, `flood-${i}@example.com`, `dev-flood-${i}`),
      )
      expect('capExceeded' in res).toBe(false)
    }
    expect(await liveProvisional()).toBe(5)

    // Authenticated provisioning must be entirely unaffected, right up to its
    // own cap of 2 — not blocked at 0 by the five provisional rows.
    const tm = await freshTeammate()
    process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE = '100'
    for (let i = 0; i < 2; i++) {
      const res = await t.db.transaction((tx) =>
        locateOrCreateInstance(tx, tm, undefined, 'claude-code'),
      )
      expect('capExceeded' in res).toBe(false)
    }
    expect(await liveConfirmed()).toBe(2)

    const overflow = await t.db.transaction((tx) =>
      locateOrCreateInstance(tx, tm, undefined, 'claude-code'),
    )
    expect('capExceeded' in overflow).toBe(true)
  })

  it('the two cap domains do not block each other', async () => {
    // The previous version of this test ran both creates concurrently and
    // asserted only that both finished. That passes with ONE shared key: a
    // shared key serialises them, and serialised work still finishes. It was
    // a false green, and its own comment conceded it pinned intent rather than
    // an observable.
    //
    // Hold the provisional domain's lock open on a separate connection, then
    // require the confirmed domain to complete WHILE it is held. With distinct
    // keys that succeeds immediately; with a shared key it blocks until the
    // holder commits, so the timeout below is the assertion.
    process.env.MAX_LIVE_EMIT_INSTANCES = '50'
    process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE = '50'
    process.env.MAX_PROVISIONAL_INSTANCES = '50'
    process.env.MAX_PROVISIONAL_INSTANCES_PER_EMAIL = '50'
    const tm = await freshTeammate()

    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    // Deliberately raw SQL rather than advisoryGlobalCapLock(): a helper that
    // computed the key wrongly would compute it wrongly here too, and the test
    // would agree with the bug. These literals are the contract.
    const holder = t.client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(3::int, 1::int)`
      await released
    })
    // Let the holder actually acquire before the contender starts.
    await new Promise((r) => setTimeout(r, 100))

    try {
      const contender = t.db.transaction((tx) =>
        locateOrCreateInstance(tx, tm, undefined, 'claude-code'),
      )
      const outcome = await Promise.race([
        contender.then(() => 'completed' as const),
        new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 3000)),
      ])
      expect(
        outcome,
        'the confirmed domain blocked behind the provisional lock: the two domains are sharing one key',
      ).toBe('completed')
      expect(await liveConfirmed()).toBe(1)
    } finally {
      release()
      await holder
    }

    // Control: the SAME domain must still serialise. Without this the test
    // above would also pass if the lock were removed altogether.
    let release2!: () => void
    const released2 = new Promise<void>((resolve) => {
      release2 = resolve
    })
    const holder2 = t.client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(3::int, 0::int)`
      await released2
    })
    await new Promise((r) => setTimeout(r, 100))
    // Held OUTSIDE the race so it can be awaited after the lock is released.
    // Racing a transaction against a timeout and walking away leaves it in
    // flight: it resumes the moment holder2 commits and inserts a row while
    // afterEach is running DELETE FROM instance_attestation, which is a
    // cross-test flake with no relationship to what this test asserts.
    const contender2 = t.db.transaction((tx) =>
      locateOrCreateInstance(tx, tm, undefined, 'claude-code'),
    )
    try {
      const blocked = await Promise.race([
        contender2.then(() => 'completed' as const),
        new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 1500)),
      ])
      expect(
        blocked,
        'the confirmed domain did NOT wait for its own lock: the create path is not taking it',
      ).toBe('blocked')
    } finally {
      release2()
      await holder2
      // Now it can proceed; settle it before the suite tears the table down.
      await contender2.catch(() => undefined)
    }
  })
})
