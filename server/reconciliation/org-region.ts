/*
 * Intent: ADR-0010 D4 — "attribution is by GitHub org → region".
 *
 * regionForLicenseOrg resolves a GitHub license-org (the seat's billing org) to its
 * mapped region_id (provider_org.region_id, mig 0071). The bill-driven provisioner
 * uses it as the FLOOR for a Copilot seat-holder who can't be placed into a practice
 * by Entra: every seat's cost still lands in the right region. NULL when the org is
 * unregistered or unmapped → the provisioner falls back to the global holding node
 * (today's behaviour), so this is inert until an admin maps the org.
 *
 * Case-insensitive on external_org_id to match the canonical-lowercase read convention
 * used across the GitHub surfaces (mig 0064).
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
/* Widened to the generic row type so this works with BOTH a pool handle (getDb(), the worker
 * callers) and a request TRANSACTION handle. A request handler must not check out a second
 * connection while holding one: with a bounded pool that deadlocks under concurrency instead of
 * queueing. Only raw `execute` is used here, so the schema generic buys nothing. Mirrors
 * server/utils/directory-exclusions.ts, which is called from both surfaces for the same reason. */
type Db = PostgresJsDatabase<Record<string, unknown>>

export async function regionForLicenseOrg(
  db: Db,
  licenseOrg: string | null | undefined,
): Promise<string | null> {
  if (!licenseOrg) return null
  const org = licenseOrg.trim()
  if (!org) return null
  const rows = await db.execute<{ region_id: string | null }>(sql`
    SELECT region_id::text AS region_id
    FROM provider_org
    WHERE provider = 'github' AND lower(external_org_id) = lower(${org})
    LIMIT 1
  `)
  return rows[0]?.region_id ?? null
}
