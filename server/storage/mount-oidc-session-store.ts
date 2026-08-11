/*
 * Mounting the durable session store onto the `oidc` storage key.
 *
 * This is the half of the fix that is testable WITHOUT a Nuxt build: it takes a
 * plain unstorage `Storage`, so an integration test can hand it a real one and
 * assert that `oidc:*` keys genuinely land in Postgres. The Nitro plugin
 * (server/plugins/oidc-session-store.ts) is then a three-line adapter that
 * passes Nitro's own `useStorage()` in.
 *
 * WHY THE SPLIT. The failure this whole change exists to prevent is SILENT: if
 * nothing mounts a driver on `oidc`, `useStorage('oidc')` quietly resolves to
 * Nitro's in-memory default and everything still builds, boots and serves — it
 * just loses every session on deploy and bounces users around a /login loop the
 * moment a second replica answers. A green build proves nothing here, so the
 * mount semantics are pinned by a test rather than by inspection.
 */
import { randomUUID } from 'node:crypto'
import type { Storage } from 'unstorage'
import { consola } from 'consola'
import pgKvDriver, { PG_KV_DRIVER_NAME } from './pg-kv-driver'

/**
 * The Nitro storage key nuxt-oidc-auth keeps persistent sessions under. The
 * module hardcodes `useStorage('oidc')` (and `useStorage('oidc:dev')` for its
 * dev-mode keypair), so this string is fixed by the dependency, not by us —
 * mounting at `oidc` covers both, because `oidc:dev:*` sits below it.
 */
export const OIDC_STORAGE_MOUNT = 'oidc'

/**
 * Mount the Postgres-backed KV driver on `oidc`, then assert the mount took.
 *
 * The assertion is deliberately a THROW, not a warning. A Nitro plugin that
 * throws aborts startup (nitropack's runNitroPlugins rethrows), so a broken
 * mount becomes a container that refuses to boot instead of one that boots
 * happily and silently drops sessions. It is also pure in-memory bookkeeping —
 * no I/O — so it cannot fail transiently and cannot crash-loop a replica over a
 * blip in Postgres. (Reaching Postgres is checked separately and
 * non-fatally — see `probeOidcSessionStore`.)
 *
 * What the assertion actually buys: it re-resolves a representative `oidc:` key
 * through unstorage's own mount lookup rather than trusting that `mount()` did
 * what its name suggests. That pins the KEY-ROUTING semantics we depend on — an
 * unstorage change to how mountpoints normalise would fail here, loudly, rather
 * than degrade to the in-memory root mount.
 */
export function mountOidcSessionStore(storage: Storage): void {
  storage.mount(OIDC_STORAGE_MOUNT, pgKvDriver({ mount: OIDC_STORAGE_MOUNT }))

  const resolved = storage.getMount(`${OIDC_STORAGE_MOUNT}:probe`).driver.name
  if (resolved !== PG_KV_DRIVER_NAME) {
    throw new Error(
      `[oidc-session-store] refusing to start: '${OIDC_STORAGE_MOUNT}' resolved to driver ` +
        `'${resolved}', expected '${PG_KV_DRIVER_NAME}'. Sessions would be per-replica and ` +
        `in-memory, which signs every user out on deploy and loops them at /login whenever ` +
        `more than one replica serves traffic.`,
    )
  }
}

/**
 * Key PREFIX for boot-probe rows. Namespaced so it can never collide with a
 * session id; each probe appends a uuid — see `probeOidcSessionStore` for why it
 * must not be a single shared key.
 */
export const OIDC_STORE_PROBE_PREFIX = '__tokenscope__:boot-probe'

/** Lifetime of the probe row — long enough to observe, short enough to be self-cleaning. */
const PROBE_TTL_SECONDS = 600

export interface OidcStoreProbeResult {
  ok: boolean
  error?: unknown
}

