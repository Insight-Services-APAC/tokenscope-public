/*
 * Placement derivation core — manager-chain walk to a UNIT (cou_owner) or REGION
 * (region_leader). Carries the AEUF cases (hop cap, cycle, cache back-propagation,
 * department-first for region) and adds the unit-placement invariants: unit ALWAYS wins
 * over a nearer region, multi-unit owner is ambiguous, owned-unit is the target.
 */
import { describe, it, expect } from 'vitest'
import {
  mapAttributesToRegion,
  resolvePlacementViaManagerChain,
  derivePlacement,
  makeChainCaches,
  type GetManager,
  type ManagerEdge,
  type OwnedUnit,
  type RegionRuleSet,
} from '../../../server/reconciliation/region-derivation'
import { normalizeMatchValue, type RegionAttributeKey } from '../../../shared/placement/region-attributes'
import type { DirectoryUser } from '../../../server/azure/directory'

/** Build a RegionRuleSet from [attribute, value, regionId, mode?] tuples. */
function ruleset(rules: Array<[RegionAttributeKey, string, string, ('exact' | 'prefix')?]>): RegionRuleSet {
  const exact: RegionRuleSet['exact'] = new Map()
  const prefix: RegionRuleSet['prefix'] = []
  for (const [attr, val, rid, mode] of rules) {
    const v = normalizeMatchValue(val)
    if (mode === 'prefix') {
      prefix.push({ attribute: attr, value: v, regionId: rid })
    } else {
      let m = exact.get(attr)
      if (!m) {
        m = new Map()
        exact.set(attr, m)
      }
      m.set(v, rid)
    }
  }
  prefix.sort((a, b) => b.value.length - a.value.length)
  return { exact, prefix }
}

function fakeManager(edges: Record<string, ManagerEdge | null>) {
  const calls: string[] = []
  const get: GetManager = async (oid) => {
    calls.push(oid)
    return Object.prototype.hasOwnProperty.call(edges, oid) ? edges[oid]! : null
  }
  return { get, calls }
}
const unit = (orgUnitId: string, regionId = 'rg'): OwnedUnit => ({ orgUnitId, regionId })
const dir = (over: Partial<DirectoryUser> = {}): DirectoryUser => ({
  oid: 'u', email: 'u@x.com', displayName: 'U', mail: null, upn: null,
  department: null, jobTitle: null, companyName: null, country: null,
  officeLocation: null, state: null, costCenter: null, division: null,
  ...over,
})

describe('mapAttributesToRegion', () => {
  it('exact match, case-insensitive + trim; blank/unmapped → null', () => {
    const rules = ruleset([['companyName', 'Insight Australia', 'rg-apac']])
    expect(mapAttributesToRegion(dir({ companyName: ' Insight Australia ' }), rules))
      .toEqual({ regionId: 'rg-apac', attribute: 'companyName', conflict: false })
    expect(mapAttributesToRegion(dir({ companyName: 'Insight USA' }), rules)).toBeNull()
    expect(mapAttributesToRegion(dir({ companyName: null }), rules)).toBeNull()
  })
  it('prefix match — a country/state prefix maps a whole office group', () => {
    const rules = ruleset([['officeLocation', 'au-', 'rg-apac', 'prefix']])
    expect(mapAttributesToRegion(dir({ officeLocation: 'AU-Brisbane' }), rules)?.regionId).toBe('rg-apac')
    expect(mapAttributesToRegion(dir({ officeLocation: 'UK-London' }), rules)).toBeNull()
  })
  it('precedence: higher-precedence attribute wins; divergent lower match flags conflict', () => {
    // companyName (precedence 0) beats department (precedence 4); different regions → conflict.
    const rules = ruleset([
      ['companyName', 'Insight Australia', 'rg-apac'],
      ['department', 'Services', 'rg-emea'],
    ])
    const m = mapAttributesToRegion(dir({ companyName: 'Insight Australia', department: 'Services' }), rules)
    expect(m).toEqual({ regionId: 'rg-apac', attribute: 'companyName', conflict: true })
  })
  it('same region across attributes → no conflict', () => {
    const rules = ruleset([
      ['companyName', 'Insight Australia', 'rg-apac'],
      ['country', 'Australia', 'rg-apac'],
    ])
    expect(mapAttributesToRegion(dir({ companyName: 'Insight Australia', country: 'Australia' }), rules)?.conflict).toBe(false)
  })
})

