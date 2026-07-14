/*
 * Cost-centre placement decision — the money-correctness core of bill-driven user
 * placement (docs/design/org-tree-and-bill-driven-placement.md). PURE: no DB, no
 * Graph, so the matching rules are unit-tested in isolation.
 *
 * Bakes in the two adversarial-review fixes that are about *correctness*:
 *   - H3: match is EXACT on a normalised cost-centre (`lower(trim(x))` on BOTH the
 *     stored `cost_centre_code` and the Entra `costCenter`), guarded so any miss or
 *     ambiguity → UNPLACED, never a guess. (`cost_centre_code` is globally unique, so
 *     >1 hit "can't happen" — but we still fail SAFE if it does.)
 *   - H-A: a match returns BOTH the org_unit AND its region, so the caller sets
 *     `teammate.region_id` and `org_unit_id` TOGETHER (= the matched node's region).
 *     The two must never drift (the JIT default region is the bug this prevents).
 *
 * Callers pre-filter candidates to cost-owning, non-retired units (the only
 * chargeable homes); this function owns the normalise + decide.
 */

/** Normalise a cost-centre string for matching: trim + lowercase; blank → null.
 *  MUST be applied identically to the stored code and the Entra value (mismatched
 *  normalisation silently sends everyone to unplaced). */
export function normalizeCostCentre(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const n = raw.trim().toLowerCase()
  return n.length > 0 ? n : null
}

/** A cost-owning, active org_unit that can be a chargeable home. */
export interface PlacementCandidate {
  orgUnitId: string
  regionId: string
  /** The stored cost_centre_code (raw; normalised here). */
  costCentreCode: string | null
}

export type PlacementReason = 'matched' | 'no-cost-centre' | 'no-match' | 'ambiguous'

export interface PlacementResult {
  placed: boolean
  /** The home + its region — set TOGETHER by the caller (H-A). Null when unplaced. */
  orgUnitId: string | null
  regionId: string | null
  reason: PlacementReason
}

const UNPLACED = (reason: PlacementReason): PlacementResult => ({
  placed: false,
  orgUnitId: null,
  regionId: null,
  reason,
})

/**
 * Decide where a user's Entra cost centre homes them, given the cost-owning
 * candidates. Exact normalised match; fails SAFE to unplaced on no-cost-centre,
 * no-match, or (defensively) ambiguity. A match returns the node's region too.
 */
export function decidePlacement(
  costCentre: string | null | undefined,
  candidates: readonly PlacementCandidate[],
): PlacementResult {
  const target = normalizeCostCentre(costCentre)
  if (target === null) return UNPLACED('no-cost-centre')

  const hits = candidates.filter((c) => normalizeCostCentre(c.costCentreCode) === target)
  if (hits.length === 0) return UNPLACED('no-match')
  // cost_centre_code is globally unique → exactly one expected; >1 means a data
  // anomaly slipped past the constraint, so fail SAFE rather than pick arbitrarily.
  if (hits.length > 1) return UNPLACED('ambiguous')

  const hit = hits[0]!
  return { placed: true, orgUnitId: hit.orgUnitId, regionId: hit.regionId, reason: 'matched' }
}
