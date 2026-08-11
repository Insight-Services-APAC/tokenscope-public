/*
 * Session-store health — "is the durable session store actually live?", as an
 * answer an admin can read in the product.
 *
 * WHY THIS EXISTS. The store this reports on (mig 0097 / kv_store, mounted on
 * `oidc`) fixes a failure that is INVISIBLE from the outside: if nothing mounts
 * the Postgres driver, Nitro silently falls back to per-replica in-memory
 * sessions, the app builds and boots and serves exactly as before, and the only
 * symptom is that deploys sign everyone out and users start looping at /login
 * once a second replica answers. The boot probe writes that evidence into
 * kv_store — but on a deployed environment kv_store sits behind a private
 * endpoint, so reading it means being able to reach Postgres, which the people
 * who need the answer generally cannot. A log line only helps whoever is already
 * tailing logs.
 *
 * So the health of the store is reported through the app itself: mounted driver
 * (is the wiring right), a live round-trip (is the plumbing right), and what is
 * actually in the table (is it being used).
 */
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import { getDb } from '../db'
import { OIDC_STORAGE_MOUNT, OIDC_STORE_PROBE_PREFIX } from '../storage/mount-oidc-session-store'
import { PG_KV_DRIVER_NAME } from '../storage/pg-kv-driver'
import { classifyProbeError } from './redact-probe-error'

export interface SessionStoreHealth {
  /** The driver `oidc:` actually resolves to. Anything but the PG driver = in-memory sessions. */
  driver: string
  /** Whether that driver is the durable one we intend. */
  durable: boolean
  /** A live write/read round-trip against the store, done for THIS request. */
  reachable: boolean
  /**
   * Why the round-trip failed, when it did. A REDACTED reason code (never a
   * raw driver message — see server/utils/redact-probe-error.ts), except for
   * the two authored, non-driver strings this module raises itself
   * ('storage unavailable in this context', and the roundtrip-mismatch case
   * which is itself one of the reason codes).
   */
  error: string | null
  /** Correlates a non-null `error` back to the full-fidelity server log line. Null when error is null. */
  correlationId: string | null
  /** Live (unexpired) session rows — excludes boot probes. */
  sessions: number
  /** Live boot-probe rows: one per replica that booted inside the probe ttl. */
  probes: number
  /** Most recent session write, ISO — the store being USED, not merely present. */
  newestSessionAt: string | null
}

/**
 * `useStorage` is Nitro-runtime-only, so it is injected rather than imported:
 * this module is unit-testable without a Nitro build, and the handler passes the
 * real one.
 */
export interface StorageLike {
  getMount: (key: string) => { driver: { name?: string } }
  setItem: (key: string, value: string, opts?: { ttl?: number }) => Promise<void>
  getItem: (key: string) => Promise<unknown>
  removeItem: (key: string) => Promise<void>
}

/** Round-trip probe rows are transient; 60s is long enough to observe, short enough to vanish. */
const HEALTH_PROBE_TTL_SECONDS = 60

const UNKNOWN: SessionStoreHealth = {
  driver: 'unknown',
  durable: false,
  reachable: false,
  error: null,
  correlationId: null,
  sessions: 0,
  probes: 0,
  newestSessionAt: null,
}

/**
 * NEVER THROWS — the single most important property here.
 *
 * This runs inside GET /api/v1/admin/settings (rendered at /admin/system), a
 * response that carries far more than this card. A diagnostic that takes down the endpoint it reports through is not a
 * diagnostic: the exact conditions it exists to reveal (kv_store missing
 * because migration 0097 never ran, Postgres briefly unreachable) would 500 the
 * whole page and hide the reason instead of showing it. Every failure is caught
 * and RETURNED as the finding.
 *
 * `storage` is nullable for the same reason: Nitro's `useStorage()` does not
 * exist when a handler is invoked directly (as the admin integration tests do),
 * and that must degrade to "unknown", not explode.
 */