describe('resolvePlacementViaManagerChain', () => {
  const noUnits = new Map<string, OwnedUnit[]>()
  const noLeaders = new Map<string, string>()

  it('self is a unit owner → unit immediately, no climb', async () => {
    const m = fakeManager({})
    const owners = new Map([['u', [unit('ou-1', 'rg-1')]]])
    const r = await resolvePlacementViaManagerChain('u', { unitOwnerMap: owners, leaderMap: noLeaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toEqual({ kind: 'unit', orgUnitId: 'ou-1', regionId: 'rg-1', ownerOid: 'u' })
    expect(m.calls).toEqual([])
  })

  it('UNIT ALWAYS WINS over a region-leader that is NEARER in the chain', async () => {
    // dev → X (region leader, hop 1) → Katrina (unit owner, hop 2). Must resolve to the UNIT,
    // never short-circuit on the nearer region leader.
    const m = fakeManager({ dev: { oid: 'x', email: null }, x: { oid: 'katrina', email: null }, katrina: { oid: 'top', email: null } })
    const owners = new Map([['katrina', [unit('ou-mp', 'rg-apac')]]])
    const leaders = new Map([['x', 'rg-apac']])
    const r = await resolvePlacementViaManagerChain('dev', { unitOwnerMap: owners, leaderMap: leaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toEqual({ kind: 'unit', orgUnitId: 'ou-mp', regionId: 'rg-apac', ownerOid: 'katrina' })
  })

  it('nearest unit wins when two owners are in the chain', async () => {
    const m = fakeManager({ a: { oid: 'b', email: null }, b: { oid: 'c', email: null } })
    const owners = new Map([['b', [unit('ou-near')]], ['c', [unit('ou-far')]]])
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: owners, leaderMap: noLeaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toMatchObject({ kind: 'unit', orgUnitId: 'ou-near' })
  })

  it('multi-unit owner is AMBIGUOUS → skipped; climbs to the next unambiguous owner', async () => {
    const m = fakeManager({ a: { oid: 'kat', email: null }, kat: { oid: 'vp', email: null } })
    const owners = new Map([['kat', [unit('ou-mp'), unit('ou-data')]], ['vp', [unit('ou-bu')]]])
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: owners, leaderMap: noLeaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toMatchObject({ kind: 'unit', orgUnitId: 'ou-bu' }) // kat skipped (2 units), vp wins
  })

  it('multi-unit owner with no owner above → falls to region', async () => {
    const m = fakeManager({ a: { oid: 'kat', email: null }, kat: { oid: 'vp', email: null } })
    const owners = new Map([['kat', [unit('ou-mp'), unit('ou-data')]]])
    const leaders = new Map([['vp', 'rg-apac']])
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: owners, leaderMap: leaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toEqual({ kind: 'region', regionId: 'rg-apac' })
  })

  it('no owner in chain → region leader (nearest) wins', async () => {
    const m = fakeManager({ a: { oid: 'b', email: null }, b: { oid: 'c', email: null } })
    const leaders = new Map([['b', 'rg-near'], ['c', 'rg-far']])
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: noUnits, leaderMap: leaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toEqual({ kind: 'region', regionId: 'rg-near' })
  })

  it('hop cap → null', async () => {
    const m = fakeManager({ a: { oid: 'b', email: null }, b: { oid: 'c', email: null }, c: { oid: 'd', email: null } })
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: noUnits, leaderMap: noLeaders, getManager: m.get, caches: makeChainCaches(), maxHops: 1 })
    expect(r).toBeNull()
  })

  it('cycle → null (no infinite loop)', async () => {
    const m = fakeManager({ a: { oid: 'b', email: null }, b: { oid: 'a', email: null } })
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: noUnits, leaderMap: noLeaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toBeNull()
  })

  it('back-propagates so a sibling sharing the chain short-circuits (incl. region-below-unit)', async () => {
    // dev → x(region leader) → kat(unit). sib → x. After dev resolves to the unit, x is
    // cached as the UNIT (not region), so sib resolves to the unit with one extra hop.
    const m = fakeManager({ dev: { oid: 'x', email: null }, x: { oid: 'kat', email: null }, kat: { oid: 't', email: null }, sib: { oid: 'x', email: null } })
    const owners = new Map([['kat', [unit('ou-mp')]]])
    const leaders = new Map([['x', 'rg-apac']])
    const caches = makeChainCaches()
    const r1 = await resolvePlacementViaManagerChain('dev', { unitOwnerMap: owners, leaderMap: leaders, getManager: m.get, caches })
    expect(r1).toMatchObject({ kind: 'unit', orgUnitId: 'ou-mp' })
    const callsAfter = m.calls.length
    const r2 = await resolvePlacementViaManagerChain('sib', { unitOwnerMap: owners, leaderMap: leaders, getManager: m.get, caches })
    expect(r2).toMatchObject({ kind: 'unit', orgUnitId: 'ou-mp' }) // x cached as unit, not region
    expect(m.calls.length).toBe(callsAfter + 1) // only sib→x
  })

  it('transient (non-404) Graph error PROPAGATES and is NOT cached', async () => {
    let throwOnce = true
    const get: GetManager = async (oid) => {
      if (oid === 'a' && throwOnce) { throwOnce = false; throw new Error('Graph request failed (429) for /users/a/manager.') }
      return ({ a: { oid: 'b', email: null } } as Record<string, ManagerEdge | null>)[oid] ?? null
    }
    const caches = makeChainCaches()
    const leaders = new Map([['b', 'rg-b']])
    await expect(resolvePlacementViaManagerChain('a', { unitOwnerMap: noUnits, leaderMap: leaders, getManager: get, caches })).rejects.toThrow(/429/)
    expect(caches.placementCache.has('a')).toBe(false)
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: noUnits, leaderMap: leaders, getManager: get, caches })
    expect(r).toEqual({ kind: 'region', regionId: 'rg-b' })
  })
})

