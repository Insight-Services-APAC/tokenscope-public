// @vitest-environment node
/*
 * The BANDING half of `fetchTierExposure` — pure, no DB.
 *
 * The defect class this file exists to catch is a FAN-OUT. `model_catalog`
 * matches by SUBSTRING with a `sort_order` tie-break, so `gpt-5-mini` matches
 * BOTH the `gpt-5-mini` pattern (50, lightweight) and the `gpt-5` pattern (70,
 * frontier). A direct equijoin returns that row twice and every band total —
 * and the card headline — overstates the money. `buildTierExposure` resolves
 * each model through `resolveTier` before adding a dollar anywhere, so there is
 * no join to fan out; these tests are what hold that true.
 *
 * The catalog fixture is the REAL 0046 seed (`0046:138-146`), verbatim. A
 * hand-simplified catalog would not contain the overlapping pair the fan-out
 * needs, and the test would pass against an equijoin.
 */
import { describe, it, expect } from 'vitest'
import {
  buildTierExposure,
  type TierExposureFactRow,
} from '../../../../server/reporting/engine/tier-exposure'
import type { CatalogEntry } from '../../../../server/usage/insights'

/** The 0046 seed, verbatim — INCLUDING the overlapping gpt-5-mini / gpt-5 pair. */
const CATALOG: CatalogEntry[] = [
  { model_pattern: 'fable', tier: 'frontier', sort_order: 10 },
  { model_pattern: 'opus', tier: 'frontier', sort_order: 20 },
  { model_pattern: 'sonnet', tier: 'workhorse', sort_order: 30 },
  { model_pattern: 'haiku', tier: 'lightweight', sort_order: 40 },
  { model_pattern: 'gpt-5-mini', tier: 'lightweight', sort_order: 50 },
  { model_pattern: 'gpt-5 mini', tier: 'lightweight', sort_order: 51 },
  { model_pattern: 'gpt-4o', tier: 'workhorse', sort_order: 60 },
  { model_pattern: 'gpt-5', tier: 'frontier', sort_order: 70 },
]

const BOTH = new Set(['anthropic', 'github'])
const WINDOW = { from: '2026-06-01', to: '2026-06-02' }

function row(over: Partial<TierExposureFactRow> = {}): TierExposureFactRow {
  return {
    provider: 'anthropic',
    model: 'claude-opus-5',
    context_window: null,
    day: '2026-06-01',
    spend: '0',
    tokens: '0',
    token_rows: 0,
    interactions: '0',
    interaction_rows: 0,
    ...over,
  }
}

const arm = (out: ReturnType<typeof buildTierExposure>, provider: string) =>
  out.providers.find((p) => p.provider === provider)!
const band = (out: ReturnType<typeof buildTierExposure>, provider: string, id: string) =>
  arm(out, provider).bands.find((b) => b.band === id)!

