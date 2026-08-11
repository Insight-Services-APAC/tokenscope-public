/*
 * pgKvDriver — an unstorage driver backed by the app's own Postgres.
 *
 * It exists so `useStorage('oidc')` (nuxt-oidc-auth's persistent session store)
 * is SHARED and DURABLE instead of per-replica and in-memory. The in-memory
 * default logs every user out on every deploy, and produces an unrecoverable
 * /login loop the moment the container app runs more than one replica: the
 * session created on replica A does not exist on replica B. See mig 0097 for
 * the full incident note and for why this is Postgres rather than Redis.
 *
 * Contract notes (unstorage `Driver`):
 *   - `setItem` receives an ALREADY-STRINGIFIED value; storage is TEXT.
 *   - `getItem` returns the raw string; unstorage parses it back.
 *   - keys are mount-relative and colon-separated; `getKeys(base)`/`clear(base)`
 *     take a prefix, which maps to a `LIKE 'base%'` scan.
 *   - `flags.ttl` advertises that we honour a per-write ttl; callers that pass
 *     none (nuxt-oidc-auth does not) get the mount's default.
 *
 * Expiry is enforced on READ (an expired row is absent) so correctness never
 * depends on the sweep having run. The sweep only reclaims space.
 */
import { sql } from 'drizzle-orm'
import { defineDriver } from 'unstorage'
import { getDb } from '../db'
import { LIKE_ESCAPE, escapeLikeLiteral } from '../utils/sql-like'

/**
 * The driver's unstorage `name`. Exported because the mount assertion in
 * `mountOidcSessionStore` compares against it: the whole failure mode this
 * driver exists to prevent is a SILENT fallback to Nitro's in-memory default,
 * and a hardcoded string on either side of that comparison is one rename away
 * from an assertion that can never fire.
 */
export const PG_KV_DRIVER_NAME = 'pg-kv'

export interface PgKvOptions {
  /** Namespace for this mount's keys, so mounts sharing the table can't collide. */
  mount: string
  /**
   * Lifetime applied to writes that don't carry their own ttl. nuxt-oidc-auth
   * never passes one, so this is what actually bounds session rows. Default is
   * 30 days: comfortably longer than any real session, short enough that an
   * abandoned row is not immortal.
   */
  ttlSeconds?: number
  /** Minimum gap between opportunistic expiry sweeps, per process. */
  sweepIntervalMs?: number
}

/*
 * `base` from unstorage is a key PREFIX, not a SQL pattern, so LIKE's wildcards
 * have to be neutralised or a key containing % or _ would widen the scan.
 *
 * LIKE_ESCAPE / escapeLikeLiteral live in ../utils/sql-like — this driver used
 * to keep its own private copy of both; see that module's header for the
 * `ESCAPE '\'`-as-a-template-literal trap it exists to prevent. (Caught here
 * originally by the wildcard test; it is the same backslash-in-a-tagged-
 * template trap as backticks in sql``.)
 */
function likePrefix(base: string | undefined): string {
  return escapeLikeLiteral(base ?? '') + '%'
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30
const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60 * 1000

/**
 * Delete expired rows. Exported so a test can drive it directly rather than
 * waiting on the opportunistic trigger, and so an operator can call it.
 */
export async function sweepExpiredKv(mount: string): Promise<number> {
  const rows = await getDb().execute<{ key: string }>(sql`
    DELETE FROM kv_store
     WHERE mount = ${mount} AND expires_at IS NOT NULL AND expires_at <= now()
    RETURNING key
  `)
  return [...rows].length
}

export default defineDriver<PgKvOptions>((opts) => {
  const mount = opts.mount
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
  // Per-process, not per-row: an expiry sweep is housekeeping, and running one
  // on every write would put a DELETE in the path of every sign-in for no gain.
  //
  // Seeded to construction time, NOT 0. With 0, `now - lastSweptAt` is ~epoch
  // millis on the very first write, so every fresh driver swept on its first
  // write — putting that DELETE in the path of the first sign-in after each
  // deploy, which is precisely the cost the gate exists to avoid. A driver that
  // has just been built has no reason to assume there is garbage waiting: expiry
  // is enforced on READ, so nothing is incorrect until the sweep first runs.
  let lastSweptAt = Date.now()

  function maybeSweep(): void {
    const now = Date.now()
    if (now - lastSweptAt < sweepIntervalMs) return
    lastSweptAt = now
    // Deliberately not awaited: reclaiming space must never delay — or fail —
    // the session write that triggered it. Expiry itself is enforced on read.
    void sweepExpiredKv(mount).catch(() => {})
  }

  function expiryFor(ttl?: number): number | null {
    const seconds = ttl ?? ttlSeconds
    return seconds > 0 ? seconds : null
  }

  return {
    name: PG_KV_DRIVER_NAME,
    flags: { ttl: true },
    options: opts,

    async hasItem(key) {
      const rows = await getDb().execute<{ one: number }>(sql`
        SELECT 1 AS one FROM kv_store
         WHERE mount = ${mount} AND key = ${key}
           AND (expires_at IS NULL OR expires_at > now())
         LIMIT 1
      `)
      return [...rows].length > 0
    },

    async getItem(key) {
      const rows = await getDb().execute<{ value: string }>(sql`
        SELECT value FROM kv_store
         WHERE mount = ${mount} AND key = ${key}
           AND (expires_at IS NULL OR expires_at > now())
         LIMIT 1
      `)
      return [...rows][0]?.value ?? null
    },

    async setItem(key, value, topts) {
      const seconds = expiryFor(topts?.ttl as number | undefined)
      const expiresAt =
        seconds === null ? sql`NULL` : sql`now() + make_interval(secs => ${seconds})`
      await getDb().execute(sql`
        INSERT INTO kv_store (mount, key, value, expires_at, updated_at)
        VALUES (${mount}, ${key}, ${value}, ${expiresAt}, now())
        ON CONFLICT (mount, key) DO UPDATE
          SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = now()
      `)
      maybeSweep()
    },

    async removeItem(key) {
      await getDb().execute(sql`DELETE FROM kv_store WHERE mount = ${mount} AND key = ${key}`)
    },

    async getKeys(base) {
      const prefix = likePrefix(base)
      const rows = await getDb().execute<{ key: string }>(sql`
        SELECT key FROM kv_store
         WHERE mount = ${mount}
           AND (expires_at IS NULL OR expires_at > now())
           AND key LIKE ${prefix} ESCAPE ${LIKE_ESCAPE}
         ORDER BY key
      `)
      return [...rows].map((r) => r.key)
    },

    async clear(base) {
      const prefix = likePrefix(base)
      await getDb().execute(sql`
        DELETE FROM kv_store
         WHERE mount = ${mount} AND key LIKE ${prefix} ESCAPE ${LIKE_ESCAPE}
      `)
    },
  }
})
