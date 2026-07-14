/*
 * Bill-driven provision + placement orchestration
 * (docs/design/org-tree-and-bill-driven-placement.md).
 *
 * Pure-ish: it depends on a PlacementStore PORT (the DB ops) + a directory lookup,
 * both injectable — so the orchestration is unit-tested with fakes, while the SQL
 * store is integration-tested in CI. The money/sign-in correctness lives in the
 * store SQL (region trigger, bill: oid, replay idempotency) + decidePlacement.
 */
import { getDirectoryUserByMailOrUpn, type DirectoryUser } from '../azure/directory'
import { decidePlacement, type PlacementCandidate, type PlacementReason } from './placement'
import type { OwnedUnit } from './region-derivation'

/** The DB operations provisionAndPlace needs. The SQL adapter (CI-tested) sets
 *  org_unit_id; teammate.region_id follows automatically via the mig-0066 trigger
 *  — callers NEVER set region_id directly (that's the H-A invariant). */
export interface PlacementStore {
  /** Existing REAL (NOT provisional) teammate for this email: its id, whether it sits on
   *  a __UNPLACED__ holding node, and whether it is SAFE to auto re-home cross-region
   *  (never-adopted bill placeholder with no live emit instance). null when none. */
  findTeammateByEmail(
    email: string,
  ): Promise<{ id: string; onUnplaced: boolean; rehomeSafe: boolean } | null>
  /** Cost-owning, active units that carry a cost_centre_code (placement candidates). */
  loadCostOwningCandidates(): Promise<PlacementCandidate[]>
  /** The GLOBAL __unassigned__ holding org_unit id (last-resort fallback). */
  unplacedOrgUnitId(): Promise<string>
  /** The per-region __UNPLACED__ holding org_unit id (mig 0068), create-on-demand. */
  unplacedOrgUnitIdForRegion(regionId: string): Promise<string>
  /** Curated department_lower → region_id map (mig 0068 primary signal). */
  loadDepartmentToRegion(): Promise<Map<string, string>>
  /** Active region_leader oid → region_id map (mig 0068 manager-walk target). */
  loadActiveRegionLeaders(): Promise<Map<string, string>>
  /** Active cou_owner → owned cost-owning units, keyed on the owner's REAL Entra oid (the
   *  manager-chain match key). An owner may own >1 unit (ambiguous; resolved by the walk).
   *  Owners without a real oid (bill:/provisional:) are excluded. (Practice extension.) */
  loadActiveUnitOwners(): Promise<Map<string, OwnedUnit[]>>
  /** Create a REAL teammate from a provider-attested bill email (entra_oid='bill:'||uuid),
   *  homed to orgUnitId. Returns the new id. region_id is set by the trigger. */
  createBillTeammate(args: { email: string; displayName: string | null; orgUnitId: string }): Promise<string>
  /** Re-home an existing teammate to orgUnitId (region_id follows via the trigger). */
  homeTeammate(teammateId: string, orgUnitId: string): Promise<void>
  /** Stamp (or clear) manager-chain placement PROVENANCE on teammate.metadata. Set when the
   *  home was derived via the manager chain → a cost-owning unit (so re-enrichment can
   *  re-derive the person when their Entra manager changes); cleared on a non-unit home. */
  setPlacementProvenance(teammateId: string, prov: { ownerOid: string } | null): Promise<void>
  /** Replay this email's owed bills (pending_placement) into actual_spend for the
   *  now-existing teammate; idempotent. Returns the count replayed. */
  replayOwedBills(teammateId: string, email: string): Promise<number>
}

/** How a cost-centre-unplaced user's home was derived (mig 0068 + the practice extension).
 *  via='unit' → a cost-owning unit (chargeable, with orgUnitId + the owner oid for
 *  provenance); via='department'|'manager' → a region (holding node); via=null → neither. */
export interface PlacementDerivation {
  orgUnitId?: string
  regionId?: string
  ownerOid?: string
  via: 'unit' | 'department' | 'manager' | null
}

export interface PlacementDeps {
  store: PlacementStore
  /** Defaults to the real Graph exact lookup; injected in tests. */
  lookupDirectory?: (email: string) => Promise<DirectoryUser | null>
  /** Placement derivation for cost-centre-unplaced users. Built ONCE per worker run (so the
   *  manager caches + curated maps are shared across all users in the run — AEUF's
   *  cross-user optimisation). Absent → unplaced users use the global bucket (e.g. unit
   *  tests that don't exercise derivation). */
  derivePlacement?: (dir: DirectoryUser) => Promise<PlacementDerivation>
  /** ADR-0010 D4: the billing region the caller already knows (GitHub license-org →
   *  region, via regionForLicenseOrg). When set, a user who can't be placed by Entra
   *  (directory-miss or no cost-centre/derivation) is homed to THIS region's holding
   *  node instead of the GLOBAL __unassigned__ bucket — so a Copilot seat's cost always
   *  lands in the right region (D4's "no truly unplaceable seat at region grain").
   *  Anthropic callers omit it → unchanged global fallback. */
  fallbackRegionId?: string
}