describe('buildTierExposure — no fan-out on an overlapping catalog pattern', () => {
  it('counts a gpt-5-mini dollar EXACTLY once, in economy and not in frontier', () => {
    const out = buildTierExposure(
      [row({ model: 'gpt-5-mini', spend: '100.00', tokens: '900', token_rows: 1 })],
      CATALOG,
      BOTH,
      WINDOW,
    )
    const a = arm(out, 'anthropic')

    // The whole point: `gpt-5-mini` also contains `gpt-5`. An equijoin would put
    // $100 in economy AND $100 in frontier and total $200.
    expect(band(out, 'anthropic', 'economy').spendUsd).toBe(100)
    expect(band(out, 'anthropic', 'frontier').spendUsd).toBe(0)
    expect(a.bandedSpendUsd).toBe(100)
    expect(a.bands.reduce((s, b) => s + b.spendUsd, 0)).toBe(100)
    // And the tokens do not double either.
    expect(band(out, 'anthropic', 'economy').consumption).toBe(900)
    expect(a.totalConsumption).toBe(900)
  })

  it('resolves by LOWEST sort_order, so the more specific pattern wins', () => {
    // `gpt-5` on its own is frontier(70) — the same substring the mini row also
    // matched. If precedence were reversed, the previous test's dollar would
    // land here instead.
    const out = buildTierExposure(
      [row({ model: 'gpt-5', spend: '40.00' })],
      CATALOG,
      BOTH,
      WINDOW,
    )
    expect(band(out, 'anthropic', 'frontier').spendUsd).toBe(40)
    expect(band(out, 'anthropic', 'economy').spendUsd).toBe(0)
  })

  it('bands sum to the lane total across a mixed-model window', () => {
    const out = buildTierExposure(
      [
        row({ model: 'claude-opus-5', spend: '60.00' }),
        row({ model: 'claude-sonnet-5', spend: '25.00' }),
        row({ model: 'gpt-5-mini', spend: '10.00' }),
        row({ model: 'some-model-nobody-seeded', spend: '5.00' }),
        row({ model: null, spend: '2.50' }),
      ],
      CATALOG,
      BOTH,
      WINDOW,
    )
    const a = arm(out, 'anthropic')
    expect(a.bandedSpendUsd).toBeCloseTo(102.5, 6)
    expect(a.bands.reduce((s, b) => s + b.spendUsd, 0)).toBeCloseTo(102.5, 6)
    // And every band's share is over that same total, so the shares foot to 1.
    const shares = a.bands.map((b) => b.spendSharePct ?? 0).reduce((s, v) => s + v, 0)
    expect(shares).toBeCloseTo(1, 9)
  })
})

describe('buildTierExposure — unknown models are shown, never folded into economy', () => {
  it('puts an unseeded model in `unclassified`, with its money intact', () => {
    const out = buildTierExposure(
      [row({ model: 'gemini-3-ultra', spend: '75.00' })],
      CATALOG,
      BOTH,
      WINDOW,
    )
    expect(band(out, 'anthropic', 'unclassified').spendUsd).toBe(75)
    expect(band(out, 'anthropic', 'economy').spendUsd).toBe(0)
  })

  it('keeps `no-model` DISTINCT from `unclassified` — they are different facts', () => {
    const out = buildTierExposure(
      [
        row({ model: null, spend: '10.00' }),
        row({ model: 'gemini-3-ultra', spend: '20.00' }),
      ],
      CATALOG,
      BOTH,
      WINDOW,
    )
    // A record with no model at all is not "a model the catalog does not know":
    // merging them would tell an operator to add a catalog entry for a lane that
    // will never carry a model name.
    expect(band(out, 'anthropic', 'no-model').spendUsd).toBe(10)
    expect(band(out, 'anthropic', 'unclassified').spendUsd).toBe(20)
  })
})

describe('buildTierExposure — a band with no consumption SAYS SO rather than re-basing', () => {
  it('reports null consumption, and excludes the band from the volume denominator', () => {
    const out = buildTierExposure(
      [
        // Frontier: money AND tokens.
        row({ model: 'claude-opus-5', spend: '90.00' }),
        row({ model: 'claude-opus-5', tokens: '300', token_rows: 1 }),
        // No-model: money, and NO token row anywhere (the residual arm).
        row({ model: null, spend: '10.00' }),
      ],
      CATALOG,
      BOTH,
      WINDOW,
    )
    const a = arm(out, 'anthropic')
    const noModel = band(out, 'anthropic', 'no-model')

    // Not 0 — 0 would draw it in the volume bar at zero width and imply the work
    // moved no tokens rather than that nothing counted them.
    expect(noModel.consumption).toBeNull()
    expect(noModel.consumptionSharePct).toBeNull()
    // The money bar still carries it, at its true share.
    expect(noModel.spendSharePct).toBeCloseTo(0.1, 9)

    // The volume denominator is the COUNTED subset only...
    expect(a.totalConsumption).toBe(300)
    expect(band(out, 'anthropic', 'frontier').consumptionSharePct).toBe(1)
    // ...and the arm publishes how much money that subset covers, so the card can
    // state what the volume bar spans instead of implying it spans everything.
    expect(a.consumptionCoveredSpendUsd).toBe(90)
    expect(a.bandedSpendUsd).toBe(100)
  })

  it('distinguishes a band that consumed ZERO from one that was never counted', () => {
    const out = buildTierExposure(
      [
        row({ model: 'claude-opus-5', spend: '5.00', tokens: '0', token_rows: 1 }),
        row({ model: 'claude-sonnet-5', spend: '5.00' }),
      ],
      CATALOG,
      BOTH,
      WINDOW,
    )
    // A measured zero.
    expect(band(out, 'anthropic', 'frontier').consumption).toBe(0)
    // Never measured.
    expect(band(out, 'anthropic', 'mid').consumption).toBeNull()
  })
})

