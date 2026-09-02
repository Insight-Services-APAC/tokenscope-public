// @vitest-environment node
/*
 * Insights engine — every detector's trigger boundary, every guard, and the
 * estimate formulas (brief §4.2). Pure core, no DB.
 */
import { describe, it, expect } from 'vitest'
import {
  blendedCostPerTurn,
  compoundSavings,
  detectFindings,
  resolveTier,
  THRESHOLDS,
  type CatalogEntry,
  type InsightCell,
  type RateLineLite,
  type SignalCell,
} from '../../../server/usage/insights'

const CATALOG: CatalogEntry[] = [
  { model_pattern: 'fable', tier: 'frontier', sort_order: 10 },
  { model_pattern: 'opus', tier: 'frontier', sort_order: 20 },
  { model_pattern: 'sonnet', tier: 'workhorse', sort_order: 30 },
  { model_pattern: 'haiku', tier: 'lightweight', sort_order: 40 },
]

// Wildcard card matching the seeded defaults ($/Mtok: 3 in, 15 out, 0.3 cr, 3.75 cw).
const WILDCARD_LINES: RateLineLite[] = [
  { unit: 'input', model: null, unit_qty: 1_000_000, unit_cost_usd: 3 },
  { unit: 'output', model: null, unit_qty: 1_000_000, unit_cost_usd: 15 },
  { unit: 'cache-read', model: null, unit_qty: 1_000_000, unit_cost_usd: 0.3 },
  { unit: 'cache-write', model: null, unit_qty: 1_000_000, unit_cost_usd: 3.75 },
]

const cell = (over: Partial<InsightCell>): InsightCell => ({
  day: '2026-06-01',
  tool: 'claude-code',
  model: 'claude-fable-5',
  token_type: 'input',
  query_source: 'main',
  tokens: 0,
  cost_usd: 0,
  ...over,
})

const byId = (cells: InsightCell[], lines = WILDCARD_LINES) =>
  new Map(detectFindings(cells, CATALOG, lines).map((f) => [f.id, f]))

describe('resolveTier', () => {
  it('substring-matches with sort_order tie-break; unknown → null', () => {
    expect(resolveTier('claude-fable-5', CATALOG)).toBe('frontier')
    expect(resolveTier('us.anthropic.claude-sonnet-4-6', CATALOG)).toBe('workhorse')
    expect(resolveTier('claude-3-5-haiku-20241022', CATALOG)).toBe('lightweight')
    expect(resolveTier('mystery-model-x', CATALOG)).toBeNull()
  })
})

describe('compoundSavings (AEUF port)', () => {
  it('compounds multiplicatively, not additively', () => {
    expect(compoundSavings([0.3, 0.15])).toBeCloseTo(0.405, 6)
    expect(compoundSavings([])).toBe(0)
    expect(compoundSavings([1.5])).toBe(1) // clamped
  })
})

describe('blendedCostPerTurn', () => {
  it('5k in / 1k out / 40% cached over the rate lines', () => {
    // 3000×3e-6 + 2000×0.3e-6 + 1000×15e-6 = 0.0096 + 0.0006 + 0.015
    expect(blendedCostPerTurn(WILDCARD_LINES, 'any')).toBeCloseTo(0.0246, 6)
  })
  it('null when the card lacks rates', () => {
    expect(blendedCostPerTurn([], 'any')).toBeNull()
  })
})

describe('cache-hit-starvation', () => {
  const mk = (input: number, cacheRead: number) => [
    cell({ token_type: 'input', tokens: input, cost_usd: (input / 1e6) * 3 }),
    cell({ token_type: 'cache-read', tokens: cacheRead, cost_usd: (cacheRead / 1e6) * 0.3 }),
    // a second model keeps concentration out of the picture
    cell({ model: 'claude-haiku-4-5', token_type: 'output', tokens: 1000, cost_usd: 30 }),
  ]

  it('fires just under the ratio threshold with enough volume', () => {
    // 24% hit on 2.5M prompt tokens
    const f = byId(mk(1_900_000, 600_000)).get('cache-hit-starvation')!
    expect(f).toBeDefined()
    expect(f.evidence.cache_hit_ratio).toBeCloseTo(0.24, 2)
    expect(f.related_levers).toEqual(['R2', 'R3'])
    // moved = (0.5 − 0.24) × 2.5M; × (3 − 0.3)/Mtok × 0.5 × 30/28
    const moved = (0.5 - 0.24) * 2_500_000
    const expected = ((moved * 2.7) / 1e6) * 0.5 * (30 / 28)
    expect(Number(f.estimated_monthly_savings_usd)).toBeCloseTo(expected, 1)
  })

  it('silent at/above the ratio threshold or under the volume floor', () => {
    expect(byId(mk(1_500_000, 500_000)).get('cache-hit-starvation')).toBeUndefined() // 25% exactly
    expect(byId(mk(190_000, 60_000)).get('cache-hit-starvation')).toBeUndefined() // <2M tokens
  })
})

