// @vitest-environment node
/*
 * Mounting the session store on `oidc`.
 *
 * The driver's own contract is covered by pg-kv-driver.test.ts. What is covered
 * HERE is the thing that actually broke: whether `useStorage('oidc')` — the call
 * nuxt-oidc-auth makes, verbatim — reaches Postgres or quietly reaches Nitro's
 * in-memory default.
 *
 * These tests drive the real unstorage `Storage` the plugin is handed at runtime,
 * with the SAME key shapes nuxt-oidc-auth uses, so the assertions are about mount
 * routing rather than about our own function's return value. They deliberately do
 * NOT stub unstorage: mount-point normalisation is precisely the semantics under
 * test, and a stub would assert our belief about it instead of the behaviour.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { PG_KV_DRIVER_NAME } from '../../../server/storage/pg-kv-driver'
import {
  mountOidcSessionStore,
  probeOidcSessionStore,
  installOidcSessionStore,
  OIDC_STORAGE_MOUNT,
  OIDC_STORE_PROBE_PREFIX,
  type OidcStoreLogger,
} from '../../../server/storage/mount-oidc-session-store'

let t: TestDb

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

/** A Nitro-shaped root storage: in-memory default, exactly as an unmounted app has. */
const nitroLikeStorage = () => createStorage({ driver: memoryDriver() })