describe('buildTierExposure — a mix-only provider never has its money banded', () => {
  it('carries Copilot credits whole, with zero in every band', () => {
    const out = buildTierExposure(
      [
        // The wire shape says a github COST row cannot carry a model (credits sit
        // at the record root). Even given one, the arm must not band it.
        row({ provider: 'github', model: 'gpt-5-mini', spend: '250.00' }),
        row({ provider: 'github', model: 'gpt-5-mini', interactions: '80', interaction_rows: 1 }),
        row({ provider: 'github', model: 'gpt-4o', interactions: '20', interaction_rows: 1 }),
      ],
      CATALOG,
      BOTH,
      WINDOW,
    )
    const g = arm(out, 'github')

    expect(g.kind).toBe('mix-only')
    expect(g.unit).toBe('interactions')
    expect(g.bandedSpendUsd).toBe(0)
    expect(g.bands.every((b) => b.spendUsd === 0)).toBe(true)
    // The money is reported WHOLE, and the clause states the CONSEQUENCE (there is
    // no split to ask for) rather than the metering mechanism that causes it —
    // "ai_credits_used sits at the record root" is this module's business.
    expect(g.unbandedSpendUsd).toBe(250)
    expect(g.unbandedNote).toMatch(/no model split/i)
    expect(g.unbandedNote).not.toMatch(/ai_credits_used/)

    // The MIX is by activity — 80/20 — and is never used to split the credits.
    expect(band(out, 'github', 'economy').consumptionSharePct).toBeCloseTo(0.8, 9)
    expect(band(out, 'github', 'mid').consumptionSharePct).toBeCloseTo(0.2, 9)
    // Share of MONEY is null, not 0%: the arm bands no money to take a share of.
    expect(band(out, 'github', 'economy').spendSharePct).toBeNull()
  })
})

describe('buildTierExposure — `no-data-yet` is not a zero', () => {
  it('marks a provider that has NEVER written to the lane', () => {
    const out = buildTierExposure(
      [row({ model: 'claude-opus-5', spend: '10.00' })],
      CATALOG,
      new Set(['anthropic']), // github has no row in provider_usage_fact, ever
      WINDOW,
    )
    expect(arm(out, 'github').availability).toBe('no-data-yet')
    expect(arm(out, 'anthropic').availability).toBe('ok')
  })

  it('marks a provider present in the lane but absent from THIS window as `ok`', () => {
    // The distinction that matters: this scope/window genuinely spent nothing on
    // github, which is a fact about spending — not about a missing adapter.
    const out = buildTierExposure([], CATALOG, BOTH, WINDOW)
    expect(arm(out, 'github').availability).toBe('ok')
    expect(arm(out, 'github').bandedSpendUsd).toBe(0)
    expect(arm(out, 'github').unbandedSpendUsd).toBe(0)
  })

  it('always emits an arm per known provider, so a missing adapter is stated', () => {
    const out = buildTierExposure([], CATALOG, new Set(), WINDOW)
    expect(out.providers.map((p) => p.provider)).toEqual(['anthropic', 'github'])
  })
})

