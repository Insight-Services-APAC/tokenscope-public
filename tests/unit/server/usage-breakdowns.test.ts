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
  pricedPerLane,
  sessionLaneView,
  toMatrix,
  type BreakdownCell,
} from '../../../server/usage/breakdowns'
import { SessionTokenTypeSpend, SessionMatrixCell } from '../../../shared/schemas/usage'

const cell = (over: Partial<BreakdownCell>): BreakdownCell => ({
  conversation_id: 'conv-1',
  model: 'claude-fable-5',
  token_type: 'input',
  tokens: 0,
  cost_usd: 0,
  tier2_cost_usd: 0,
  lane_priced: true,
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

/*
 * ── T14 / T15 — credit-priced lanes render honestly (fix sprint F3) ────────
 *
 * A credit-priced span's whole cost is conserved on ONE carrier lane by design
 * (server/usage/span-costing.ts:61-76). The arithmetic is right; what was wrong
 * was showing the other lanes' structural 0 as if it were a price.
 */

/** The Copilot shape as the joiner writes it: cost on the carrier, credits throughout. */
const CREDIT_CELLS: BreakdownCell[] = [
  cell({ model: 'gpt-5-codex', token_type: 'input', tokens: 120_000, cost_usd: 53.54, lane_priced: false }),
  cell({ model: 'gpt-5-codex', token_type: 'output', tokens: 8_000, cost_usd: 0, lane_priced: false }),
  cell({ model: 'gpt-5-codex', token_type: 'cache-read', tokens: 900_000, cost_usd: 0, lane_priced: false }),
  cell({ model: 'gpt-5-codex', token_type: 'cache-write', tokens: 40_000, cost_usd: 0, lane_priced: false }),
]

describe('T14 — priced_per_lane derives from the pricing vocabulary', () => {
  it('credit-denominated money means the provider quoted no per-lane price', () => {
    expect(pricedPerLane(CREDIT_CELLS)).toBe(false)
  })

  it('token-denominated money means it did', () => {
    expect(pricedPerLane(CELLS)).toBe(true)
  })

  it('the OPERAND is the denomination, not the provider/model NAME', () => {
    // Same model string, opposite denominations → opposite answers. A name-based
    // derivation cannot produce this pair, which is the point of the decision.
    const named = (creditPriced: boolean) => [
      cell({ model: 'gpt-5-codex', token_type: 'input', tokens: 10, cost_usd: 1, lane_priced: !creditPriced }),
    ]
    expect(pricedPerLane(named(true))).toBe(false)
    expect(pricedPerLane(named(false))).toBe(true)
    // …and a Claude-named row is not rescued by its name either: the flag
    // decides, in both directions.
    expect(pricedPerLane([cell({ model: 'claude-fable-5', cost_usd: 1, lane_priced: false })])).toBe(false)
  })

  it('a cell whose pricing was never read (null) is silent, not a claim', () => {
    // The rollup readers build cells from sources that never recorded it.
    // Null must not be read as "priced per token" — and must not out-vote a
    // cell that IS credit-priced.
    expect(pricedPerLane([cell({ lane_priced: null }), ...CREDIT_CELLS])).toBe(false)
  })

  /*
   * ── THE INVERSION (r6-A2) ──────────────────────────────────────────────────
   * The old derivation was `!cells.some(credit_priced === true)`: it asked for
   * evidence AGAINST a per-lane price and, finding none, asserted one. Every
   * unknown therefore resolved to the reassuring answer. These two cases are the
   * ones that flipped, and they are the whole reason the operand moved off
   * `credit_qty` (added by mig 0038 with no backfill, so NULL on all historical
   * Copilot money) and onto `rate_card_id`.
   */
  it('an unknown does NOT become a per-lane price on its own', () => {
    expect(pricedPerLane([cell({ lane_priced: null, cost_usd: 1 })])).toBe(false)
    // …and one unknown is enough to withdraw the claim from a card-priced scope:
    // the cells are one session's money, and half a per-lane price is not one.
    expect(pricedPerLane([...CELLS, cell({ lane_priced: null })])).toBe(false)
  })

  it('an empty scope makes no claim — no cells is no evidence', () => {
    expect(pricedPerLane([])).toBe(false)
  })
})

describe('T15 — the wire expresses "not priced" instead of fabricating zeros', () => {
  it('a credit-priced session ships NULL per lane — never a 0.00 string', () => {
    const view = sessionLaneView(CREDIT_CELLS)
    expect(view.priced_per_lane).toBe(false)

    expect(view.by_token_type).toHaveLength(4)
    for (const row of view.by_token_type) {
      expect(row.cost_usd).toBeNull()
      // The tokens — the quantity that IS measured — survive untouched.
      expect(row.tokens).toBeGreaterThan(0)
    }

    // The defect in one assertion: no lane may carry a money string at all, and
    // least of all the zero that reads as "this lane was free".
    const money = [...view.by_token_type, ...view.matrix].map((r) => r.cost_usd)
    expect(money).not.toContain('0.00')
    expect(money.every((m) => m === null)).toBe(true)
  })

  it('the shared shapes ACCEPT the null — the contract can say it', () => {
    const view = sessionLaneView(CREDIT_CELLS)
    for (const row of view.by_token_type) expect(SessionTokenTypeSpend.parse(row).cost_usd).toBeNull()
    for (const c of view.matrix) expect(SessionMatrixCell.parse(c).cost_usd).toBeNull()
  })

  it('a token-priced session is untouched: real money per lane, priced_per_lane true', () => {
    const view = sessionLaneView(CELLS)
    expect(view.priced_per_lane).toBe(true)
    expect(view.by_token_type).toEqual(pivotByTokenType(CELLS))
    expect(view.matrix).toEqual(toMatrix(CELLS))
    expect(view.by_token_type.every((r) => typeof r.cost_usd === 'string')).toBe(true)
    // A GENUINE measured zero stays a zero — "not priced" and "priced at zero"
    // must not collapse into each other.
    const withRealZero = [
      ...CELLS,
      cell({ model: 'claude-haiku-4-5', token_type: 'cache-write', tokens: 0, cost_usd: 0 }),
    ]
    const zeroed = sessionLaneView(withRealZero).by_token_type.find((r) => r.token_type === 'cache-write')!
    expect(zeroed.cost_usd).not.toBeNull()
  })

  it('cache savings are dropped, not fabricated, when there is no per-lane price', () => {
    // cacheStats reprices cache-read tokens at the model's effective INPUT rate.
    // On a carrier span input holds the WHOLE span total and cache-read holds 0,
    // so that subtraction prints a large invented saving…
    expect(cacheStats(CREDIT_CELLS).savings_usd).not.toBeNull()
    // …which the view refuses to ship.
    const view = sessionLaneView(CREDIT_CELLS)
    expect(view.cache.savings_usd).toBeNull()
    // Token quantities are measured, so they stay.
    expect(view.cache.read_tokens).toBe(900_000)
    expect(view.cache.hit_ratio).not.toBeNull()
  })
})