const countRows = async (): Promise<number> => {
  const [row] = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM kv_store`
  return Number(row!.n)
}

describe('mountOidcSessionStore', () => {
  it('routes the exact key nuxt-oidc-auth writes into Postgres, not memory', async () => {
    const storage = nitroLikeStorage()
    mountOidcSessionStore(storage)

    // Verbatim shape from nuxt-oidc-auth: useStorage('oidc').setItem(sessionId, session).
    const sessionId = '3f1c6d8e-0f5a-4a1e-9b2c-7d4e5f6a8b90'
    const session = { userName: 'a@b.com', exp: 1900000000, refreshToken: 'ciphertext' }
    await storage.setItem(`${OIDC_STORAGE_MOUNT}:${sessionId}`, session)

    // The point of the whole change: the row is in the DATABASE.
    const rows = await t.client<{ mount: string; key: string }[]>`
      SELECT mount, key FROM kv_store`
    expect(rows).toEqual([{ mount: OIDC_STORAGE_MOUNT, key: sessionId }])
    expect(await storage.getItem(`${OIDC_STORAGE_MOUNT}:${sessionId}`)).toEqual(session)
  })

  it('leaves storage OUTSIDE the oidc mount on the in-memory default', async () => {
    const storage = nitroLikeStorage()
    mountOidcSessionStore(storage)

    // Mounting must not hijack the root: unrelated Nitro storage (cache, etc.)
    // still belongs to whatever Nitro configured for it.
    await storage.setItem('cache:some-key', { v: 1 })

    expect(await countRows()).toBe(0)
    expect(await storage.getItem('cache:some-key')).toEqual({ v: 1 })
  })

  it("covers nuxt-oidc-auth's 'oidc:dev' keypair store, which sits below the mount", async () => {
    const storage = nitroLikeStorage()
    mountOidcSessionStore(storage)

    // useStorage('oidc:dev').setItem('keypair', ...) → 'oidc:dev:keypair'.
    await storage.setItem(`${OIDC_STORAGE_MOUNT}:dev:keypair`, { privateKey: 'x' })

    const [row] = await t.client<{ mount: string; key: string }[]>`
      SELECT mount, key FROM kv_store`
    expect(row).toEqual({ mount: OIDC_STORAGE_MOUNT, key: 'dev:keypair' })
  })

  it('binds the mount to the pg driver, so a silent memory fallback is detectable', () => {
    const storage = nitroLikeStorage()
    expect(storage.getMount(`${OIDC_STORAGE_MOUNT}:anything`).driver.name).not.toBe(
      PG_KV_DRIVER_NAME,
    )

    mountOidcSessionStore(storage)

    expect(storage.getMount(`${OIDC_STORAGE_MOUNT}:anything`).driver.name).toBe(PG_KV_DRIVER_NAME)
  })

  it('a session written by one replica is readable by another, through the mount', async () => {
    // Two independently-mounted storages = two Nitro processes. This is the read
    // that returned null and produced the /login loop.
    const replicaA = nitroLikeStorage()
    const replicaB = nitroLikeStorage()
    mountOidcSessionStore(replicaA)
    mountOidcSessionStore(replicaB)

    await replicaA.setItem(`${OIDC_STORAGE_MOUNT}:shared-session`, { userName: 'a@b.com' })

    expect(await replicaB.getItem(`${OIDC_STORAGE_MOUNT}:shared-session`)).toEqual({
      userName: 'a@b.com',
    })
  })
})

describe('probeOidcSessionStore', () => {
  it('round-trips through Postgres and leaves the evidence row behind', async () => {
    const storage = nitroLikeStorage()
    mountOidcSessionStore(storage)

    expect(await probeOidcSessionStore(storage)).toEqual({ ok: true })

    // Left behind on purpose: `SELECT * FROM kv_store` is then a sufficient
    // answer to "is the durable store live on this replica?".
    // Asserted in SQL rather than by inspecting the driver's JS return type:
    // what matters is that the row carries a FUTURE expiry, so a probe row can
    // neither read as already-expired nor accumulate one immortal row per boot.
    const [row] = await t.client<{ key: string; live: boolean; bounded: boolean }[]>`
      SELECT key,
             expires_at > now()                        AS live,
             expires_at <= now() + interval '1 hour'   AS bounded
        FROM kv_store WHERE mount = ${OIDC_STORAGE_MOUNT}`
    expect(row!.key).toContain(OIDC_STORE_PROBE_PREFIX)
    expect(row!.live).toBe(true)
    expect(row!.bounded).toBe(true)
  })

  it('two replicas probing CONCURRENTLY both succeed and do not clobber each other', async () => {
    // A rolling deploy boots replicas at the same time — the exact situation this
    // whole PR is about. With one shared probe key, replica A reads back B's
    // stamp and reports the store unreachable while Postgres is perfectly fine:
    // a false alarm precisely when someone is watching the logs to see whether
    // the durable store came up.
    const replicaA = nitroLikeStorage()
    const replicaB = nitroLikeStorage()
    mountOidcSessionStore(replicaA)
    mountOidcSessionStore(replicaB)

    const [a, b] = await Promise.all([
      probeOidcSessionStore(replicaA),
      probeOidcSessionStore(replicaB),
    ])

    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true })
    // One row EACH, so neither overwrote the other's evidence.
    expect(await countRows()).toBe(2)
  })

  it('reports failure with a reason instead of throwing when Postgres is unreachable', async () => {
    const storage = nitroLikeStorage()
    mountOidcSessionStore(storage)
    const good = process.env.DATABASE_URL

    // A boot-time DB outage must not crash-loop the replica.
    await t.client`DROP TABLE kv_store`
    try {
      const result = await probeOidcSessionStore(storage)
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
    } finally {
      process.env.DATABASE_URL = good
      await t.client`
        CREATE TABLE kv_store (
          mount TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
          expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT kv_store_pkey PRIMARY KEY (mount, key))`
    }
  })
})

describe('installOidcSessionStore — what the Nitro plugin actually runs', () => {
  const recorder = () => {
    const infos: string[] = []
    const errors: string[] = []
    // The detail arg is captured, not dropped: it is the only thing that tells
    // an operator WHY the store is unreachable, so it is worth asserting.
    const details: unknown[] = []
    const log: OidcStoreLogger = {
      info: (m) => infos.push(m),
      error: (m, detail) => {
        errors.push(m)
        details.push(detail)
      },
    }
    return { log, infos, errors, details }
  }

  it('mounts, probes, and announces the store as live', async () => {
    const storage = nitroLikeStorage()
    const { log, infos, errors } = recorder()

    await installOidcSessionStore(storage, log)

    expect(storage.getMount(`${OIDC_STORAGE_MOUNT}:x`).driver.name).toBe(PG_KV_DRIVER_NAME)
    expect(await countRows()).toBe(1)
    expect(errors).toEqual([])
    expect(infos.join()).toContain('durable session store live')
  })

  it('mounts SYNCHRONOUSLY, so the throw can abort Nitro startup', async () => {
    // The property under test is the timing, not just the failure. nitropack
    // neither awaits a plugin's promise nor observes a rejected one, so if this
    // ever became `async` the startup-aborting throw would degrade into an
    // unhandled rejection and the replica would serve in-memory sessions.
    const storage = nitroLikeStorage()

    // Held, not awaited yet: the assertion below has to run BEFORE the probe
    // settles, because what is being pinned is that the mount is already in
    // place when the call RETURNS — not merely once its promise resolves.
    const settled = installOidcSessionStore(storage, recorder().log)

    expect(storage.getMount(`${OIDC_STORAGE_MOUNT}:x`).driver.name).toBe(PG_KV_DRIVER_NAME)

    // Then await it before the test ends. Letting the probe run on past the end
    // of the test would leave its write racing the next test's `beforeEach`
    // truncate — the same unawaited-work-lands-later bug this branch just fixed
    // in the driver's sweep, and it would make the suite order-dependent.
    await settled
  })

  it('reports a loud error instead of rejecting when the store is unreachable', async () => {
    const storage = nitroLikeStorage()
    const { log, infos, errors, details } = recorder()
    await t.client`DROP TABLE kv_store`
    try {
      // Must RESOLVE, not reject: the plugin does not await this, so a rejection
      // would surface as an unhandled rejection rather than a diagnosable log.
      await expect(installOidcSessionStore(storage, log)).resolves.toBeUndefined()

      expect(infos).toEqual([])
      expect(errors.join()).toContain('MOUNTED BUT UNREACHABLE')
      // The underlying cause has to reach the log, not just the headline: a
      // "store is unreachable" line with no reason is the start of a long night.
      // Asserted as the Error ITSELF, not its text. Drizzle wraps the driver
      // error, so the diagnosis lives on `.cause`: flattening the outer error to
      // `.message` would still satisfy a substring check while discarding the
      // whole chain — the Postgres `code` that distinguishes a missing migration
      // (42P01) from bad credentials (28P01) from a refused connection, plus the
      // failing query and the stack.
      const detail = details[0] as Error & { cause?: { code?: string } }
      expect(detail).toBeInstanceOf(Error)
      expect(detail.cause?.code).toBe('42P01') // undefined_table → migration never ran
      expect(String(detail)).toContain('kv_store')
    } finally {
      await t.client`
        CREATE TABLE kv_store (
          mount TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
          expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT kv_store_pkey PRIMARY KEY (mount, key))`
    }
  })
})