describe('buildTierExposure — the series', () => {
  it('omits a (day, band) with neither money nor a count — a gap, not a zero', () => {
    const out = buildTierExposure(
      [
        row({ model: 'claude-opus-5', day: '2026-06-01', spend: '10.00' }),
        row({ model: 'claude-sonnet-5', day: '2026-06-02', spend: '5.00' }),
      ],
      CATALOG,
      BOTH,
      WINDOW,
    )
    const s = arm(out, 'anthropic').series
    expect(s).toEqual([
      { day: '2026-06-01', band: 'frontier', spendUsd: 10, consumption: null },
      { day: '2026-06-02', band: 'mid', spendUsd: 5, consumption: null },
    ])
  })

  it('sums back to the period bands, so the bars and the trend cannot disagree', () => {
    const out = buildTierExposure(
      [
        row({ model: 'claude-opus-5', day: '2026-06-01', spend: '10.00' }),
        row({ model: 'claude-opus-5', day: '2026-06-02', spend: '15.00' }),
        row({ model: 'gpt-5-mini', day: '2026-06-02', spend: '4.00' }),
      ],
      CATALOG,
      BOTH,
      WINDOW,
    )
    const a = arm(out, 'anthropic')
    for (const b of a.bands) {
      const fromSeries = a.series
        .filter((c) => c.band === b.band)
        .reduce((s, c) => s + c.spendUsd, 0)
      expect(fromSeries).toBeCloseTo(b.spendUsd, 9)
    }
  })

  it('does not double a model that appears on two days', () => {
    const out = buildTierExposure(
      [
        row({ model: 'gpt-5-mini', day: '2026-06-01', spend: '7.00' }),
        row({ model: 'gpt-5-mini', day: '2026-06-02', spend: '7.00' }),
      ],
      CATALOG,
      BOTH,
      WINDOW,
    )
    expect(band(out, 'anthropic', 'economy').spendUsd).toBe(14)
    expect(arm(out, 'anthropic').bandedSpendUsd).toBe(14)
  })
})