/**
 * Prove, at boot, that the mounted driver actually REACHES Postgres.
 *
 * `mountOidcSessionStore` proves the wiring; this proves the plumbing. It writes
 * a row, reads it back through the same storage façade, and reports whether the
 * round trip survived — the evidence that distinguishes "mounted on Postgres"
 * from "mounted on something that merely looks mounted". Reading back matters:
 * a driver that accepted the write and dropped it would pass a write-only check.
 *
 * The row is deliberately LEFT BEHIND (with a short ttl) so `SELECT * FROM
 * kv_store` answers "is the durable store live?" without driving a real Entra
 * sign-in — which is otherwise impossible to do off a deployed environment. Each
 * probe writes its OWN key, so a rolling deploy leaves one row per booted
 * replica rather than one row overall: strictly more useful to read, and bounded
 * by the ttl rather than by overwriting.
 *
 * Never throws: Postgres being briefly unreachable at boot must not crash-loop a
 * replica, and unlike the mount assertion this one CAN fail transiently. The
 * failure is returned rather than swallowed so the caller can log WHY — a probe
 * that reports a bare `false` sends whoever is debugging it back to square one.
 */
export async function probeOidcSessionStore(storage: Storage): Promise<OidcStoreProbeResult> {
  // UNIQUE per probe, deliberately. With one shared key, two replicas booting at
  // the same time race: A writes, B overwrites, A reads back B's stamp, and A
  // reports the store unreachable when it is perfectly fine. That is not a
  // theoretical window — simultaneous replica boots ARE a deploy, which is
  // exactly when someone is reading these logs to see whether this fix worked.
  //
  // Fixed by removing the collision rather than by tolerating it: accepting "some
  // other replica's well-formed stamp" as success would turn a false negative
  // into a possible false POSITIVE, reporting the store healthy off a row this
  // process never managed to write. For a probe whose whole job is catching a
  // broken store, that is the worse failure. A uuid keeps the read-back a strict
  // check on OUR OWN write, which is the property actually worth having.
  const key = `${OIDC_STORAGE_MOUNT}:${OIDC_STORE_PROBE_PREFIX}:${randomUUID()}`
  const stamp = `booted:${new Date().toISOString()}:pid=${process.pid}`
  try {
    await storage.setItem(key, stamp, { ttl: PROBE_TTL_SECONDS })
    // Read back through the façade rather than trusting the write: a driver that
    // accepted the write but stored it somewhere else would pass a write-only check.
    return { ok: (await storage.getItem(key)) === stamp }
  } catch (error) {
    return { ok: false, error }
  }
}

/** The logging surface used at boot — narrowed to what is called, so a test can pass a recorder. */
export interface OidcStoreLogger {
  info: (message: string) => void
  error: (message: string, detail?: unknown) => void
}

/**
 * Mount the store and report on it — everything the Nitro plugin does, in a form
 * that can be driven by a test against a real Postgres.
 *
 * DELIBERATELY NOT `async`. The mount has to happen SYNCHRONOUSLY, and its
 * failure has to propagate synchronously: nitropack neither awaits a plugin's
 * returned promise nor sees a rejected one, so an `async` version of this
 * function would turn the startup-aborting throw into an unhandled rejection and
 * the container would boot with in-memory sessions — the exact silent failure
 * this whole change exists to remove. Keeping it a plain function that returns
 * the probe's promise preserves both halves: throw now, log later.
 */
export function installOidcSessionStore(
  storage: Storage,
  log: OidcStoreLogger = consola,
): Promise<void> {
  mountOidcSessionStore(storage)

  return probeOidcSessionStore(storage).then(({ ok, error }) => {
    if (ok) {
      log.info(
        `[oidc-session-store] durable session store live: '${OIDC_STORAGE_MOUNT}' → Postgres (kv_store)`,
      )
      return
    }
    log.error(
      `[oidc-session-store] MOUNTED BUT UNREACHABLE: '${OIDC_STORAGE_MOUNT}' is bound to the ` +
        `Postgres driver, but a write/read round-trip against kv_store failed. Sessions will ` +
        `error rather than silently go in-memory; check DATABASE_URL and that migration 0097 ran.`,
      // The error object itself, NOT `.message`. Drizzle wraps the driver error,
      // so the diagnosis is in the CHAIN rather than the prose: `.cause` carries
      // the Postgres `code` — 42P01 (undefined_table → migration 0097 never ran)
      // vs 28P01 (bad credentials) vs a refused connection are three different
      // fixes — alongside the failing query and the stack. Flattening to
      // `.message` keeps the sentence and throws all of that away, which is the
      // opposite of what this particular log exists for. consola renders an
      // Error natively. Matches the raw-error convention already used for
      // background diagnostics (unaccounted-reconciliation.ts,
      // azure-monitor-reader.ts); the `.message` flattening elsewhere is on
      // request paths, which this is not.
      error,
    )
  })
}
