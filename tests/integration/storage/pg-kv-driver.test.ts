// @vitest-environment node
/*
 * pgKvDriver — the Postgres-backed unstorage driver behind `useStorage('oidc')`.
 *
 * This is the store nuxt-oidc-auth keeps every signed-in session in, so the
 * contract is exercised against a REAL Postgres through a REAL unstorage
 * instance (createStorage + mount) rather than by calling the driver's methods
 * directly: what matters is that unstorage's own serialisation, key handling and
 * prefix semantics work through it, not that our functions return what we think.
 *
 * The behaviours that matter operationally:
 *   - a value written by one "replica" is readable by another (the whole point)
 *   - it survives a driver instance being thrown away and rebuilt (a deploy)
 *   - expiry is enforced on READ, so correctness never waits on the sweep
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createStorage } from 'unstorage'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import pgKvDriver, { sweepExpiredKv } from '../../../server/storage/pg-kv-driver'

let t: TestDb

const storageFor = (mount = 'oidc', opts: Record<string, unknown> = {}) =>
  createStorage({ driver: pgKvDriver({ mount, ...opts }) })

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM kv_store`
})

describe('pgKvDriver — unstorage contract', () => {
  it('round-trips an object through unstorage serialisation', async () => {
    const s = storageFor()
    const session = { id: 'abc', exp: 1900000000, refreshToken: 'ciphertext', claims: { oid: 'o-1' } }
    await s.setItem('session-1', session)

    expect(await s.getItem('session-1')).toEqual(session)
    expect(await s.hasItem('session-1')).toBe(true)
    expect(await s.hasItem('nope')).toBe(false)
  })

  it('removes and clears', async () => {
    const s = storageFor()
    await s.setItem('a', { v: 1 })
    await s.setItem('b', { v: 2 })
    await s.removeItem('a')
    expect(await s.hasItem('a')).toBe(false)
    expect(await s.hasItem('b')).toBe(true)

    await s.clear()
    expect(await s.getKeys()).toEqual([])
  })

  it('lists keys, and scopes them by prefix', async () => {
    const s = storageFor()
    await s.setItem('users:1', { v: 1 })
    await s.setItem('users:2', { v: 2 })
    await s.setItem('other:1', { v: 3 })

    expect((await s.getKeys()).sort()).toEqual(['other:1', 'users:1', 'users:2'])
    expect((await s.getKeys('users')).sort()).toEqual(['users:1', 'users:2'])
  })

  it('does not let a namespace containing LIKE wildcards widen a CLEAR', async () => {
    const s = storageFor()
    await s.setItem('a%b:1', { v: 1 })
    await s.setItem('axxb:1', { v: 2 })

    // Driven at the DRIVER interface, not through createStorage, on purpose.
    // unstorage re-filters the keys a driver returns, so an over-matching
    // getKeys is invisible from the façade; and `storage.clear(base)` only
    // dispatches to mounts BELOW that base, so a root-mounted driver never sees
    // a sub-base through it at all. `clear(base)` is nonetheless part of the
    // contract we publish to unstorage, it DELETES, and nothing downstream
    // filters a delete — so it is tested where it is actually reachable.
    const driver = pgKvDriver({ mount: 'oidc' })
    await driver.clear!('a%b:', {})

    expect(await s.hasItem('a%b:1')).toBe(false)
    expect(await s.hasItem('axxb:1')).toBe(true)
  })

  it('keeps mounts from colliding on the same table', async () => {
    const oidc = storageFor('oidc')
    const other = storageFor('other')
    await oidc.setItem('same-key', { who: 'oidc' })
    await other.setItem('same-key', { who: 'other' })

    expect(await oidc.getItem('same-key')).toEqual({ who: 'oidc' })
    expect(await other.getItem('same-key')).toEqual({ who: 'other' })
  })
})

describe('pgKvDriver — why it exists', () => {
  it('a session written by one replica is readable by another', async () => {
    // Two independent driver instances = two Nitro processes. With the
    // in-memory default this is exactly the read that returns null and bounces
    // the user to /login.
    const replicaA = storageFor()
    const replicaB = storageFor()
    await replicaA.setItem('session-x', { id: 'x' })
    expect(await replicaB.getItem('session-x')).toEqual({ id: 'x' })
  })

  it('a session survives the store being rebuilt (a deploy)', async () => {
    const before = storageFor()
    await before.setItem('session-y', { id: 'y' })
    await before.dispose()

    const after = storageFor()
    expect(await after.getItem('session-y')).toEqual({ id: 'y' })
  })
})

describe('pgKvDriver — expiry', () => {
  it('treats an expired row as absent WITHOUT waiting for the sweep', async () => {
    const s = storageFor('oidc', { ttlSeconds: 1 })
    await s.setItem('short', { v: 1 })
    // Expire it in the DB rather than sleeping — the read path is what is
    // under test, and a test that sleeps is a test that flakes.
    await t.client`UPDATE kv_store SET expires_at = now() - interval '1 second'`

    expect(await s.getItem('short')).toBeNull()
    expect(await s.hasItem('short')).toBe(false)
    expect(await s.getKeys()).toEqual([])
    // Still physically present: correctness came from the read, not the sweep.
    //
    // This assertion is only deterministic because a freshly built driver seeds
    // `lastSweptAt` to construction time, so the write above does NOT fire an
    // opportunistic sweep. Seeding it to 0 instead makes the first write of every
    // process sweep, and that unawaited DELETE then races the UPDATE above —
    // green when the machine is idle, red under a loaded full-suite run. It
    // failed exactly that way before the seed was fixed; do not reintroduce it.
    const [row] = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM kv_store`
    expect(row!.n).toBe('1')
  })

  it('sweeps expired rows and leaves live ones alone', async () => {
    const s = storageFor()
    await s.setItem('live', { v: 1 })
    await s.setItem('dead', { v: 2 })
    await t.client`UPDATE kv_store SET expires_at = now() - interval '1 second' WHERE key = 'dead'`

    expect(await sweepExpiredKv('oidc')).toBe(1)
    expect((await s.getKeys()).sort()).toEqual(['live'])
  })

  it('never expires a row written with ttlSeconds = 0', async () => {
    const s = storageFor('oidc', { ttlSeconds: 0 })
    await s.setItem('forever', { v: 1 })
    const [row] = await t.client<{ expires_at: Date | null }[]>`
      SELECT expires_at FROM kv_store WHERE key = 'forever'`
    expect(row!.expires_at).toBeNull()
    expect(await sweepExpiredKv('oidc')).toBe(0)
  })
})
