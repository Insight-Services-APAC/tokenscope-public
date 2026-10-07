/*
 * GET /api/health — container and Front Door probe target.
 *
 * Two answers, chosen by the query (infra/modules/container-app.bicep):
 *   - `?probe=live` (the Liveness probe): 200 + {status:'ok'} without touching
 *     the database. Liveness restarts the replica, so a saturated pool or a
 *     Postgres blip must not fail it.
 *   - the bare path (Startup, Readiness, the Front Door origin probe): 200 +
 *     {status:'ok'} when the DB answers `SELECT 1`, 503 when it does not.
 *     Container Apps reads the status code to decide replica health.
 *
 * The query keeps both path exemptions working: require-front-door and
 * nuxt-security's per-route rules each compare the path without its query.
 *
 * NO RLS LANE, deliberately (docs/design/rls-enforcement.md; tracked as an
 * explicit residue in scripts/check-handler-rls-context.mjs). The probe is
 * ANONYMOUS — the ACA health probe presents no cookie and no credential, so
 * there is no identity to carry — and its query is `SELECT 1`, which names no
 * table and therefore no policy. Giving it a context would mean inventing an
 * identity for a liveness check; making it require one would mean a replica is
 * marked unhealthy the moment auth is misconfigured, which is the opposite of
 * what a liveness probe is for.
 */
import { defineEventHandler, getQuery, setResponseStatus } from 'h3'
import { useRuntimeConfig } from 'nitropack/runtime'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'

export default defineEventHandler(async (event) => {
  if (getQuery(event).probe === 'live') {
    return { status: 'ok', version: String(useRuntimeConfig().public.appVersion || 'unknown') }
  }
  // Lazy DB import — keeps the probe usable even if the DB module is
  // mid-init at first boot.
  try {
    const { getDb } = await import('../db')
    const db = getDb()
    await db.execute(sql`SELECT 1`)
    return {
      status: 'ok',
      checks: { db: 'up' },
      // The SAME source every other surface uses (shared/build-info.ts):
      // package.json, baked into runtimeConfig at build. `APP_VERSION` was read
      // here and set by nothing — no Dockerfile ARG, no Bicep env, no CI step —
      // so this probe reported "unknown" for the life of the endpoint while
      // /api/v1/meta/build had the real answer all along.
      version: String(useRuntimeConfig().public.appVersion || 'unknown'),
    }
  } catch (err) {
    // API-12: the probe is unauthenticated — postgres-js connection errors
    // can carry host/database/user details. Log the real error server-side,
    // return a static string to the caller.
    consola.error('[health] db ping failed', err instanceof Error ? err.message : err)
    setResponseStatus(event, 503)
    return {
      status: 'degraded',
      checks: { db: 'down' },
      error: 'db unreachable',
    }
  }
})
