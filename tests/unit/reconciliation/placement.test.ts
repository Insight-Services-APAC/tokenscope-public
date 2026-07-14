/*
 * Cost-centre placement decision — unit tests (design §Round-2 corrections).
 *
 * Pins the correctness fixes the adversarial review demanded:
 *   - H3: exact normalised match; miss/ambiguity → UNPLACED, never a guess.
 *   - H-A: a match returns the matched node's REGION (so the caller sets
 *     region_id + org_unit_id together — the cross-region mis-charge fix).
 */
import { describe, it, expect } from 'vitest'
import { normalizeCostCentre, decidePlacement, type PlacementCandidate } from '../../../server/reconciliation/placement'

const apac: PlacementCandidate = { orgUnitId: 'ou-apac-digital', regionId: 'rg-apac', costCentreCode: 'CC-4310' }
const na: PlacementCandidate = { orgUnitId: 'ou-na-cloud', regionId: 'rg-na', costCentreCode: 'CC-9001' }
const emea: PlacementCandidate = { orgUnitId: 'ou-emea-data', regionId: 'rg-emea', costCentreCode: 'CC-2210' }
const ALL = [apac, na, emea]

describe('normalizeCostCentre', () => {
  it('trims + lowercases; blank → null', () => {
    expect(normalizeCostCentre('  CC-4310 ')).toBe('cc-4310')
    expect(normalizeCostCentre('cc-4310')).toBe('cc-4310')
    expect(normalizeCostCentre('')).toBeNull()
    expect(normalizeCostCentre('   ')).toBeNull()
    expect(normalizeCostCentre(null)).toBeNull()
    expect(normalizeCostCentre(undefined)).toBeNull()
  })
})

describe('decidePlacement', () => {
  it('exact match → placed, returns the node AND its region (H-A)', () => {
    const r = decidePlacement('CC-9001', ALL)
    expect(r).toEqual({ placed: true, orgUnitId: 'ou-na-cloud', regionId: 'rg-na', reason: 'matched' })
  })

  it('H-A: region comes from the matched node, never the caller default', () => {
    // A user the JIT defaulted to APAC, whose CC maps to an NA node, must home to NA.
    const r = decidePlacement('cc-9001', ALL)
    expect(r.regionId).toBe('rg-na') // not rg-apac
    expect(r.orgUnitId).toBe('ou-na-cloud')
  })

  it('normalises both sides (trim + case) before matching (H3)', () => {
    expect(decidePlacement('  cc-4310 ', ALL)).toMatchObject({ placed: true, orgUnitId: 'ou-apac-digital' })
    expect(decidePlacement('CC-4310', [{ ...apac, costCentreCode: '  cc-4310  ' }])).toMatchObject({ placed: true })
  })

  it('no cost centre (null/blank) → unplaced, reason no-cost-centre', () => {
    expect(decidePlacement(null, ALL)).toMatchObject({ placed: false, reason: 'no-cost-centre' })
    expect(decidePlacement('   ', ALL)).toMatchObject({ placed: false, reason: 'no-cost-centre' })
  })

  it('no matching node → unplaced, reason no-match (fails safe, never a guess)', () => {
    expect(decidePlacement('CC-0000', ALL)).toEqual({ placed: false, orgUnitId: null, regionId: null, reason: 'no-match' })
  })

  it('candidate with no cost_centre_code is never matched (and a null target is not a wildcard)', () => {
    const noCode: PlacementCandidate = { orgUnitId: 'ou-x', regionId: 'rg-x', costCentreCode: null }
    expect(decidePlacement('CC-4310', [noCode])).toMatchObject({ placed: false, reason: 'no-match' })
    // a null/blank target must NOT match a null-coded candidate
    expect(decidePlacement(null, [noCode])).toMatchObject({ placed: false, reason: 'no-cost-centre' })
  })

  it('DEFENCE: a duplicate code (should be impossible under the global-unique constraint) → unplaced, not an arbitrary pick', () => {
    const dupe: PlacementCandidate = { orgUnitId: 'ou-dupe', regionId: 'rg-emea', costCentreCode: 'CC-4310' }
    const r = decidePlacement('CC-4310', [apac, dupe])
    expect(r).toMatchObject({ placed: false, reason: 'ambiguous' })
  })
})
