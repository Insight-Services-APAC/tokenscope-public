// @vitest-environment node
/*
 * Pure pivot layer of the usage read-model (server/usage/breakdowns.ts) —
 * the shared-vocabulary shapes every session endpoint (and next sprint's
 * My Consumption) renders from. No DB: cells in, contracts out.
 */
import { describe, it, expect } from 'vitest'
import {
  breakdownFields,
  cacheStats,
  fidelitySplit,
  groupCells,
  pivotByModel,
  pivotByTokenType,
  toMatrix,
  type BreakdownCell,
} from '../../../server/usage/breakdowns'

const cell = (over: Partial<BreakdownCell>): BreakdownCell => ({
  conversation_id: 'conv-1',
  model: 'claude-fable-5',
  token_type: 'input',
  tokens: 0,
  cost_usd: 0,
  tier2_cost_usd: 0,
  ...over,
})

// A realistic two-model conversation: Fable dominant by cost, Haiku aux.
const CELLS: BreakdownCell[] = [
  cell({ token_type: 'input', tokens: 80_000, cost_usd: 0.24 }),
  cell({ token_type: 'output', tokens: 20_000, cost_usd: 0.3 }),
  cell({ token_type: 'cache-read', tokens: 1_200_000, cost_usd: 0.36 }),
  cell({ token_type: 'cache-write', tokens: 100_000, cost_usd: 0.376 }),
  cell({ model: 'claude-haiku-4-5', token_type: 'input', tokens: 5_000, cost_usd: 0.005 }),
  cell({ model: 'claude-haiku-4-5', token_type: 'output', tokens: 1_000, cost_usd: 0.004, tier2_cost_usd: 0.004 }),
]

describe('pivotByModel', () => {
  it('aggregates per model, ordered by cost share desc — models[0] is the chip', () => {
    const out = pivotByModel(CELLS)
    expect(out.map((m) => m.model)).toEqual(['claude-fable-5', 'claude-haiku-4-5'])
    expect(out[0]).toEqual({ model: 'claude-fable-5', tokens: 1_400_000, cost_usd: '1.28' })
    expect(out[1]!.tokens).toBe(6_000)
  })

  it('invariant: per-model sums re-add to the conversation totals', () => {
    const out = pivotByModel(CELLS)
    const tokens = out.reduce((a, m) => a + m.tokens, 0)
    const cost = out.reduce((a, m) => a + Number(m.cost_usd), 0)
    expect(tokens).toBe(CELLS.reduce((a, c) => a + c.tokens, 0))
    expect(cost).toBeCloseTo(CELLS.reduce((a, c) => a + c.cost_usd, 0), 2)
  })
})

describe('pivotByTokenType', () => {
  it('aggregates across models in the ledger vocabulary order', () => {
    const out = pivotByTokenType(CELLS)
    expect(out.map((t) => t.token_type)).toEqual(['input', 'output', 'cache-read', 'cache-write'])
    expect(out[0]!.tokens).toBe(85_000) // input across both models
  })
})

describe('toMatrix', () => {
  it('orders cells dominant-model-first then token-type order', () => {
    const m = toMatrix(CELLS)
    expect(m).toHaveLength(6)
    expect(m[0]).toMatchObject({ model: 'claude-fable-5', token_type: 'input' })
    expect(m[4]).toMatchObject({ model: 'claude-haiku-4-5', token_type: 'input' })
  })
})

describe('fidelitySplit', () => {
  it('tier2 ⊆ total; tier1 = total − tier2', () => {
    const f = fidelitySplit(CELLS)
    expect(Number(f.tier2_cost_usd)).toBeCloseTo(0.004, 4)
    expect(Number(f.tier1_cost_usd)).toBeCloseTo(1.28, 2)
  })
})

describe('cacheStats', () => {
  it('hit ratio + per-model effective-rate savings', () => {
    const c = cacheStats(CELLS)
    expect(c.read_tokens).toBe(1_200_000)
    expect(c.input_tokens).toBe(85_000)
    expect(c.write_tokens).toBe(100_000)
    // 1.2M / (1.2M + 85k)
    expect(c.hit_ratio).toBeCloseTo(1_200_000 / 1_285_000, 4)
    // Only Fable has both input and cache-read. Effective input rate
    // 0.24/80k; savings = 1.2M × rate − 0.36 = 3.6 − 0.36 = 3.24.
    expect(Number(c.savings_usd)).toBeCloseTo(3.24, 2)
  })

  it('no cache activity → zero ratio inputs handled (null ratio, null savings)', () => {
    const c = cacheStats([])
    expect(c.hit_ratio).toBeNull()
    expect(c.savings_usd).toBeNull()
  })

  it('cache-read without an input row for that model → conservative null savings, ratio still real', () => {
    const only = [cell({ token_type: 'cache-read', tokens: 1000, cost_usd: 0.0003 })]
    const c = cacheStats(only)
    expect(c.hit_ratio).toBe(1)
    expect(c.savings_usd).toBeNull()
  })
})

describe('groupCells + breakdownFields', () => {
  it('groups by conversation and exposes the list-endpoint block', () => {
    const mixed = [
      ...CELLS,
      cell({ conversation_id: 'conv-2', tokens: 10, cost_usd: 0.01 }),
    ]
    const grouped = groupCells(mixed)
    expect(grouped.get('conv-1')).toHaveLength(6)
    expect(grouped.get('conv-2')).toHaveLength(1)

    const fields = breakdownFields(grouped.get('conv-1')!)
    expect(fields.models[0]).toBe('claude-fable-5')
    expect(fields.by_model).toHaveLength(2)
    expect(fields.by_token_type).toHaveLength(4)
    expect(Number(fields.advisory_cost_usd)).toBeCloseTo(0.004, 4)
  })

  it('empty cells (legacy conversation) → empty-but-valid block', () => {
    const fields = breakdownFields([])
    expect(fields.models).toEqual([])
    expect(fields.by_model).toEqual([])
    expect(fields.by_token_type).toEqual([])
    expect(Number(fields.advisory_cost_usd)).toBe(0)
  })
})