export type PlacementVia = 'cost-centre' | 'unit' | 'department' | 'manager' | 'global'

export interface PlaceOutcome {
  teammateId: string
  created: boolean
  /** True = homed at a REAL cost-owning unit (cost-centre match OR manager-chain unit) →
   *  charges that unit's P&L. False = a holding node (region/global, unattributed). */
  placed: boolean
  /** 'directory-miss' = the email wasn't found in Entra at all (no enrichment). */
  reason: PlacementReason | 'directory-miss'
  replayedBills: number
  /** How the home was determined (coverage instrumentation). */
  placedVia: PlacementVia
  /** True when this call actually created or re-homed the teammate (vs left-in-place). */
  homed: boolean
}

/**
 * Provision (if needed) a teammate for a provider-attested bill email, enrich from
 * Entra, place by cost centre (or the __UNPLACED__ holding node), and replay any
 * owed bills. Idempotent: a second call for the same email re-homes + re-replays
 * (no duplicate teammate, no double-charge — replay is idempotent in the store).
 */
export async function provisionAndPlace(emailRaw: string, deps: PlacementDeps): Promise<PlaceOutcome> {
  const email = emailRaw.trim().toLowerCase()
  const lookup = deps.lookupDirectory ?? getDirectoryUserByMailOrUpn
  const { store } = deps

  // 1. Enrich (exact, single directory match — else we treat as a miss and hold).
  const dir = await lookup(email)

  // 2. Decide the home, in order: (a) exact cost-centre match → that cost-owning unit;
  //    else (b) manager-chain → a cost-owning UNIT (practice; chargeable, Entra is the org
  //    truth); else (c) manager-chain/department → a REGION holding node; else (d) the
  //    global __unassigned__ fallback. (a)+(b) are real placements (placed=true).
  const candidates = await store.loadCostOwningCandidates()
  const decision = dir ? decidePlacement(dir.costCenter, candidates) : null
  const reason: PlaceOutcome['reason'] = dir ? decision!.reason : 'directory-miss'

  let orgUnitId: string
  let placedVia: PlacementVia
  let placed: boolean
  let unitOwnerOid: string | null = null
  if (decision?.placed) {
    orgUnitId = decision.orgUnitId!
    placedVia = 'cost-centre'
    placed = true
  } else {
    const der = dir && deps.derivePlacement ? await deps.derivePlacement(dir) : null
    if (der?.via === 'unit') {
      orgUnitId = der.orgUnitId! // a real cost-owning unit (the owned practice)
      placedVia = 'unit'
      placed = true
      unitOwnerOid = der.ownerOid ?? null
    } else if (der?.regionId) {
      orgUnitId = await store.unplacedOrgUnitIdForRegion(der.regionId)
      placedVia = der.via === 'manager' ? 'manager' : 'department'
      placed = false
    } else if (deps.fallbackRegionId) {
      // ADR-0010 D4: no Entra placement, but the caller knows the billing region
      // (GitHub license-org → region). Home to that region's holding node — the seat's
      // cost lands in the right region rather than the global unassigned bucket. Same
      // OUTCOME as a department-derived region home (region holding node, placed=false).
      orgUnitId = await store.unplacedOrgUnitIdForRegion(deps.fallbackRegionId)
      placedVia = 'department'
      placed = false
    } else {
      orgUnitId = await store.unplacedOrgUnitId()
      placedVia = 'global'
      placed = false
    }
  }

  // 3. Find-or-create (region_id follows org_unit_id via the DB trigger — H-A).
  const existing = await store.findTeammateByEmail(email)
  let teammateId: string
  let created = false
  let homed = false
  if (existing === null) {
    teammateId = await store.createBillTeammate({ email, displayName: dir?.displayName ?? null, orgUnitId })
    created = true
    homed = true
  } else {
    teammateId = existing.id
    // Only (re)home a teammate that is (a) still on a holding node AND (b) safe to move
    // cross-region: a never-adopted bill placeholder with no live emit instance/oauth
    // (findTeammateByEmail.rehomeSafe). A teammate on a real node was deliberately placed;
    // a teammate with a live session must go through the admin region-PATCH revoke cascade.
    if (existing.onUnplaced && existing.rehomeSafe) {
      await store.homeTeammate(teammateId, orgUnitId)
      homed = true
    }
  }

  // 3b. Provenance: stamp manager-chain unit placements (so re-enrichment re-derives them
  //     when Entra changes); clear it on a non-unit (re-)home. Only when we actually homed.
  if (homed) {
    await store.setPlacementProvenance(teammateId, placedVia === 'unit' && unitOwnerOid ? { ownerOid: unitOwnerOid } : null)
  }

  // 4. Replay owed bills now that the teammate exists.
  const replayedBills = await store.replayOwedBills(teammateId, email)

  return { teammateId, created, placed, reason, replayedBills, placedVia, homed }
}