describe('buildTierExposure — the context-window exposure (W0a D6, T6)', () => {
  /*
   * MUTATION: drop the ctxBands accumulation (or the `contextWindow` field
   * from the arm) — bands come back empty / undefined and every assertion
   * below goes red.
   */
  it('bands money and tokens by the provider-reported band, shares included', () => {
    const out = buildTierExposure(
      [
        row({ model: 'claude-opus-5', context_window: '0-200k', spend: '75.00' }),
        row({ model: 'claude-opus-5', context_window: '200k+', spend: '25.00' }),
        row({ model: 'claude-opus-5', context_window: '0-200k', tokens: '900', token_rows: 1 }),
        row({ model: 'claude-opus-5', context_window: '200k+', tokens: '100', token_rows: 1 }),
      ],
      CATALOG,
      BOTH,
      WINDOW,
    )
    const ctx = arm(out, 'anthropic').contextWindow!
    // Sorted small-window first — the provider's own vocabulary, verbatim.
    expect(ctx.bands.map((b) => b.band)).toEqual(['0-200k', '200k+'])
    expect(ctx.bands.map((b) => b.spendUsd)).toEqual([75, 25])
    expect(ctx.bands[0]!.spendSharePct).toBeCloseTo(0.75, 9)
    expect(ctx.bands[1]!.spendSharePct).toBeCloseTo(0.25, 9)
    expect(ctx.bands.map((b) => b.tokens)).toEqual([900, 100])
    expect(ctx.bands[0]!.tokensSharePct).toBeCloseTo(0.9, 9)
    expect(ctx.bandedSpendUsd).toBe(100)
    expect(ctx.unbandedSpendUsd).toBe(0)
    expect(ctx.unbandedReason).toBeNull()
  })

  /*
   * MUTATION: fold NULL-band money into a band (or default the reason away) —
   * the remainder disappears into '0-200k' and both assertions go red.
   */
  it('types NULL-band money as the before-collection remainder, never a band', () => {
    const out = buildTierExposure(
      [
        row({ model: 'claude-opus-5', context_window: '0-200k', spend: '60.00' }),
        row({ model: 'claude-opus-5', context_window: null, spend: '40.00' }),
      ],
      CATALOG,
      BOTH,
      WINDOW,
    )
    const a = arm(out, 'anthropic')
    const ctx = a.contextWindow!
    expect(ctx.bands.map((b) => b.band)).toEqual(['0-200k'])
    expect(ctx.unbandedSpendUsd).toBe(40)
    expect(ctx.unbandedReason).toBe('before-collection')
    // Both partitions of the same cost rows foot to the arm's banded total.
    expect(ctx.bandedSpendUsd + ctx.unbandedSpendUsd).toBeCloseTo(a.bandedSpendUsd, 9)
  })

  it('an unknown band string is a band, never dropped or normalised', () => {
    const out = buildTierExposure(
      [row({ model: 'claude-opus-5', context_window: '1m+', spend: '5.00' })],
      CATALOG,
      BOTH,
      WINDOW,
    )
    const ctx = arm(out, 'anthropic').contextWindow!
    expect(ctx.bands.map((b) => b.band)).toEqual(['1m+'])
    expect(ctx.bands[0]!.spendUsd).toBe(5)
  })

  /*
   * MUTATION: emit a leg for every arm — github grows an all-remainder leg
   * that files Copilot's dimension-less credits under "before collection
   * began", and the null expectation goes red.
   */
  it('a mix-only arm carries NO leg — no dimension on the wire is not "un-banded"', () => {
    const out = buildTierExposure(
      [row({ provider: 'github', model: null, spend: '250.00' })],
      CATALOG,
      BOTH,
      WINDOW,
    )
    expect(arm(out, 'github').contextWindow).toBeNull()
    expect(arm(out, 'anthropic').contextWindow).not.toBeNull()
  })

  it('the tier bands are unchanged by the finer context grain (same money, split rows)', () => {
    const split = buildTierExposure(
      [
        row({ model: 'claude-opus-5', context_window: '0-200k', spend: '75.00' }),
        row({ model: 'claude-opus-5', context_window: '200k+', spend: '25.00' }),
      ],
      CATALOG,
      BOTH,
      WINDOW,
    )
    expect(band(split, 'anthropic', 'frontier').spendUsd).toBe(100)
    expect(arm(split, 'anthropic').bandedSpendUsd).toBe(100)
  })
})

describe('the uncollected-exposure constant is GONE (T6, grep half)', () => {
  it('shared/reports/tier-exposure.ts no longer exports the ghost constant', async () => {
    const shared = await import('../../../../shared/reports/tier-exposure')
    expect('UNCOLLECTED_EXPOSURES' in shared).toBe(false)
  })
})

describe('buildTierExposure — an unknown provider is banded, never dropped', () => {
  it('keeps a third provider’s money inside the sum-back invariant', () => {
    const out = buildTierExposure(
      [row({ provider: 'mistral', model: 'claude-opus-5', spend: '12.00' })],
      CATALOG,
      new Set(['anthropic', 'github', 'mistral']),
      WINDOW,
    )
    const m = arm(out, 'mistral')
    // Dropping it would break "bands sum to the lane total" SILENTLY, which is
    // worse than banding it under the default assumption and saying so.
    expect(m.kind).toBe('cost-and-tokens')
    expect(m.bandedSpendUsd).toBe(12)
    // Known providers still lead the ordering, so the card's arms are stable.
    expect(out.providers.map((p) => p.provider)).toEqual(['anthropic', 'github', 'mistral'])
  })
})
