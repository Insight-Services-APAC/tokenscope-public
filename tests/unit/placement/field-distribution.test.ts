/*
 * field-distribution — the diagnostic aggregation. Guards coverage math and the
 * k-anonymity suppression (no value cell smaller than MIN_CELL is ever surfaced).
 */
import { describe, it, expect } from 'vitest'
import { computeFieldDistribution, MIN_CELL, type DistributionUser } from '../../../shared/placement/field-distribution'

function users(companyNames: string[]): DistributionUser[] {
  return companyNames.map((c) => ({ companyName: c || null }))
}

describe('computeFieldDistribution', () => {
  it('coverage = populated / total', () => {
    const d = computeFieldDistribution(users(['Insight Australia', 'Insight Australia', '', '']))
    const cn = d.attributes.find((a) => a.attribute === 'companyName')!
    expect(d.total).toBe(4)
    expect(cn.populated).toBe(2)
    expect(cn.coveragePct).toBe(50)
  })

  it('groups case/space-insensitively, counts distinct, most-common first', () => {
    const d = computeFieldDistribution(
      users(Array(6).fill('Insight Australia').concat(Array(5).fill(' insight united kingdom '))),
      { minCell: 1 },
    )
    const cn = d.attributes.find((a) => a.attribute === 'companyName')!
    expect(cn.distinct).toBe(2)
    expect(cn.top[0]).toEqual({ value: 'Insight Australia', count: 6 })
    expect(cn.top[1]!.count).toBe(5)
  })

  it('k-anonymity: never surfaces a value cell below minCell; folds it into "other"', () => {
    // 6 common + 1 singleton "rare" value → the singleton must be suppressed.
    const d = computeFieldDistribution(
      users(Array(6).fill('Insight Australia').concat(['Antarctica Station'])),
    )
    const cn = d.attributes.find((a) => a.attribute === 'companyName')!
    expect(cn.top).toEqual([{ value: 'Insight Australia', count: 6 }])
    expect(cn.top.every((t) => t.count >= MIN_CELL)).toBe(true)
    expect(cn.other).toEqual({ values: 1, users: 1 }) // the singleton, suppressed
  })

  it('a flat single-value attribute reads as one dominant cell (the Insight `department` case)', () => {
    const d = computeFieldDistribution(Array(20).fill({ department: 'Services' }))
    const dep = d.attributes.find((a) => a.attribute === 'department')!
    expect(dep.coveragePct).toBe(100)
    expect(dep.distinct).toBe(1)
    expect(dep.top).toEqual([{ value: 'Services', count: 20 }])
  })

  it('empty sample → 0 coverage, no throw', () => {
    const d = computeFieldDistribution([])
    expect(d.total).toBe(0)
    for (const a of d.attributes) expect(a.coveragePct).toBe(0)
  })
})
