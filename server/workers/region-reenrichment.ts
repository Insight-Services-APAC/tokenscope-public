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
 * emitting is LEFT for the admin region-PATCH (which runs the revoke cascade). The
 * selection is re-checked at WRITE time (placeTeammateIfStillSelected): someone who
 * signed in, was placed by an admin, or whose target was retired while this pass was
 * awaiting Graph is skipped, never moved. So this
 * worker is safe to run on a cron; the operator should still watch the placement-sync
 * coverage ratio (viaAttribute/viaManager : fellToGlobal) on connector-health before
 * treating its output as authoritative.
 *
 * GRAPH FAILURE IS NOT ABSENCE. The lookups are the STRICT variants: a throttle, 5xx
 * or timeout throws, and a throw skips the person for this run — not placed (never
 * the global bucket), counted in `errors`. A TRANSIENT failure leaves them unstamped,
 * retried at the head next run; any other failure stamps them (see the loop).
 */
import { consola } from 'consola'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { makePlacementStore } from '../reconciliation/placement-store'
import { HOLDING_UNIT_TYPE } from '../../shared/placement/holding-nodes'
import { derivePlacement, makeChainCaches, type GetManager } from '../reconciliation/region-derivation'
import type { CasPlacementTarget, PlacementDerivation } from '../reconciliation/placement-service'
import {
  PLACED_VIA_ATTRIBUTE_RULE,
  PLACED_VIA_MANAGER_CHAIN,
  reenrichmentCandidatePredicate,
  type PlacementProvenance,
} from '../reconciliation/placement-provenance'
import {
  getUserManager,
  getDirectoryUserByMailOrUpnStrict,
  isTransientGraphFailure,
  WORKER_GRAPH_RETRIES,
  type DirectoryUser,
  type GraphCallOptions,
} from '../azure/directory'

type Db = PostgresJsDatabase<typeof schema>

/** No new person is started after this much of the run (the dispatch budget is
 *  200 s; Graph calls in flight are bounded by the same deadline). */
export const REENRICH_BUDGET_MS = 150_000

const ACTOR_SYSTEM = 'region-reenrichment-worker'

