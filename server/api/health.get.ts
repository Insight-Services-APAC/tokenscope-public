/*
 * GET /api/health — liveness + readiness probe target.
 *
 * Pointed at by the ACA container probes (infra/modules/container-app.bicep).
 * Returns 200 + {status:'ok'} when the process is alive AND can reach
 * the DB. Returns 503 if the DB ping fails — Container Apps reads the
 * status code to decide replica health.
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
import { defineEventHandler, setResponseStatus } from 'h3'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'

export default defineEventHandler(async (event) => {
  // Lazy DB import — keeps the probe usable even if the DB module is
  // mid-init at first boot.
  try {
    const { getDb } = await import('../db')
    const db = getDb()
    await db.execute(sql`SELECT 1`)
    return {
      status: 'ok',
      checks: { db: 'up' },
      version: process.env.APP_VERSION ?? 'unknown',
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