describe('cache-write-churn', () => {
  const mk = (write: number, read: number) => [
    cell({ token_type: 'cache-write', tokens: write, cost_usd: (write / 1e6) * 3.75 }),
    cell({ token_type: 'cache-read', tokens: read, cost_usd: (read / 1e6) * 0.3 }),
  ]

  it('fires when writes exceed 1.5× reads on ≥2M cache tokens', () => {
    const f = byId(mk(2_000_000, 500_000)).get('cache-write-churn')!
    expect(f).toBeDefined()
    // justified = 0.25 → estimate = writeCost(7.5) × 0.75 × 0.5 × 30/28
    expect(Number(f.estimated_monthly_savings_usd)).toBeCloseTo(7.5 * 0.75 * 0.5 * (30 / 28), 2)
    expect(f.related_levers).toContain('R6')
  })

  it('silent at the boundary (write == 1.5×read) and under volume', () => {
    expect(byId(mk(1_500_000, 1_000_000)).get('cache-write-churn')).toBeUndefined()
    expect(byId(mk(1_500_000, 100_000)).get('cache-write-churn')).toBeUndefined() // 1.6M < 2M
  })
})

describe('frontier-overreliance', () => {
  const mk = (frontierUsd: number, workhorseUsd: number, unknownUsd = 0) => [
    cell({ model: 'claude-fable-5', cost_usd: frontierUsd, tokens: 1 }),
    cell({ model: 'claude-sonnet-4-6', cost_usd: workhorseUsd, tokens: 1 }),
    ...(unknownUsd > 0 ? [cell({ model: 'mystery-x', cost_usd: unknownUsd, tokens: 1 })] : []),
  ]

  it('fires above 80% frontier share at ≥$50 with wildcard fallback ratio', () => {
    const f = byId(mk(81, 19)).get('frontier-overreliance')!
    expect(f).toBeDefined()
    expect(f.evidence.frontier_share).toBeCloseTo(0.81, 4)
    // wildcard card → identical blended turns → list-ratio fallback 0.2
    expect(f.evidence.rate_ratio).toBeCloseTo(THRESHOLDS.LIST_RATIO_FALLBACK, 4)
    expect(Number(f.estimated_monthly_savings_usd)).toBeCloseTo(81 * 0.8 * 0.5 * (30 / 28), 1)
  })

  it('uses the real rate ratio when the card has model-specific lines', () => {
    const lines: RateLineLite[] = [
      ...WILDCARD_LINES,
      { unit: 'input', model: 'claude-fable-5', unit_qty: 1_000_000, unit_cost_usd: 15 },
      { unit: 'output', model: 'claude-fable-5', unit_qty: 1_000_000, unit_cost_usd: 75 },
      { unit: 'cache-read', model: 'claude-fable-5', unit_qty: 1_000_000, unit_cost_usd: 1.5 },
    ]
    const f = byId(mk(81, 19), lines).get('frontier-overreliance')!
    expect(f.evidence.estimate_method).toContain('blended $/turn')
    expect(Number(f.evidence.rate_ratio)).toBeLessThan(0.25)
  })

  it('guards: silent at the share boundary, under the spend floor, and under 50% classified', () => {
    expect(byId(mk(80, 20)).get('frontier-overreliance')).toBeUndefined() // exactly 80%
    expect(byId(mk(40, 9)).get('frontier-overreliance')).toBeUndefined() // $49 total
    expect(byId(mk(45, 4, 51)).get('frontier-overreliance')).toBeUndefined() // 49% classified
  })

  /*
   * DEGENERATE DENOMINATOR. `frontier_share` divides by classified spend, so an
   * unclassifiable window (empty/unseeded model_catalog) would divide by zero and
   * the finding would describe the CATALOG, not the teammate.
   *
   * RED ON REVERT: this is defence in depth, so it goes red only when BOTH the
   * positive `classified <= 0` refusal AND FRONTIER_MIN_CLASSIFIED_RATIO's guard
   * are removed (verified: the detector then fires on a NaN share). The positive
   * refusal exists so the invariant does not rest on a threshold constant that a
   * later tuning pass could set to 0.
   */
  it('publishes NOTHING when the catalog classifies no model', () => {
    expect(
      new Map(
        detectFindings(mk(81, 19), [], WILDCARD_LINES).map((f) => [f.id, f]),
      ).get('frontier-overreliance'),
    ).toBeUndefined()
  })
})