export interface RegionReenrichmentResult {
  considered: number
  rehomed: number
  /** Resolved to a region but it was already the teammate's region (no-op). */
  alreadyCorrect: number
  /** No directory match / no signal resolved → left on the holding node. */
  unresolved: number
  /** Per-person failures, Graph errors included (a throttled or failed lookup
   *  is NOT "no match"). Skipped; a transient one is not stamped (retried at the
   *  head next run), any other one is stamped (retried when the queue comes round). */
  errors: number
  /** The write-time re-check refused the move: the person signed in, was moved by
   *  hand, or the target stopped being valid since selection. Skipped, not stamped. */
  casRefused: number
  /** The run stopped starting new people at REENRICH_BUDGET_MS. */
  deadlineHit: boolean
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
    /** Test seams for the deadline. */
    budgetMs?: number
    now?: () => number
  },
): Promise<RegionReenrichmentResult> {
  const limit = opts?.limit ?? 500
  const now = opts?.now ?? Date.now
  const deadline = now() + (opts?.budgetMs ?? REENRICH_BUDGET_MS)
  const graph: GraphCallOptions = { retries: WORKER_GRAPH_RETRIES, deadline }
  const store = makePlacementStore(db)
  const rules = await store.loadDirectoryRegionRules()
  const leaderMap = await store.loadActiveRegionLeaders()
  const unitOwnerMap = await store.loadActiveUnitOwners()
  const caches = makeChainCaches()
  const getManager: GetManager = opts?.getManager ?? ((oid) => getUserManager(oid, graph))
  const lookup = opts?.lookupDirectory ?? ((email: string) => getDirectoryUserByMailOrUpnStrict(email, graph))

  // Candidates (reenrichmentCandidatePredicate — the ONE definition, re-applied by
  // the compare-and-set write): bill placeholders that are EITHER on a holding node
  // OR were DERIVED into a unit (metadata.placedVia — a manager-chain walk or a
  // curated attribute rule) — re-deriving the latter is how a person who changes
  // teams in Entra moves to their new practice (and how a stale unit placement gets
  // de-placed). Restricted by rehomeSafePredicate to rows with NO live emit
  // instance/oauth — the only ones we may move without the admin revoke cascade.
  // Oldest-touched first.
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
    WHERE ${reenrichmentCandidatePredicate(sql`t`, sql`ou`)}
    ORDER BY t.last_sync_at NULLS FIRST
    LIMIT ${limit}`)

  const result: RegionReenrichmentResult = {
    considered: rows.length,
    rehomed: 0,
    alreadyCorrect: 0,
    unresolved: 0,
    errors: 0,
    casRefused: 0,
    deadlineHit: false,
    snapshotErrors: 0,
  }

  /*
   * THE CONTINUATION CURSOR — the same stamp region-reresolve.ts makes for the
   * same reason, and the jam stampPlacementAttempt's own comment describes.
   *
   * A row left with its timestamp untouched stays at the head of
   * `ORDER BY t.last_sync_at NULLS FIRST` for ever; past `limit` such rows the
   * window is re-read every tick and no other candidate is ever reached. So every
   * row this pass FINISHED is stamped — moved, already correct, or legitimately
   * unresolved — and stamped as it finishes, so a run cut short by its deadline
   * (or killed) keeps the progress it made. A move or a provenance re-stamp is
   * stamped inside its own compare-and-set transaction; an unresolved row here.
   *
   * A person whose write the re-check REFUSED is stamped too: the refusal means
   * the state changed since selection, and a refusal that repeats (a unit rule
   * whose region differs from its unit's, say) must not pin the head of the
   * queue. The next pass re-selects them from fresh state.
   *
   * A person whose lookup, derivation or write THREW is stamped unless the
   * failure was TRANSIENT (isTransientGraphFailure: a 429 or 5xx, a network
   * error, a timeout or abort, the deadline). A throttle or outage is not an
   * answer, and says nothing about this person: they stay at the head and are
   * retried next run, which costs nothing because the next run would fail on
   * everyone alike. Any other failure — a 4xx, a holding-node lookup or a write
   * that threw — would throw again on every run, so leaving it unstamped would
   * pin the head of the window exactly as an unstamped refusal would. Stamped,
   * it moves to the back and is retried when the queue comes round. A stamp that
   * itself fails is logged and left; the person stays where they were.
   */
  for (const row of rows) {
    if (now() >= deadline) {
      result.deadlineHit = true
      break
    }
    try {
      const dir = await lookup(row.email)
      if (!dir) {
        result.unresolved += 1
        await store.stampPlacementAttempt([row.id])
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
      let target: CasPlacementTarget
      let provenance: PlacementProvenance | null
      if (derived.via === 'unit') {
        target = { kind: 'unit', orgUnitId: derived.orgUnitId!, regionId: derived.regionId! }
        provenance = derived.ownerOid ? { via: PLACED_VIA_MANAGER_CHAIN, ownerOid: derived.ownerOid } : null
      } else if (derived.via === 'unit-rule') {
        target = { kind: 'unit', orgUnitId: derived.orgUnitId!, regionId: derived.regionId! }
        provenance = derived.attribute ? { via: PLACED_VIA_ATTRIBUTE_RULE, attribute: derived.attribute } : null
      } else if (derived.regionId) {
        target = {
          kind: 'holding-node',
          orgUnitId: await store.unplacedOrgUnitIdForRegion(derived.regionId),
          regionId: derived.regionId,
        }
        provenance = null
      } else if (!row.on_holding) {
        // No signal now, but the row WAS chain-placed into a unit → that placement is stale
        // (owner revoked / chain changed). De-place it to the global holding bucket so it
        // stops charging the old practice; an admin / a later resolve re-places it.
        target = { kind: 'holding-node', orgUnitId: await store.unplacedOrgUnitId(), regionId: null }
        provenance = null
      } else {
        result.unresolved += 1 // already on a holding node, still unresolved → leave
        await store.stampPlacementAttempt([row.id])
        continue
      }

      // One compare-and-set for both the move and the provenance-only re-stamp
      // (target = the unit it is already on): same locks, same re-checks.
      const outcome = await store.placeTeammateIfStillSelected({
        teammateId: row.id,
        selectedOrgUnitId: row.org_unit_id,
        target,
        provenance,
        actorSystem: ACTOR_SYSTEM,
      })
      if (outcome === 'refused') {
        result.casRefused += 1
        await store.stampPlacementAttempt([row.id])
      } else if (outcome === 'moved') result.rehomed += 1
      else result.alreadyCorrect += 1
    } catch (err) {
      // Isolate a single bad identity. Transient → unstamped; otherwise stamped
      // so a failure that repeats cannot hold the head of the queue.
      result.errors += 1
      const transient = isTransientGraphFailure(err)
      consola.warn('[region-reenrichment] identity failed', {
        email: row.email,
        transient,
        error: err instanceof Error ? err.message : String(err),
      })
      if (!transient) {
        try {
          await store.stampPlacementAttempt([row.id])
        } catch (stampErr) {
          consola.warn('[region-reenrichment] stamp after failure failed', {
            email: row.email,
            error: stampErr instanceof Error ? stampErr.message : String(stampErr),
          })
        }
      }
    }
  }

  return result
}
