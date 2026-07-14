/*
 * region-reenrichment — re-derives the region of cost-centre-unplaced bill teammates
 * sitting on a __UNPLACED__ holding node (mig 0068; docs/design/org-entra-region-derivation.md).
 *
 * Two jobs in one pass, both via the same department-first / manager-chain derivation:
 *  1. ONGOING heal: a teammate that fell to the global __unassigned__ bucket (transient
 *     Graph miss) or whose department/leader mapping was added AFTER they were first
 *     placed gets moved to their real region.
 *  2. ONE-SHOT backfill: the first run over the existing global __unassigned__ population
 *     IS the backfill — no separate code path.
 *
 * SAFETY (the #99-review revoke contract): we ONLY move a teammate that is a never-adopted
 * `bill:` placeholder with NO live emit instance — i.e. nobody whose live session/RLS scope
 * would be silently re-scoped. A teammate that has ever authenticated (real oid) or is
 * emitting is LEFT for the admin region-PATCH (which runs the revoke cascade). So this
 * worker is safe to run on a cron; the operator should still watch the placement-sync
 * coverage ratio (viaDepartment/viaManager : fellToGlobal) on connector-health before
 * treating its output as authoritative.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { makePlacementStore } from '../reconciliation/placement-store'
import { derivePlacement, makeChainCaches, type GetManager } from '../reconciliation/region-derivation'
import { getUserManager, getDirectoryUserByMailOrUpn, type DirectoryUser } from '../azure/directory'

type Db = PostgresJsDatabase<typeof schema>

export interface RegionReenrichmentResult {
  considered: number
  rehomed: number
  /** Resolved to a region but it was already the teammate's region (no-op). */
  alreadyCorrect: number
  /** No directory match / no signal resolved → left on the holding node. */
  unresolved: number
  errors: number
}

export async function runRegionReenrichment(
  db: Db,
  opts?: {
    lookupDirectory?: (email: string) => Promise<DirectoryUser | null>
    getManager?: GetManager
    limit?: number
  },
): Promise<RegionReenrichmentResult> {
  const limit = opts?.limit ?? 500
  const store = makePlacementStore(db)
  const deptMap = await store.loadDepartmentToRegion()
  const leaderMap = await store.loadActiveRegionLeaders()
  const unitOwnerMap = await store.loadActiveUnitOwners()
  const caches = makeChainCaches()
  const getManager = opts?.getManager ?? getUserManager
  const lookup = opts?.lookupDirectory ?? getDirectoryUserByMailOrUpn

  // Candidates: bill placeholders that are EITHER on a __UNPLACED__ holding node OR were
  // manager-chain placed into a unit (metadata.placedVia) — re-deriving the latter is how a
  // person who changes teams in Entra moves to their new practice (and how a stale unit
  // placement gets de-placed). Restricted to rows with NO live emit instance/oauth — the
  // only ones we may move without the admin revoke cascade. Oldest-touched first.
  const rows = await db.execute<{ id: string; email: string; org_unit_id: string; on_holding: boolean }>(sql`
    SELECT t.id::text AS id, t.email, t.org_unit_id::text AS org_unit_id, (ou.code = '__UNPLACED__') AS on_holding
    FROM teammate t
    JOIN org_unit ou ON ou.id = t.org_unit_id
    WHERE t.entra_oid LIKE 'bill:%'
      AND (ou.code = '__UNPLACED__' OR t.metadata->>'placedVia' = 'manager-chain')
      AND NOT EXISTS (
        SELECT 1 FROM instance_attestation ia
        WHERE ia.teammate_id = t.id AND ia.ts_actual_end IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM oauth_token o
        WHERE o.teammate_id = t.id AND o.revoked_at IS NULL
      )
    ORDER BY t.last_sync_at NULLS FIRST
    LIMIT ${limit}`)

  const result: RegionReenrichmentResult = {
    considered: rows.length,
    rehomed: 0,
    alreadyCorrect: 0,
    unresolved: 0,
    errors: 0,
  }

  for (const row of rows) {
    try {
      const dir = await lookup(row.email)
      if (!dir) {
        result.unresolved += 1
        continue
      }
      const der = await derivePlacement(dir, { deptMap, unitOwnerMap, leaderMap, getManager, caches })

      // Resolve the TARGET org_unit + provenance for the derived placement.
      let targetOrgUnit: string
      let provenance: { ownerOid: string } | null
      if (der.via === 'unit') {
        targetOrgUnit = der.orgUnitId!
        provenance = der.ownerOid ? { ownerOid: der.ownerOid } : null
      } else if (der.regionId) {
        targetOrgUnit = await store.unplacedOrgUnitIdForRegion(der.regionId)
        provenance = null
      } else if (!row.on_holding) {
        // No signal now, but the row WAS chain-placed into a unit → that placement is stale
        // (owner revoked / chain changed). De-place it to the global holding bucket so it
        // stops charging the old practice; an admin / a later resolve re-places it.
        targetOrgUnit = await store.unplacedOrgUnitId()
        provenance = null
      } else {
        result.unresolved += 1 // already on a holding node, still unresolved → leave
        continue
      }

      if (targetOrgUnit === row.org_unit_id) {
        // Still the right home, but provenance may need (un)setting after a re-derive.
        await store.setPlacementProvenance(row.id, provenance)
        result.alreadyCorrect += 1
        continue
      }
      await store.homeTeammate(row.id, targetOrgUnit)
      await store.setPlacementProvenance(row.id, provenance)
      result.rehomed += 1
    } catch (err) {
      // Isolate a single bad identity (transient Graph hit) — retried next tick.
      result.errors += 1
      console.warn(`[region-reenrichment] ${row.email}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return result
}
