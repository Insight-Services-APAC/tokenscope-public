import { describe, it, expect } from 'vitest'
import { buildRollupTree, type RollupUnit, type UnitSpend } from '../../../server/utils/org-tree-rollup'

const u = (id: string, parentId: string | null): RollupUnit => ({
  id, parentId, code: id, displayName: id, unitType: 'bu', isCostOwningUnit: false,
})
const spend = (costUsd: number, tokens = 0, emitterCount = 1): UnitSpend => ({ costUsd, tokens, emitterCount })

describe('buildRollupTree', () => {
  // root → A, B ; A → A1
  const units = [u('root', null), u('A', 'root'), u('B', 'root'), u('A1', 'A')]

  it('rolls spend up the subtree (post-order) and computes the root total', () => {
    const sp = new Map([['A1', spend(5, 50)], ['B', spend(3, 30)], ['root', spend(1, 10)]])
    const { root } = buildRollupTree(units, sp, 'root')
    expect(root.rolledCostUsd).toBe(9) // 1 (own) + A(5) + B(3)
    expect(root.rolledTokens).toBe(90)
    const a = root.children.find((c) => c.id === 'A')!
    expect(a.rolledCostUsd).toBe(5) // 0 own + A1(5)
    expect(a.children[0]!.id).toBe('A1')
    expect(a.children[0]!.rolledCostUsd).toBe(5)
  })

  it('sorts children by rolled spend desc', () => {
    const sp = new Map([['A1', spend(2)], ['B', spend(7)]])
    const { root } = buildRollupTree(units, sp, 'root')
    expect(root.children.map((c) => c.id)).toEqual(['B', 'A']) // B(7) before A(2)
  })

  it('pctOfRoot is share-of-root; null when the root total is 0', () => {
    const sp = new Map([['A1', spend(5)], ['B', spend(5)]])
    const { root } = buildRollupTree(units, sp, 'root')
    expect(root.pctOfRoot).toBeCloseTo(1)
    expect(root.children.find((c) => c.id === 'B')!.pctOfRoot).toBeCloseTo(0.5)

    const { root: empty } = buildRollupTree(units, new Map(), 'root')
    expect(empty.rolledCostUsd).toBe(0)
    expect(empty.pctOfRoot).toBeNull()
    expect(empty.children.every((c) => c.pctOfRoot === null)).toBe(true)
  })

  it('spend on a unit NOT in the loaded tree → orphan (never silently dropped)', () => {
    const sp = new Map([['A1', spend(5, 50)], ['retired-x', spend(4, 40)]]) // retired-x not in units
    const { root, orphanCostUsd, orphanTokens } = buildRollupTree(units, sp, 'root')
    expect(root.rolledCostUsd).toBe(5) // only the in-tree spend
    expect(orphanCostUsd).toBe(4) // surfaced, not dropped
    expect(orphanTokens).toBe(40)
  })

  it('re-rooting at a mid node rolls only the subtree the caller loads', () => {
    // Per the builder contract, the endpoint loads ONLY A's subtree when rooting at A
    // (path <@ A.path) — B and the real root are never passed in. The cross-subtree
    // exclusion is the query's job (integration-tested), not this pure builder's.
    const subtree = [u('A', 'root'), u('A1', 'A')]
    const sp = new Map([['A1', spend(5)], ['B', spend(99)]]) // B present in spend but not loaded → orphan
    const { root, orphanCostUsd } = buildRollupTree(subtree, sp, 'A')
    expect(root.id).toBe('A')
    expect(root.rolledCostUsd).toBe(5) // A1 only
    expect(root.children.map((c) => c.id)).toEqual(['A1'])
    expect(orphanCostUsd).toBe(99) // B's spend is surfaced, never silently folded in
  })

  it('a live unit whose parent is missing re-parents to root (spend stays in the all-up)', () => {
    // 'orphanChild' points at 'goneMid' (a retired parent absent from the load). Its own +
    // subtree spend must NOT vanish — it attaches to root and counts toward the total.
    const withGap = [u('root', null), u('orphanChild', 'goneMid'), u('deep', 'orphanChild')]
    const sp = new Map([['orphanChild', spend(4)], ['deep', spend(6)]])
    const { root, orphanCostUsd } = buildRollupTree(withGap, sp, 'root')
    expect(root.rolledCostUsd).toBe(10) // 4 + 6, nothing dropped
    expect(orphanCostUsd).toBe(0) // both units ARE in the load, so neither is an orphan
    expect(root.children.map((c) => c.id)).toEqual(['orphanChild']) // re-parented to root
    expect(root.children[0]!.children.map((c) => c.id)).toEqual(['deep']) // its own subtree intact
  })

  it('a synthetic root gathers a forest of parent-less top-level units', () => {
    // No single real root: 'apps' and 'data' are both top-level (parent=null). The endpoint
    // injects a synthetic root; every top-level BU re-parents onto it.
    const forest = [u('__rgn__', null), u('apps', null), u('data', null), u('t1', 'apps')]
    const sp = new Map([['apps', spend(10)], ['t1', spend(5)], ['data', spend(7)]])
    const { root } = buildRollupTree(forest, sp, '__rgn__')
    expect(root.rolledCostUsd).toBe(22) // 10 + 5 + 7
    expect(root.children.map((c) => c.id)).toEqual(['apps', 'data']) // sorted desc: apps(15) > data(7)
    expect(root.children[0]!.children.map((c) => c.id)).toEqual(['t1']) // t1 stays under apps
  })

  it('rolls vendor spend (sum) and user count (DISTINCT set-union) up the subtree', () => {
    // root → A, B ; A → A1. Vendor + teammate sets per node; users overlap across nodes.
    const v = (claude: number, copilot: number, other = 0) => ({ claude, copilot, other })
    const sp = new Map<string, UnitSpend>([
      ['A1', { costUsd: 5, tokens: 0, emitterCount: 1, vendorUsd: v(5, 0), teammateIds: ['u1', 'u2'] }],
      ['B', { costUsd: 3, tokens: 0, emitterCount: 1, vendorUsd: v(0, 3), teammateIds: ['u2', 'u3'] }],
      ['root', { costUsd: 1, tokens: 0, emitterCount: 1, vendorUsd: v(0, 0, 1), teammateIds: ['u1'] }],
    ])
    const { root } = buildRollupTree(units, sp, 'root')
    expect(root.vendorUsd).toEqual(v(5, 3, 1)) // claude 5 (A1) + copilot 3 (B) + other 1 (root)
    expect(root.userCount).toBe(3) // {u1,u2} ∪ {u2,u3} ∪ {u1} = u1,u2,u3 — NOT 4 (no double-count)
    const a = root.children.find((c) => c.id === 'A')!
    expect(a.vendorUsd).toEqual(v(5, 0, 0)) // just A1's claude
    expect(a.userCount).toBe(2) // u1,u2 from A1
  })

  it('emitterCount is per-node direct (own), not rolled', () => {
    const sp = new Map([['A1', spend(5, 0, 3)], ['A', spend(0, 0, 2)]])
    const { root } = buildRollupTree(units, sp, 'root')
    const a = root.children.find((c) => c.id === 'A')!
    expect(a.ownEmitterCount).toBe(2)
    expect(a.children[0]!.ownEmitterCount).toBe(3)
  })
})
