/*
 * Project-lifecycle policy resolver — D9 of docs/design/project-lifecycle.md.
 *
 * `grace_hours` (D2 spill buffer) and `warn_days` (D3 ending-soon window) are
 * platform-settable + region-overridable config held in `project_lifecycle_policy`.
 * Precedence: a region row overrides the single platform row; if neither exists
 * the hard-coded {2, 7} guard applies (the migration seeds the platform row, so
 * this only bites a corrupt/empty table — defence in depth).
 *
 * Two entry points:
 *  - resolveProjectLifecyclePolicy(db, regionId) — one lookup, for endpoints.
 *  - loadLifecyclePolicyResolver(db) — snapshot ALL rows once, return a pure
 *    (regionId) => policy fn, for hot paths that resolve per project/region many
 *    times in one pass (the joiner reads grace on every event; the ending-soon
 *    worker reads warn_days per project) — zero per-event queries.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface LifecyclePolicy {
  graceHours: number
  warnDays: number
}

/** Hard fallback if even the platform seed row is missing (migration seeds {2,7}). */
export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = { graceHours: 2, warnDays: 7 }

type AnyDb = PostgresJsDatabase<Record<string, unknown>>

interface PolicyRow extends Record<string, unknown> {
  scope_type: string
  scope_id: string | null
  grace_hours: number
  warn_days: number
}

function toPolicy(r: Pick<PolicyRow, 'grace_hours' | 'warn_days'>): LifecyclePolicy {
  return { graceHours: Number(r.grace_hours), warnDays: Number(r.warn_days) }
}

/** WHERE fragment selecting exactly one scope's row (the platform row, or a region's). */
function scopeMatch(scopeType: 'platform' | 'region', scopeId: string | null): SQL {
  return scopeType === 'platform'
    ? sql`scope_type = 'platform'`
    : sql`scope_type = 'region' AND scope_id = ${scopeId}::uuid`
}

/**
 * Resolve the effective policy for a project's region with a single query:
 * the region row if present, else the platform row, else {2,7}.
 */
export async function resolveProjectLifecyclePolicy(
  db: AnyDb,
  regionId: string | null,
): Promise<LifecyclePolicy> {
  const rows = await db.execute<PolicyRow>(sql`
    SELECT scope_type, scope_id::text AS scope_id, grace_hours, warn_days
      FROM project_lifecycle_policy
     WHERE scope_type = 'platform'
        OR (scope_type = 'region' AND scope_id = ${regionId}::uuid)
     ORDER BY (scope_type = 'region') DESC
     LIMIT 1
  `)
  const row = [...rows][0]
  return row ? toPolicy(row) : DEFAULT_LIFECYCLE_POLICY
}

/**
 * Snapshot the whole (small) policy table once and return a pure resolver.
 * Use in batch passes (joiner, workers) to avoid a query per project/region.
 */
export async function loadLifecyclePolicyResolver(
  db: AnyDb,
): Promise<(regionId: string | null) => LifecyclePolicy> {
  const rows = await db.execute<PolicyRow>(sql`
    SELECT scope_type, scope_id::text AS scope_id, grace_hours, warn_days
      FROM project_lifecycle_policy
  `)
  let platform = DEFAULT_LIFECYCLE_POLICY
  const byRegion = new Map<string, LifecyclePolicy>()
  for (const r of rows) {
    if (r.scope_type === 'platform') platform = toPolicy(r)
    else if (r.scope_id) byRegion.set(r.scope_id, toPolicy(r))
  }
  return (regionId) => (regionId ? byRegion.get(regionId) ?? platform : platform)
}

/** Read a single scope's row (null if absent). For the admin settings reads. */
export async function getLifecyclePolicyRow(
  db: AnyDb,
  scope: { scopeType: 'platform'; scopeId?: null } | { scopeType: 'region'; scopeId: string },
): Promise<LifecyclePolicy | null> {
  const match = scopeMatch(scope.scopeType, scope.scopeType === 'region' ? scope.scopeId : null)
  const rows = await db.execute<PolicyRow>(sql`
    SELECT scope_type, scope_id::text AS scope_id, grace_hours, warn_days
      FROM project_lifecycle_policy WHERE ${match} LIMIT 1
  `)
  const row = [...rows][0]
  return row ? toPolicy(row) : null
}

/**
 * Upsert the platform or a region scope's policy (one row per scope).
 *
 * Atomic upsert (API-9 — the previous UPDATE-then-INSERT raced itself into
 * the partial unique index and surfaced 23505 → 500):
 *   - region   → single `INSERT … ON CONFLICT (scope_id) WHERE
 *     scope_type='region' DO UPDATE` against
 *     project_lifecycle_policy_region_unique.
 *   - platform → its singleton index is on the EXPRESSION ((TRUE)), which
 *     ON CONFLICT arbiter inference cannot reliably target, so: targetless
 *     `ON CONFLICT DO NOTHING` (covers ALL unique indexes) + an
 *     unconditional UPDATE. Race-safe: whichever concurrent INSERT wins the
 *     singleton, every caller's UPDATE then applies its own values
 *     (last-writer-wins, never a 23505).
 */
export async function upsertLifecyclePolicy(
  db: AnyDb,
  opts: {
    scopeType: 'platform' | 'region'
    scopeId: string | null
    graceHours: number
    warnDays: number
    updatedBy: string | null
  },
): Promise<void> {
  if (opts.scopeType === 'region') {
    await db.execute(sql`
      INSERT INTO project_lifecycle_policy (scope_type, scope_id, grace_hours, warn_days, updated_by)
      VALUES ('region', ${opts.scopeId}::uuid, ${opts.graceHours}, ${opts.warnDays}, ${opts.updatedBy}::uuid)
      ON CONFLICT (scope_id) WHERE scope_type = 'region'
      DO UPDATE SET grace_hours = EXCLUDED.grace_hours,
                    warn_days   = EXCLUDED.warn_days,
                    updated_by  = EXCLUDED.updated_by,
                    updated_at  = now()
    `)
    return
  }
  await db.execute(sql`
    INSERT INTO project_lifecycle_policy (scope_type, scope_id, grace_hours, warn_days, updated_by)
    VALUES ('platform', NULL, ${opts.graceHours}, ${opts.warnDays}, ${opts.updatedBy}::uuid)
    ON CONFLICT DO NOTHING
  `)
  await db.execute(sql`
    UPDATE project_lifecycle_policy
       SET grace_hours = ${opts.graceHours}, warn_days = ${opts.warnDays},
           updated_by = ${opts.updatedBy}::uuid, updated_at = now()
     WHERE scope_type = 'platform'
  `)
}

/** Clear a region override → that region reverts to the platform default. */
export async function clearRegionLifecyclePolicy(db: AnyDb, regionId: string): Promise<boolean> {
  const del = await db.execute(sql`
    DELETE FROM project_lifecycle_policy
     WHERE scope_type = 'region' AND scope_id = ${regionId}::uuid
     RETURNING id::text AS id
  `)
  return [...del].length > 0
}
