/*
 * region-reenrichment — re-derives the region of cost-centre-unplaced bill teammates
 * sitting on a holding node (mig 0068; docs/design/org-entra-region-derivation.md).
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
 * coverage ratio (viaAttribute/viaManager : fellToGlobal) on connector-health before
 * treating its output as authoritative.
 */
import { consola } from 'consola'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { makePlacementStore } from '../reconciliation/placement-store'
import { HOLDING_UNIT_TYPE } from '../../shared/placement/holding-nodes'
import { derivePlacement, makeChainCaches, type GetManager } from '../reconciliation/region-derivation'
import type { PlacementDerivation } from '../reconciliation/placement-service'
import { rehomeSafePredicate } from '../reconciliation/rehome-safety'
import {
  DERIVED_PLACEMENT_VIAS,
  PLACED_VIA_ATTRIBUTE_RULE,
  PLACED_VIA_MANAGER_CHAIN,
  type PlacementProvenance,
} from '../reconciliation/placement-provenance'
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
  /** Directory-snapshot writes that failed. DISPLAY data only — a non-zero here
   *  means the worklist's Department/Company columns are stale for that many
   *  people; it never means a placement was missed (the write is fenced). */
  snapshotErrors: number
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
  const rules = await store.loadDirectoryRegionRules()
  const leaderMap = await store.loadActiveRegionLeaders()
  const unitOwnerMap = await store.loadActiveUnitOwners()
  const caches = makeChainCaches()
  const getManager = opts?.getManager ?? getUserManager
  const lookup = opts?.lookupDirectory ?? getDirectoryUserByMailOrUpn

  // Candidates: bill placeholders that are EITHER on a holding node OR were DERIVED
  // into a unit (metadata.placedVia — a manager-chain walk or a curated attribute
  // rule) — re-deriving the latter is how a person who changes teams in Entra moves
  // to their new practice (and how a stale unit placement gets de-placed). Restricted
  // by rehomeSafePredicate to rows with NO live emit instance/oauth — the only ones we
  // may move without the admin revoke cascade. Oldest-touched first.
  //
  // ON unit_type, NOT on the holding-node CODE. This is the same definition the
  // worklist, the region's unplaced count and the RLS clamp use
  // (shared/placement/holding-nodes.ts): a holding node is defined by BEING one.
  // Keyed on the code, a second holding node minted under a different code showed
  // up in the admin's unplaced worklist and was invisible to this worker — one
  // population, two definitions, and the re-enrichment half silently skipping it.
  const rows = await db.execute<{ id: string; email: string; org_unit_id: string; on_holding: boolean }>(sql`
    SELECT t.id::text AS id, t.email, t.org_unit_id::text AS org_unit_id, (ou.unit_type = ${HOLDING_UNIT_TYPE}) AS on_holding
    FROM teammate t
    JOIN org_unit ou ON ou.id = t.org_unit_id
    WHERE (ou.unit_type = ${HOLDING_UNIT_TYPE} OR t.metadata->>'placedVia' IN ${[...DERIVED_PLACEMENT_VIAS]})
      AND ${rehomeSafePredicate(sql`t`)}
    ORDER BY t.last_sync_at NULLS FIRST
    LIMIT ${limit}`)

  const result: RegionReenrichmentResult = {
    considered: rows.length,
    rehomed: 0,
    alreadyCorrect: 0,
    unresolved: 0,
    errors: 0,
    snapshotErrors: 0,
  }

  for (const row of rows) {
    try {
      const dir = await lookup(row.email)
      if (!dir) {
        result.unresolved += 1
        continue
      }
      /*
       * The derivation, and then the snapshot — with the derivation's FAILURE held
       * rather than thrown, so the ordering serves both properties at once.
       *
       * The snapshot captures what the placement worklist groups by, from the
       * record we already fetched (server/reconciliation/directory-snapshot.ts). It
       * must still be written for a teammate the derivation cannot place — the
       * unresolvable ARE the population this feature exists for — and now also for
       * one whose derivation THREW, which is why the error is caught here and
       * re-thrown below instead of skipping the capture.
       *
       * It has to run AFTER the derivation because the manager comes FROM it: the
       * chain walk's first hop already asked Graph "who does this person report
       * to", and C9's clusters are that answer. Re-fetching it before the walk
       * would be a second Graph call for a fact the walk is about to produce.
       *
       * The capture is FENCED: it is DISPLAY data, and a failed UPDATE here must
       * never cost this teammate their re-derivation. Counted, not swallowed.
       */
      let der: PlacementDerivation | null = null
      let derivationError: unknown = null
      try {
        der = await derivePlacement(dir, { rules, unitOwnerMap, leaderMap, getManager, caches })
      } catch (err) {
        derivationError = err
      }

      try {
        await store.captureDirectorySnapshot(row.id, {
          department: dir.department,
          companyName: dir.companyName,
          // Only when the derivation actually walked the chain — see
          // DirectorySnapshot.manager. Omitting it leaves the last known manager
          // standing rather than blanking C9's clusters.
          ...(der?.manager ? { manager: der.manager } : {}),
        })
      } catch (err) {
        result.snapshotErrors += 1
        consola.warn('[region-reenrichment] directory snapshot failed', {
          email: row.email,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // Now let a derivation failure be what it always was: this identity's error,
      // isolated by the per-user catch below and retried next tick.
      if (derivationError !== null) throw derivationError
      // derivePlacement either returns a derivation or throws, and the throw was
      // just re-raised — so past this line there is one.
      const derived = der!

      // Resolve the TARGET org_unit + provenance for the derived placement.
      let targetOrgUnit: string
      let provenance: PlacementProvenance | null
      if (derived.via === 'unit') {
        targetOrgUnit = derived.orgUnitId!
        provenance = derived.ownerOid ? { via: PLACED_VIA_MANAGER_CHAIN, ownerOid: derived.ownerOid } : null
      } else if (derived.via === 'unit-rule') {
        targetOrgUnit = derived.orgUnitId!
        provenance = derived.attribute ? { via: PLACED_VIA_ATTRIBUTE_RULE, attribute: derived.attribute } : null
      } else if (derived.regionId) {
        targetOrgUnit = await store.unplacedOrgUnitIdForRegion(derived.regionId)
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
      consola.warn('[region-reenrichment] identity failed', {
        email: row.email,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}
