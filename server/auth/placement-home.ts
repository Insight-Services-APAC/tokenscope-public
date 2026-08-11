/*
 * placement-home — the canonical "no genuine placement yet" home for a
 * teammate: the per-region `__UNPLACED__` holding node.
 *
 * S3: lifted out of server/reconciliation/placement-store.ts (the bill-driven
 * placement lane already did this correctly — docs/design/org-tree-and-bill-driven
 * -placement.md:55-56, :158-159 ratify `__UNPLACED__` as the owner-decided
 * destination) so the auth-layer placement writers (first-SSO JIT, directory
 * pick, emit-on-install enroll, admin region reassign) stop minting their own
 * "first org_unit in the region" query. That query has no holding-node
 * semantics, so the caller's own path becomes a genuine least-privilege
 * placement whose subtree IS the whole region — the exact defect S3 closes.
 * Classic implementation gap: the SSO lane never got the treatment the bill
 * lane already had.
 *
 * `unplacedOrgUnitIdForRegion` REQUIRES a region id — it never defaults or
 * discovers one itself. A caller with no region yet (enroll-provision.ts, which
 * has no authenticated identity at all) must resolve one FIRST via
 * `resolveDefaultRegionId` and pass it in explicitly: a helper that invents a
 * region on the caller's behalf is the next silent cross-region placement.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { UNPLACED_UNIT_CODE, HOLDING_UNIT_TYPE } from '../../shared/placement/holding-nodes'

type Db = PostgresJsDatabase<Record<string, unknown>>

/**
 * The per-region `__UNPLACED__` holding org_unit id (mig 0068), create-on-demand
 * + idempotent. Same shape as (and now the single source backing)
 * placement-store.ts's SQL adapter: code '__UNPLACED__', unit_type 'holding',
 * is_cost_owning_unit false, path `<sanitised region code>_unplaced` (a single
 * ltree label so codes like 'north-america' are valid). The finance rollup
 * anchors on teammate.region_id (trigger-derived), so a teammate homed here
 * rolls up to THIS region's report — never the global `__unassigned__` bucket.
 */
export async function unplacedOrgUnitIdForRegion(db: Db, regionId: string): Promise<string> {
  await db.execute(sql`
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    SELECT gen_random_uuid(), r.id,
           (regexp_replace(r.code, '[^a-z0-9]', '_', 'g') || '_unplaced')::ltree,
           ${UNPLACED_UNIT_CODE}, 'Unplaced', ${HOLDING_UNIT_TYPE}, false
    FROM region r WHERE r.id = ${regionId}::uuid
    ON CONFLICT (region_id, code) DO NOTHING`)
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM org_unit
    WHERE region_id = ${regionId}::uuid AND code = ${UNPLACED_UNIT_CODE} LIMIT 1`)
  const id = [...rows][0]?.id
  if (!id) throw new Error(`placement: failed to create ${UNPLACED_UNIT_CODE} holding node for region ${regionId}`)
  return id
}

/**
 * The lexicographically-first region (by code) — the ONE placement default
 * every no-signal placement writer falls back to (first-SSO JIT with no
 * directory placement, emit-on-install enroll with no authenticated identity
 * at all). Centralised so every caller picks the SAME region rather than two
 * independently-ordered queries silently drifting apart. Returns null when the
 * DB has no region rows at all — callers throw their own contextual
 * "seed the DB first" error (the message differs per call site).
 */
export async function resolveDefaultRegionId(db: Db): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM region ORDER BY code ASC LIMIT 1`)
  return [...rows][0]?.id ?? null
}