describe('model-concentration', () => {
  it('fires on >90% single-model share with ≤2 distinct models and ≥$50', () => {
    const f = byId([
      cell({ model: 'claude-fable-5', cost_usd: 95, tokens: 1 }),
      cell({ model: 'claude-haiku-4-5', cost_usd: 4, tokens: 1 }),
    ]).get('model-concentration')!
    expect(f).toBeDefined()
    expect(f.estimated_monthly_savings_usd).toBeNull() // informational
  })

  it('silent with 3 distinct models or at the share boundary', () => {
    expect(
      byId([
        cell({ model: 'claude-fable-5', cost_usd: 95, tokens: 1 }),
        cell({ model: 'claude-haiku-4-5', cost_usd: 3, tokens: 1 }),
        cell({ model: 'claude-sonnet-4-6', cost_usd: 2, tokens: 1 }),
      ]).get('model-concentration'),
    ).toBeUndefined()
    expect(
      byId([
        cell({ model: 'claude-fable-5', cost_usd: 90, tokens: 1 }),
        cell({ model: 'claude-haiku-4-5', cost_usd: 10, tokens: 1 }),
      ]).get('model-concentration'),
    ).toBeUndefined()
  })
})

describe('aux-overhead', () => {
  const mk = (main: number, aux: number, unknown = 0) => [
    cell({ query_source: 'main', tokens: main, cost_usd: 1 }),
    cell({ query_source: 'compact', tokens: aux, cost_usd: 2 }),
    ...(unknown > 0 ? [cell({ query_source: null, tokens: unknown, cost_usd: 5 })] : []),
  ]

  it('fires above 15% aux share on ≥1M known tokens', () => {
    const f = byId(mk(800_000, 200_000)).get('aux-overhead')!
    expect(f).toBeDefined()
    expect(f.evidence.aux_share).toBeCloseTo(0.2, 4)
    // estimate = auxCost(2) × (0.05/0.2) × 30/28
    expect(Number(f.estimated_monthly_savings_usd)).toBeCloseTo(2 * 0.25 * (30 / 28), 2)
  })

  it('NULL query_source rows are excluded — legacy data cannot fabricate a finding', () => {
    // Known lanes are only 900k (under the 1M floor) once NULL is excluded.
    expect(byId(mk(750_000, 150_000, 10_000_000)).get('aux-overhead')).toBeUndefined()
  })

  it('silent at the share boundary', () => {
    expect(byId(mk(850_000, 150_000)).get('aux-overhead')).toBeUndefined() // exactly 15%
  })

  /*
   * THE LIVE DEFECT. Claude Code emits `repl_main_thread`, never the word
   * `main`, so the conversation lane counted as harness overhead: 16.9B tokens,
   * `main_tokens: 0`, `aux_share: 1`, and a $12,200/month recommendation.
   *
   * RED ON REVERT: restore `c.query_source === 'main'` in detectAuxOverhead and
   * this goes red — the finding reappears at 100%.
   */
  it("counts Claude Code's real conversation tokens as MAIN, not overhead", () => {
    const claude = [
      cell({ query_source: 'repl_main_thread', tokens: 800_000, cost_usd: 1 }),
      cell({ query_source: 'repl_main_thread:outputStyle:Concise', tokens: 500_000, cost_usd: 1 }),
      cell({ query_source: 'agent:custom', tokens: 500_000, cost_usd: 1 }),
      cell({ query_source: 'sdk', tokens: 200_000, cost_usd: 1 }),
      cell({ query_source: 'compact', tokens: 1_000_000, cost_usd: 8 }),
    ]
    const f = byId(claude).get('aux-overhead')!
    expect(f).toBeDefined()
    expect(f.evidence.main_tokens).toBe(2_000_000)
    expect(f.evidence.aux_tokens).toBe(1_000_000)
    expect(f.evidence.aux_share).toBeCloseTo(1 / 3, 4)
  })

  /*
   * DEGENERATE DENOMINATOR. `aux_share` = aux/(main+aux) is exactly 1 whenever
   * the main lane is empty, whatever the aux volume. "We have no conversation
   * -lane signal" is not the finding "100% of your volume is overhead", and an
   * insight that cannot tell them apart must not publish a savings estimate.
   *
   * RED ON REVERT: drop the AUX_MIN_MAIN_TOKENS guard from detectAuxOverhead
   * and both cases below go red.
   */
  it('publishes NOTHING when the main lane is empty (main = 0, aux > 0)', () => {
    const degenerate = [cell({ query_source: 'compact', tokens: 16_888_592_916, cost_usd: 13_396.81 })]
    expect(byId(degenerate).get('aux-overhead')).toBeUndefined()
  })

  it('publishes NOTHING when the main lane is below the denominator floor', () => {
    const nearlyDegenerate = [
      cell({ query_source: 'repl_main_thread', tokens: THRESHOLDS.AUX_MIN_MAIN_TOKENS - 1, cost_usd: 1 }),
      cell({ query_source: 'compact', tokens: 5_000_000, cost_usd: 40 }),
    ]
    expect(byId(nearlyDegenerate).get('aux-overhead')).toBeUndefined()
  })

  it('still fires on a GENUINE high-aux window once the main lane is real', () => {
    const genuine = [
      cell({ query_source: 'repl_main_thread', tokens: 2_000_000, cost_usd: 10 }),
      cell({ query_source: 'compact', tokens: 6_000_000, cost_usd: 40 }),
    ]
    const f = byId(genuine).get('aux-overhead')!
    expect(f).toBeDefined()
    expect(f.evidence.main_tokens).toBe(2_000_000)
    expect(f.evidence.aux_share).toBeCloseTo(0.75, 4)
    expect(Number(f.estimated_monthly_savings_usd)).toBeGreaterThan(0)
  })
})

