/*
 * provisionAndPlace orchestration — unit tests with a fake store + mock directory.
 * Ordering: cost-centre → manager-chain UNIT (chargeable) → region holding → global.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  provisionAndPlace,
  type PlacementStore,
  type PlacementDerivation,
} from '../../../server/reconciliation/placement-service'
import type { PlacementCandidate } from '../../../server/reconciliation/placement'
import type { DirectoryUser } from '../../../server/azure/directory'

const CANDIDATES: PlacementCandidate[] = [
  { orgUnitId: 'ou-apac', regionId: 'rg-apac', costCentreCode: 'CC-4310' },
  { orgUnitId: 'ou-na', regionId: 'rg-na', costCentreCode: 'CC-9001' },
]

function fakeStore(
  over: Partial<PlacementStore> & {
    existing?: { id: string; onUnplaced: boolean; rehomeSafe: boolean } | null
  } = {},
): PlacementStore {
  return {
    findTeammateByEmail: vi.fn(async () => over.existing ?? null),
    loadCostOwningCandidates: vi.fn(async () => CANDIDATES),
    unplacedOrgUnitId: vi.fn(async () => 'ou-unplaced'),
    unplacedOrgUnitIdForRegion: vi.fn(async (regionId: string) => `ou-unplaced-${regionId}`),
    loadDepartmentToRegion: vi.fn(async () => new Map<string, string>()),
    loadActiveRegionLeaders: vi.fn(async () => new Map<string, string>()),
    loadActiveUnitOwners: vi.fn(async () => new Map()),
    createBillTeammate: vi.fn(async () => 'tm-new'),
    homeTeammate: vi.fn(async () => {}),
    setPlacementProvenance: vi.fn(async () => {}),
    replayOwedBills: vi.fn(async () => 0),
    ...over,
  }
}

const dirUser = (costCenter: string | null, department: string | null = null): DirectoryUser => ({
  oid: 'oid-x', email: 'dev@example.com', displayName: 'Dev X',
  department, jobTitle: null, costCenter, division: null,
})
const fakeDerive = (d: PlacementDerivation) => async (): Promise<PlacementDerivation> => d

describe('provisionAndPlace', () => {
  it('cost-centre match → real unit, placedVia cost-centre, placed=true', async () => {
    const store = fakeStore()
    const r = await provisionAndPlace('Dev@example.com', { store, lookupDirectory: async () => dirUser('CC-9001') })
    expect(r).toMatchObject({ created: true, placed: true, reason: 'matched', placedVia: 'cost-centre' })
    expect(store.createBillTeammate).toHaveBeenCalledWith(expect.objectContaining({ orgUnitId: 'ou-na' }))
  })

  it('unplaced by cost centre, manager-chain UNIT → homed to the OWNED unit, chargeable, provenance stamped', async () => {
    const store = fakeStore()
    const r = await provisionAndPlace('dev@example.com', {
      store,
      lookupDirectory: async () => dirUser('CC-NONE'),
      derivePlacement: fakeDerive({ orgUnitId: 'ou-mp', regionId: 'rg-apac', ownerOid: 'kat-oid', via: 'unit' }),
    })
    expect(r).toMatchObject({ created: true, placed: true, placedVia: 'unit' })
    expect(store.createBillTeammate).toHaveBeenCalledWith(expect.objectContaining({ orgUnitId: 'ou-mp' }))
    expect(store.unplacedOrgUnitIdForRegion).not.toHaveBeenCalled()
    expect(store.setPlacementProvenance).toHaveBeenCalledWith('tm-new', { ownerOid: 'kat-oid' })
  })

  it('no unit, DEPARTMENT region → region holding node, placed=false, provenance cleared', async () => {
    const store = fakeStore()
    const r = await provisionAndPlace('dev@example.com', {
      store,
      lookupDirectory: async () => dirUser('CC-NONE', 'APAC Digital'),
      derivePlacement: fakeDerive({ regionId: 'rg-apac', via: 'department' }),
    })
    expect(r).toMatchObject({ placed: false, placedVia: 'department' })
    expect(store.createBillTeammate).toHaveBeenCalledWith(expect.objectContaining({ orgUnitId: 'ou-unplaced-rg-apac' }))
    expect(store.setPlacementProvenance).toHaveBeenCalledWith('tm-new', null)
  })

  it('no unit, MANAGER region → placedVia manager', async () => {
    const store = fakeStore()
    const r = await provisionAndPlace('dev@example.com', {
      store, lookupDirectory: async () => dirUser('CC-NONE'),
      derivePlacement: fakeDerive({ regionId: 'rg-na', via: 'manager' }),
    })
    expect(r).toMatchObject({ placed: false, placedVia: 'manager' })
    expect(store.unplacedOrgUnitIdForRegion).toHaveBeenCalledWith('rg-na')
  })

  it('nothing resolves → GLOBAL fallback', async () => {
    const store = fakeStore()
    const r = await provisionAndPlace('dev@example.com', {
      store, lookupDirectory: async () => dirUser('CC-NONE'),
      derivePlacement: fakeDerive({ via: null }),
    })
    expect(r).toMatchObject({ placed: false, placedVia: 'global' })
    expect(store.unplacedOrgUnitId).toHaveBeenCalled()
  })

  it('directory-miss → no derivation, global', async () => {
    const store = fakeStore()
    const r = await provisionAndPlace('ghost@example.com', {
      store, lookupDirectory: async () => null,
      derivePlacement: fakeDerive({ orgUnitId: 'ou-mp', via: 'unit' }), // must NOT be consulted
    })
    expect(r).toMatchObject({ reason: 'directory-miss', placedVia: 'global' })
    expect(store.createBillTeammate).toHaveBeenCalledWith(expect.objectContaining({ orgUnitId: 'ou-unplaced' }))
  })

  it('existing on holding + rehome-safe → re-homed', async () => {
    const store = fakeStore({ existing: { id: 'tm-x', onUnplaced: true, rehomeSafe: true } })
    const r = await provisionAndPlace('dev@example.com', { store, lookupDirectory: async () => dirUser('CC-4310') })
    expect(r).toMatchObject({ teammateId: 'tm-x', created: false, homed: true })
    expect(store.homeTeammate).toHaveBeenCalledWith('tm-x', 'ou-apac')
  })

  it('existing on holding but NOT rehome-safe (live session) → not moved, bills still replay', async () => {
    const store = fakeStore({ existing: { id: 'tm-live', onUnplaced: true, rehomeSafe: false }, replayOwedBills: vi.fn(async () => 3) })
    const r = await provisionAndPlace('dev@example.com', { store, lookupDirectory: async () => dirUser('CC-4310') })
    expect(r).toMatchObject({ homed: false })
    expect(store.homeTeammate).not.toHaveBeenCalled()
    expect(store.setPlacementProvenance).not.toHaveBeenCalled() // only stamped when homed
    expect(r.replayedBills).toBe(3)
  })

  it('existing already placed (real node) → not clobbered', async () => {
    const store = fakeStore({ existing: { id: 'tm-p', onUnplaced: false, rehomeSafe: true }, replayOwedBills: vi.fn(async () => 2) })
    const r = await provisionAndPlace('dev@example.com', { store, lookupDirectory: async () => dirUser('CC-4310') })
    expect(r).toMatchObject({ homed: false })
    expect(store.homeTeammate).not.toHaveBeenCalled()
    expect(r.replayedBills).toBe(2)
  })
})
