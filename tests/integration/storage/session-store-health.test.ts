// @vitest-environment node
/*
 * getSessionStoreHealth — the in-product answer to "is the durable session
 * store actually live?".
 *
 * It exists because the failure it reports on is invisible everywhere else: an
 * unmounted driver leaves the app building, booting and serving normally while
 * silently keeping sessions per-replica and in-memory. On a deployed
 * environment kv_store sits behind a private endpoint, so an admin cannot go
 * look — which makes THIS the surface that has to be right.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import pgKvDriver from '../../../server/storage/pg-kv-driver'
import {
  OIDC_STORAGE_MOUNT,
  OIDC_STORE_PROBE_PREFIX,
} from '../../../server/storage/mount-oidc-session-store'
import {
  getSessionStoreHealth,
  type StorageLike,
} from '../../../server/utils/session-store-health'

let t: TestDb

/** A storage with the PG driver mounted where the real plugin mounts it. */
function durableStorage(): StorageLike {
  const storage = createStorage()
  storage.mount(OIDC_STORAGE_MOUNT, pgKvDriver({ mount: OIDC_STORAGE_MOUNT }))
  return storage as unknown as StorageLike
}

/** The silent-failure case: nothing mounted, so `oidc:` falls to the in-memory root. */
function inMemoryStorage(): StorageLike {
  return createStorage({ driver: memoryDriver() }) as unknown as StorageLike
}

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

describe('getSessionStoreHealth', () => {
  it('reports a live Postgres-backed store as durable and reachable', async () => {
    const health = await getSessionStoreHealth(durableStorage())

    expect(health.driver).toBe('pg-kv')
    expect(health.durable).toBe(true)
    expect(health.reachable).toBe(true)
    expect(health.error).toBeNull()
  })

  it('calls out an in-memory fallback rather than reporting it healthy', async () => {
    // The whole point: this configuration works perfectly in every other
    // respect, which is exactly why it needs to be named here.
    const health = await getSessionStoreHealth(inMemoryStorage())

    expect(health.durable).toBe(false)
    expect(health.driver).not.toBe('pg-kv')
    // Reachable-but-not-durable is the dangerous shape — the round trip passes
    // against memory, so `reachable` alone must never be read as "fine".
    expect(health.reachable).toBe(true)
  })

  it('counts sessions and boot probes separately', async () => {
    const storage = durableStorage()
    await storage.setItem(`${OIDC_STORAGE_MOUNT}:session-a`, 'x')
    await storage.setItem(`${OIDC_STORAGE_MOUNT}:session-b`, 'y')
    await storage.setItem(`${OIDC_STORAGE_MOUNT}:${OIDC_STORE_PROBE_PREFIX}:r1`, 'boot')

    const health = await getSessionStoreHealth(storage)

    // A fleet of boot probes must never read as session traffic.
    expect(health.sessions).toBe(2)
    expect(health.probes).toBe(1)
    expect(health.newestSessionAt).not.toBeNull()
  })

  it('classifies by a LITERAL prefix, not a LIKE pattern', async () => {
    const storage = durableStorage()
    // The probe prefix is '__tokenscope__:boot-probe'. Under LIKE, '_' is a
    // single-character wildcard, so this session key matches that pattern and
    // would be miscounted as a boot probe — understating the session count the
    // card exists to report. Confirmed against Postgres before fixing it.
    await storage.setItem(`${OIDC_STORAGE_MOUNT}:XXtokenscopeXX:boot-probe:1`, 'a real session')

    const health = await getSessionStoreHealth(storage)

    expect(health.sessions).toBe(1)
    expect(health.probes).toBe(0)
  })

  it('leaves nothing behind: its own probe row is cleaned up', async () => {
    const storage = durableStorage()
    await getSessionStoreHealth(storage)

    const [row] = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM kv_store`
    expect(row!.n).toBe('0')
  })

  it('ignores expired rows when counting', async () => {
    const storage = durableStorage()
    await storage.setItem(`${OIDC_STORAGE_MOUNT}:stale`, 'x')
    await t.client`UPDATE kv_store SET expires_at = now() - interval '1 second'`

    expect((await getSessionStoreHealth(storage)).sessions).toBe(0)
  })

  it('degrades instead of throwing when storage is unavailable', async () => {
    // Nitro's useStorage() does not exist when a handler is invoked directly, as
    // the admin integration tests do. This must be a reported state, not a 500
    // that takes the whole settings page down with it.
    const health = await getSessionStoreHealth(null)
    expect(health.durable).toBe(false)
    expect(health.error).toContain('unavailable')
  })

  it('never throws when kv_store itself is missing - that IS the finding', async () => {
    const storage = durableStorage()
    await t.client`ALTER TABLE kv_store RENAME TO kv_store_hidden`
    try {
      const health = await getSessionStoreHealth(storage)
      expect(health.reachable).toBe(false)
      // 42P01 undefined_table means "migration 0097 never ran" — the single most
      // likely real cause, and useless if it arrives as a 500.
      expect(health.error).toBeTruthy()
    } finally {
      await t.client`ALTER TABLE kv_store_hidden RENAME TO kv_store`
    }
  })

  it('uses a unique probe key so concurrent loads cannot fail each other', async () => {
    const storage = durableStorage()
    const [a, b, c] = await Promise.all([
      getSessionStoreHealth(storage),
      getSessionStoreHealth(storage),
      getSessionStoreHealth(storage),
    ])
    // With a shared key these overwrite each other's stamp and report the store
    // unreachable while it is perfectly healthy.
    expect([a.reachable, b.reachable, c.reachable]).toEqual([true, true, true])
  })

  it('surfaces WHY a round trip failed as a specific reason code, never the raw driver message (S8 redaction)', async () => {
    // A realistic postgres-js PostgresError: SQLSTATE 42P01 (undefined_table)
    // on the message "migration 0097 never ran" would actually produce, PLUS
    // topology detail (host/port/database/user) the way a real driver error
    // carries it — modelled on redact-probe-error.ts's own examples.
    const RAW_MESSAGE =
      'relation "kv_store" does not exist on host db-prod-01.internal:5432 (database "tokenscope_prod", user "app_svc")'
    const broken: StorageLike = {
      getMount: () => ({ driver: { name: 'pg-kv' } }),
      setItem: () => Promise.reject(Object.assign(new Error(RAW_MESSAGE), { code: '42P01' })),
      getItem: () => Promise.resolve(null),
      removeItem: () => Promise.resolve(),
    }

    const health = await getSessionStoreHealth(broken)

    expect(health.reachable).toBe(false)
    // A specific, informative REASON CODE (S8 — server/utils/redact-probe-error.ts)
    // — "migration 0097 never ran" is diagnosable from this alone, distinct
    // from e.g. 'connect-refused' ("check DATABASE_URL").
    expect(health.error).toBe('relation-missing')
    expect(health.correlationId).toBeTruthy() // ties back to the full-fidelity server log line
    // The redacted output must carry NONE of the raw driver message's
    // topology — that's the property S8 added: never interpolate err.message
    // (or any fragment of it) into what the caller receives.
    expect(health.error).not.toContain('db-prod-01')
    expect(health.error).not.toContain('5432')
    expect(health.error).not.toContain('tokenscope_prod')
    expect(health.error).not.toContain('app_svc')
    expect(health.error).not.toContain('kv_store')
  })
})