// ── Copilot behavioural-signal detectors (mig 0065) ──────────────────────────

const sigCell = (over: Partial<SignalCell>): SignalCell => ({
  tool: 'copilot-cli',
  signal_name: 'tool_count',
  sample_count: 50,
  sum_value: 0,
  min_value: 0,
  max_value: 0,
  ...over,
})
// avg = sum/count → set sum = avg × count for a target average.
const withAvg = (over: Partial<SignalCell> & { avg: number }): SignalCell => {
  const { avg, ...rest } = over
  const count = rest.sample_count ?? 50
  return sigCell({ ...rest, sample_count: count, sum_value: avg * count })
}
const sigById = (signalCells: SignalCell[]) =>
  new Map(detectFindings([], CATALOG, WILDCARD_LINES, signalCells).map((f) => [f.id, f]))

describe('tool-surface-bloat', () => {
  it('fires on high avg tool_count (informational, lever R7)', () => {
    const f = sigById([withAvg({ signal_name: 'tool_count', avg: 35, max_value: 41 })]).get('tool-surface-bloat')!
    expect(f).toBeDefined()
    expect(f.severity).toBe('low')
    expect(f.estimated_monthly_savings_usd).toBeNull()
    expect(f.related_levers).toEqual(['R7'])
    expect(f.evidence.avg_tool_count).toBeCloseTo(35, 1)
  })
  it('fires on high avg mcp_count alone', () => {
    expect(sigById([withAvg({ signal_name: 'mcp_count', avg: 8 })]).get('tool-surface-bloat')).toBeDefined()
  })
  it('silent below the tool threshold', () => {
    expect(sigById([withAvg({ signal_name: 'tool_count', avg: 20 })]).get('tool-surface-bloat')).toBeUndefined()
  })
  it('silent below the min-sample floor (too little data)', () => {
    expect(
      sigById([withAvg({ signal_name: 'tool_count', avg: 40, sample_count: 5 })]).get('tool-surface-bloat'),
    ).toBeUndefined()
  })
})

