/*
 * placement-sync — drains the owed-bill placement queue (the out-of-band half of
 * bill-driven placement; design docs/design/org-tree-and-bill-driven-placement.md).
 *
 * The money pollers ENQUEUE unknown-email bills into pending_placement (no Graph in
 * the money loop). This worker, on its own cadence, takes each distinct unplaced
 * identity and provisions+places the teammate (Entra-enriched) + replays its owed
 * bills into actual_spend — so a user who never logs in / emits still lands in their
 * cost-centre report. Graph faults are isolated here, never touching the poll.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { makePlacementStore } from '../reconciliation/placement-store'
import { provisionAndPlace, type PlacementDerivation } from '../reconciliation/placement-service'
import { derivePlacement, makeChainCaches, type GetManager } from '../reconciliation/region-derivation'
import { getUserManager, type DirectoryUser } from '../azure/directory'

type Db = PostgresJsDatabase<typeof schema>

export interface PlacementSyncResult {
  emailsConsidered: number
  provisioned: number
  placed: number
  errors: number
  // Placement-derivation coverage — counted on actual placements (created or re-homed).
  // viaUnit = a real practice (cost-owning unit, chargeable); viaAttribute (a directory
  // rule) / viaManager / viaBillingRegion = a region holding node; fellToGlobal = the
  // global bucket. `byAttribute` breaks viaAttribute down by which directory attribute
  // matched — the "which signal is placing people" coverage. `conflicts` counts placements
  // where a lower-precedence attribute matched a DIFFERENT region (a rule misconfig to fix).
  // Watch the ratio before trusting the signal / running the one-shot backfill.
  viaCostCentre: number
  viaUnit: number
  viaAttribute: number
  byAttribute: Record<string, number>
  viaManager: number
  viaBillingRegion: number
  fellToGlobal: number
  conflicts: number
}

/** Provision+place every distinct identity with un-replayed owed bills. Idempotent:
 *  re-running re-homes + re-replays (replay is a no-op once placed). */
export async function runPlacementSync(
  db: Db,
  opts?: {
    lookupDirectory?: (email: string) => Promise<DirectoryUser | null>
    /** Injected in tests; defaults to the real Graph manager hop. */
    getManager?: GetManager
    limit?: number
  },
): Promise<PlacementSyncResult> {
  const limit = opts?.limit ?? 500
  // Drain OLDEST-FIRST (by each identity's earliest un-replayed bill), matching the
  // pending_placement_unplaced index on first_seen_at and the migration's stated
  // "oldest-first" intent. Ordering alphabetically by email under a sustained backlog
  // (> the LIMIT) would let late-alphabet identities starve indefinitely.
  const rows = await db.execute<{ email: string }>(sql`
    SELECT lower(identity_email) AS email
    FROM pending_placement
    WHERE placed_at IS NULL
    GROUP BY lower(identity_email)
    ORDER BY min(first_seen_at)
    LIMIT ${limit}`)

  const store = makePlacementStore(db)

  // Build the region-derivation closure ONCE per run (mig 0068): load the curated maps and
  // create the manager/region caches a single time so they are SHARED across every user in
  // this run (AEUF's cross-user walk optimisation — a per-user cache would be dead).
  const rules = await store.loadDirectoryRegionRules()
  const leaderMap = await store.loadActiveRegionLeaders()
  const unitOwnerMap = await store.loadActiveUnitOwners()
  const caches = makeChainCaches()
  const getManager = opts?.getManager ?? getUserManager
  const derivePlacementForRun = (dir: DirectoryUser): Promise<PlacementDerivation> =>
    derivePlacement(dir, { rules, unitOwnerMap, leaderMap, getManager, caches })

  const result: PlacementSyncResult = {
    emailsConsidered: rows.length,
    provisioned: 0,
    placed: 0,
    errors: 0,
    viaCostCentre: 0,
    viaUnit: 0,
    viaAttribute: 0,
    byAttribute: {},
    viaManager: 0,
    viaBillingRegion: 0,
    fellToGlobal: 0,
    conflicts: 0,
  }
  for (const { email } of rows) {
    try {
      const r = await provisionAndPlace(email, {
        store,
        lookupDirectory: opts?.lookupDirectory,
        derivePlacement: derivePlacementForRun,
      })
      if (r.created) result.provisioned += 1
      if (r.placed) result.placed += 1
      // Coverage: count how the home was determined, but only on an ACTUAL placement
      // (created or re-homed) — a left-in-place teammate's `placedVia` is hypothetical.
      if (r.homed) {
        if (r.placedVia === 'cost-centre') result.viaCostCentre += 1
        else if (r.placedVia === 'unit') result.viaUnit += 1
        else if (r.placedVia === 'attribute') {
          result.viaAttribute += 1
          if (r.placedAttribute) result.byAttribute[r.placedAttribute] = (result.byAttribute[r.placedAttribute] ?? 0) + 1
          if (r.placedConflict) result.conflicts += 1
        } else if (r.placedVia === 'manager') result.viaManager += 1
        else if (r.placedVia === 'billing-region') result.viaBillingRegion += 1
        else result.fellToGlobal += 1
      }
    } catch (err) {
      // Isolate a single bad identity (bad Graph hit, transient) — retried next tick.
      result.errors += 1
      console.warn(`[placement-sync] ${email}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return result
}