describe('derivePlacement', () => {
  const rules = ruleset([['department', 'APAC Digital', 'rg-dept']])
  it('chain UNIT wins (department ignored, region ignored)', async () => {
    const m = fakeManager({ u: { oid: 'kat', email: null } })
    const r = await derivePlacement(dir({ department: 'APAC Digital', oid: 'u' }), {
      rules, unitOwnerMap: new Map([['kat', [unit('ou-mp', 'rg-x')]]]), leaderMap: new Map([['kat', 'rg-y']]),
      getManager: m.get, caches: makeChainCaches(),
    })
    expect(r).toEqual({ orgUnitId: 'ou-mp', regionId: 'rg-x', ownerOid: 'kat', via: 'unit' })
  })
  it('no unit → ATTRIBUTE region wins over chain region', async () => {
    const m = fakeManager({ u: { oid: 'vp', email: null } })
    const r = await derivePlacement(dir({ department: 'APAC Digital', oid: 'u' }), {
      rules, unitOwnerMap: new Map(), leaderMap: new Map([['vp', 'rg-chain']]),
      getManager: m.get, caches: makeChainCaches(),
    })
    expect(r).toEqual({ regionId: 'rg-dept', via: 'attribute', attribute: 'department', conflict: false })
  })
  it('no unit, no attribute → chain REGION (manager)', async () => {
    const m = fakeManager({ u: { oid: 'vp', email: null } })
    const r = await derivePlacement(dir({ department: 'Services', oid: 'u' }), {
      rules, unitOwnerMap: new Map(), leaderMap: new Map([['vp', 'rg-chain']]),
      getManager: m.get, caches: makeChainCaches(),
    })
    expect(r).toEqual({ regionId: 'rg-chain', via: 'manager' })
  })
  it('nothing resolves → via null', async () => {
    const m = fakeManager({ u: { oid: 'vp', email: null } })
    const r = await derivePlacement(dir({ department: 'Services', oid: 'u' }), {
      rules, unitOwnerMap: new Map(), leaderMap: new Map(), getManager: m.get, caches: makeChainCaches(),
    })
    expect(r).toEqual({ via: null })
  })
  it('no oid → no walk', async () => {
    const m = fakeManager({})
    const r = await derivePlacement(dir({ oid: '' }), {
      rules, unitOwnerMap: new Map([['kat', [unit('ou')]]]), leaderMap: new Map(), getManager: m.get, caches: makeChainCaches(),
    })
    expect(r).toEqual({ via: null })
    expect(m.calls).toEqual([])
  })
})