describe('context-saturation', () => {
  it('fires when BOTH peak and average are high (lever R2)', () => {
    const f = sigById([withAvg({ signal_name: 'ctx_pct', avg: 70, max_value: 96 })]).get('context-saturation')!
    expect(f).toBeDefined()
    expect(f.related_levers).toEqual(['R2'])
    expect(f.evidence.max_ctx_pct).toBe(96)
    expect(f.estimated_monthly_savings_usd).toBeNull()
  })
  it('silent when peak is high but average is low (single outlier)', () => {
    expect(sigById([withAvg({ signal_name: 'ctx_pct', avg: 30, max_value: 96 })]).get('context-saturation')).toBeUndefined()
  })
  it('silent when average is high but peak never crosses the ceiling', () => {
    expect(sigById([withAvg({ signal_name: 'ctx_pct', avg: 70, max_value: 85 })]).get('context-saturation')).toBeUndefined()
  })
  it('an out-of-range max still FIRES (keys off raw value) but DISPLAYS clamped at 100', () => {
    // A hand-inserted/backfilled row could exceed 100; firing keys off raw ctx.max,
    // the displayed figure is clamped so the headline never claims >100%.
    const f = sigById([withAvg({ signal_name: 'ctx_pct', avg: 95, max_value: 140 })]).get('context-saturation')!
    expect(f).toBeDefined()
    expect(f.evidence.max_ctx_pct).toBe(100)
    expect(f.headline).not.toMatch(/140/)
  })
})

describe('turn-churn', () => {
  it('fires on high avg turn_count (lever R8, informational)', () => {
    const f = sigById([withAvg({ signal_name: 'turn_count', avg: 11, max_value: 22, sample_count: 30 })]).get('turn-churn')!
    expect(f).toBeDefined()
    expect(f.related_levers).toEqual(['R8'])
    expect(f.evidence.avg_turn_count).toBeCloseTo(11, 1)
    expect(f.estimated_monthly_savings_usd).toBeNull()
  })
  it('silent below the churn threshold', () => {
    expect(sigById([withAvg({ signal_name: 'turn_count', avg: 4, sample_count: 30 })]).get('turn-churn')).toBeUndefined()
  })
})

describe('signal detectors integrate with the token findings', () => {
  it('signal findings (low) sort AFTER a $-bearing token medium', () => {
    const findings = detectFindings(
      [
        cell({ model: 'claude-fable-5', cost_usd: 500, tokens: 1 }),
        cell({ model: 'claude-sonnet-4-6', cost_usd: 50, tokens: 1 }),
      ],
      CATALOG,
      WILDCARD_LINES,
      [withAvg({ signal_name: 'tool_count', avg: 40, max_value: 50 })],
    )
    const ids = findings.map((f) => f.id)
    expect(ids).toContain('tool-surface-bloat')
    // a medium token finding outranks the informational signal finding
    const firstMediumIdx = findings.findIndex((f) => f.severity === 'medium')
    const sigIdx = ids.indexOf('tool-surface-bloat')
    expect(firstMediumIdx).toBeLessThan(sigIdx)
  })
})

describe('detectFindings ordering', () => {
  it('medium severity first, then estimate desc', () => {
    const findings = detectFindings(
      [
        // big frontier overreliance (medium) + tiny concentration companion is
        // suppressed (3 models), cache starvation low volume — craft two firing
        cell({ model: 'claude-fable-5', cost_usd: 500, tokens: 1 }),
        cell({ model: 'claude-sonnet-4-6', cost_usd: 50, tokens: 1 }),
        cell({ token_type: 'cache-write', tokens: 3_000_000, cost_usd: 11.25 }),
        cell({ token_type: 'cache-read', tokens: 100_000, cost_usd: 0.03 }),
      ],
      CATALOG,
      WILDCARD_LINES,
    )
    expect(findings.length).toBeGreaterThanOrEqual(2)
    const sevRank = findings.map((f) => f.severity)
    expect([...sevRank].sort((a, b) => (a === b ? 0 : a === 'medium' ? -1 : 1))).toEqual(sevRank)
  })
})