export async function getSessionStoreHealth(
  storage: StorageLike | null,
): Promise<SessionStoreHealth> {
  if (!storage) return { ...UNKNOWN, error: 'storage unavailable in this context' }

  let driver: string
  try {
    driver = storage.getMount(`${OIDC_STORAGE_MOUNT}:health`).driver.name ?? 'unknown'
  } catch (e) {
    const { reason, correlationId } = classifyProbeError(e, 'session-store-health:mount')
    return { ...UNKNOWN, error: reason, correlationId }
  }
  const durable = driver === PG_KV_DRIVER_NAME

  // A LIVE round trip, not a cached verdict from boot: "it worked when this
  // container started" is a different claim from "it works now", and the second
  // is the one an admin looking at this page is asking about.
  //
  // UNIQUE per call, and cleaned up in `finally`. A fixed key would let two
  // concurrent page loads overwrite each other's stamp and each report the store
  // unreachable when it is fine — the same false-negative the BOOT probe was
  // already fixed for, which is precisely why it must not be reintroduced in its
  // sibling here. The finally also stops a mid-probe throw from leaving a row
  // behind, which would then be counted by the very query below.
  const key = `${OIDC_STORAGE_MOUNT}:${OIDC_STORE_PROBE_PREFIX}:health:${randomUUID()}`
  const stamp = `health:${Date.now()}`
  let reachable = false
  let error: string | null = null
  let correlationId: string | null = null
  try {
    await storage.setItem(key, stamp, { ttl: HEALTH_PROBE_TTL_SECONDS })
    reachable = (await storage.getItem(key)) === stamp
    // AUTHORED, not a driver exception — there is no `err` to classify, but
    // the reason is already one of redact-probe-error's codes, so it is
    // preserved verbatim rather than re-derived.
    if (!reachable) {
      error = 'roundtrip-mismatch'
      correlationId = randomUUID()
      consola.warn(`[probe-error:session-store-health:roundtrip] ${correlationId} write succeeded but the read-back did not match`)
    }
  } catch (e) {
    const classified = classifyProbeError(e, 'session-store-health:roundtrip')
    error = classified.reason
    correlationId = classified.correlationId
  } finally {
    await storage.removeItem(key).catch(() => {})
  }

  // Counted separately: sessions are the store doing its job, probes are only
  // evidence it is alive. Reporting them as one number would let a fleet of
  // boot probes read as healthy session traffic.
  // Guarded separately: if kv_store is missing (0097 never ran) this is exactly
  // the failure the card exists to report, so it must become the message rather
  // than an exception.
  let counts: { sessions: string; probes: string; newest_session_at: string | null } | undefined
  try {
    ;[counts] = await getDb().execute<{
      sessions: string
      probes: string
      newest_session_at: string | null
    }>(sql`
    SELECT
      -- starts_with(), NOT LIKE. The probe prefix is '__tokenscope__:boot-probe'
      -- and '_' is a LIKE single-character WILDCARD, so the pattern also matches
      -- keys like 'XXtokenscopeXX:boot-probe:1' — verified against Postgres, not
      -- assumed. That would file a session row under probes and quietly
      -- understate the session count this card exists to report. starts_with is
      -- a literal prefix test with no escaping to get wrong.
      COUNT(*) FILTER (WHERE NOT starts_with(key, ${OIDC_STORE_PROBE_PREFIX}))::text AS sessions,
      COUNT(*) FILTER (WHERE starts_with(key, ${OIDC_STORE_PROBE_PREFIX}))::text AS probes,
      MAX(updated_at) FILTER (WHERE NOT starts_with(key, ${OIDC_STORE_PROBE_PREFIX}))::text
        AS newest_session_at
    FROM kv_store
    WHERE mount = ${OIDC_STORAGE_MOUNT}
      AND (expires_at IS NULL OR expires_at > now())
  `)
  } catch (e) {
    // Preserve whichever error the round-trip probe already recorded (it ran
    // first); only classify this NEW failure when the round trip itself was
    // clean, mirroring the original "don't overwrite an earlier finding"
    // behaviour.
    const classified = error === null ? classifyProbeError(e, 'session-store-health:counts') : null
    return {
      driver,
      durable,
      reachable,
      error: error ?? classified!.reason,
      correlationId: correlationId ?? classified!.correlationId,
      sessions: 0,
      probes: 0,
      newestSessionAt: null,
    }
  }

  return {
    driver,
    durable,
    reachable,
    error,
    correlationId,
    sessions: Number(counts?.sessions ?? 0),
    probes: Number(counts?.probes ?? 0),
    newestSessionAt: counts?.newest_session_at ?? null,
  }
}
