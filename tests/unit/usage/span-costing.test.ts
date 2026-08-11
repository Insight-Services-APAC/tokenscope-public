// @vitest-environment node
/*
 * Pure span-costing arithmetic — docs/design/provider-cost-precedence.md.
 *
 * These are the invariants the whole design rests on. If any of them slips,
 * every project figure, budget, rollup and chargeback number stops being
 * exactly the provider's number:
 *
 *   1. Σ(row costs) === the span total, EXACTLY, for every input.
 *   2. No row is ever negative.
 *   3. Deterministic AND order-independent (the KQL has no ORDER BY).
 *
 * Plus the enumerated edge cases: a single row; all-equal remainders; a span
 * total smaller than the number of rows in minor units; a zero rate-card
 * estimate for one row but not the others.
 */
import { describe, it, expect } from 'vitest'
import {
  COST_DECIMALS,
  MAX_COST_MICROS,
  MICROS_PER_USD,
  TOKEN_TYPE_PRIORITY,
  tokenTypePriority,
  pickCarrierTokenType,
  usdToMicros,
  microsToUsd,
  decideCostingRung,
  allocateByLargestRemainder,
  planSpanCosting,
  replanAgainstBooked,
  emptyCostingRungCounts,
  tallySpanPlan,
  type AllocationRow,
  type SpanRow,
} from '../../../server/usage/span-costing'

const row = (key: string, weightMicros: bigint, rank = 0): AllocationRow => ({
  key,
  weightMicros,
  rank,
})

const sum = (rows: ReadonlyArray<{ costMicros: bigint }>) =>
  rows.reduce((acc, r) => acc + r.costMicros, 0n)

/** Deterministic LCG — a seeded property sweep must be reproducible in CI. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
}

describe('usdToMicros / microsToUsd', () => {
  it('round-trips the 6-decimal values the numeric(14,6) column stores', () => {
    for (const s of ['0.000000', '0.012300', '3.000000', '99999999.999999', '0.000001']) {
      expect(microsToUsd(usdToMicros(s)!)).toBe(s)
    }
  })

  it('parses a double without float drift at 6 dp', () => {
    // 0.1 + 0.2 === 0.30000000000000004 as a double. At the precision the
    // column stores, that IS 0.300000 — and must not become 0.300001 or
    // 0.299999 on the way in.
    expect(usdToMicros(0.1 + 0.2)).toBe(300_000n)
    expect(usdToMicros(0.0123)).toBe(12_300n)
    expect(usdToMicros(1e-6)).toBe(1n)
  })

  it('rounds half-up on magnitude when the input carries more precision than we store', () => {
    expect(usdToMicros('0.0000005')).toBe(1n)
    expect(usdToMicros('0.0000004')).toBe(0n)
    expect(usdToMicros('-0.0000005')).toBe(-1n)
    // A value below half a micro is ZERO at column precision, not a tiny cost.
    expect(usdToMicros(4e-7)).toBe(0n)
  })

  it('returns null (never 0) for anything unusable', () => {
    expect(usdToMicros(Number.NaN)).toBeNull()
    expect(usdToMicros(Number.POSITIVE_INFINITY)).toBeNull()
    expect(usdToMicros(undefined)).toBeNull()
    expect(usdToMicros(null)).toBeNull()
    expect(usdToMicros('')).toBeNull()
    expect(usdToMicros('abc')).toBeNull()
    // Exponent form is deliberately rejected rather than guessed at.
    expect(usdToMicros('1e-7')).toBeNull()
    expect(usdToMicros(1e21)).toBeNull()
  })

  it('formats negatives and preserves the 6-decimal shape', () => {
    expect(microsToUsd(-1n)).toBe('-0.000001')
    expect(microsToUsd(0n)).toBe('0.000000')
    expect(MICROS_PER_USD).toBe(1_000_000n)
    expect(COST_DECIMALS).toBe(6)
  })

  it('ROUND-TRIPS the extremes of numeric(14,6): max, min, and one micro either way', () => {
    // The boundary values themselves, both directions, exactly. A drift of one
    // digit in either function is invisible on ordinary amounts and catastrophic
    // here, which is precisely why the extremes are pinned rather than sampled.
    const cases: [bigint, string][] = [
      [MAX_COST_MICROS, '99999999.999999'],
      [-MAX_COST_MICROS, '-99999999.999999'],
      [1n, '0.000001'],
      [-1n, '-0.000001'],
      [0n, '0.000000'],
    ]
    for (const [micros, text] of cases) {
      expect(microsToUsd(micros)).toBe(text)
      expect(usdToMicros(text)).toBe(micros)
      expect(usdToMicros(microsToUsd(micros)!)).toBe(micros)
    }
    // The constant IS the column: NUMERIC(14,6) = 8 integer digits + 6 decimals
    // (drizzle/migrations/0001_schema.sql:185).
    expect(MAX_COST_MICROS).toBe(99_999_999_999_999n)
  })

  it('REJECTS a figure the numeric(14,6) column cannot store — storability, not plausibility', () => {
    /*
     * This is NOT the plausibility band the design removed (see the
     * decideCostingRung suite below, which pins that there is none). It is the
     * database's own limit: NUMERIC(14,6) tops out at 99999999.999999, so a
     * provider figure anywhere in [1e8, 1e21) — an upstream units bug, a cost
     * reported in cents, a corrupted attribute — used to pass every guard and
     * then throw `numeric field overflow` at the INSERT. The joiner's
     * per-session try/catch swallows that throw and retries the SAME session on
     * every following tick, so one poisoned span would durably block attribution
     * for that whole session instead of raising the design's one-time alert.
     */
    expect(usdToMicros('99999999.999999')).toBe(MAX_COST_MICROS)
    expect(usdToMicros('100000000')).toBeNull()
    expect(usdToMicros('100000000.000000')).toBeNull()
    expect(usdToMicros('-99999999.999999')).toBe(-MAX_COST_MICROS)
    expect(usdToMicros('-100000000')).toBeNull()
    // …and one micro past the top, from either side.
    expect(usdToMicros('99999999.999998')).toBe(MAX_COST_MICROS - 1n)
    expect(usdToMicros('100000000.000001')).toBeNull()
    // The bound is applied AFTER half-up rounding, so a value that only crosses
    // it by rounding is judged on what we would actually try to store.
    expect(usdToMicros('99999999.9999994')).toBe(MAX_COST_MICROS)
    expect(usdToMicros('99999999.9999995')).toBeNull()
    // Numbers take the same bound as strings.
    expect(usdToMicros(1e8)).toBeNull()
    expect(usdToMicros(-1e8)).toBeNull()
    expect(usdToMicros(12_345.6789)).toBe(12_345_678_900n)
  })
})

describe('token-type priority + carrier selection', () => {
  it('ranks the known types in TOKEN_TYPE_PRIORITY order, unknowns last', () => {
    expect(TOKEN_TYPE_PRIORITY).toEqual(['input', 'output', 'cache-read', 'cache-write'])
    expect(tokenTypePriority('input')).toBe(0)
    expect(tokenTypePriority('cache-write')).toBe(3)
    expect(tokenTypePriority('reasoning')).toBe(4)
  })

  it('picks the earliest present type, independent of arrival order', () => {
    expect(pickCarrierTokenType(['cache-write', 'output', 'input'])).toBe('input')
    expect(pickCarrierTokenType(['input', 'output', 'cache-write'])).toBe('input')
    // input pruned (zero tokens) → the next in priority carries.
    expect(pickCarrierTokenType(['cache-read', 'output'])).toBe('output')
    // Two unknowns tie on rank → lexical tie-break, not arrival order.
    expect(pickCarrierTokenType(['zeta', 'alpha'])).toBe('alpha')
    expect(pickCarrierTokenType(['alpha', 'zeta'])).toBe('alpha')
    expect(pickCarrierTokenType([])).toBeNull()
  })
})

describe('allocateByLargestRemainder — the invariants', () => {
  it('a single row takes the whole total', () => {
    const out = allocateByLargestRemainder(12_300n, [row('input', 7n)])!
    expect(out).toEqual([{ key: 'input', costMicros: 12_300n }])
    expect(sum(out)).toBe(12_300n)
  })

  it('sums EXACTLY to the span total on a realistic four-type span', () => {
    // Deliberately indivisible: 12_300 does not split cleanly across these.
    const out = allocateByLargestRemainder(12_300n, [
      row('input', 3_000n, 0),
      row('output', 3_000n, 1),
      row('cache-read', 5n, 2),
      row('cache-write', 5_000n, 3),
    ])!
    expect(sum(out)).toBe(12_300n)
    for (const r of out) expect(r.costMicros >= 0n).toBe(true)
  })

  it('all-equal remainders: the residue goes by TOKEN_TYPE_PRIORITY, not by position', () => {
    // 10 micros over 4 equal weights → base 2 each, residue 2, every remainder
    // identical. The two extra micros must land on input then output (ranks 0,1).
    const rows = [
      row('input', 100n, tokenTypePriority('input')),
      row('output', 100n, tokenTypePriority('output')),
      row('cache-read', 100n, tokenTypePriority('cache-read')),
      row('cache-write', 100n, tokenTypePriority('cache-write')),
    ]
    const out = allocateByLargestRemainder(10n, rows)!
    expect(Object.fromEntries(out.map((r) => [r.key, r.costMicros]))).toEqual({
      input: 3n,
      output: 3n,
      'cache-read': 2n,
      'cache-write': 2n,
    })
    expect(sum(out)).toBe(10n)
  })

  it('a span total SMALLER than the row count still sums exactly (and starves the small shares)', () => {
    // 2 micros, 4 rows: every base truncates to 0 and the residue is the whole
    // total. The two biggest shares get a micro each; nothing is lost, nothing
    // is invented.
    const out = allocateByLargestRemainder(2n, [
      row('input', 1n, 0),
      row('output', 1_000n, 1),
      row('cache-read', 999n, 2),
      row('cache-write', 1n, 3),
    ])!
    expect(sum(out)).toBe(2n)
    const byKey = Object.fromEntries(out.map((r) => [r.key, r.costMicros]))
    expect(byKey.output).toBe(1n)
    expect(byKey['cache-read']).toBe(1n)
    expect(byKey.input).toBe(0n)
    expect(byKey['cache-write']).toBe(0n)
  })

  it('a ZERO estimate on one row but not the others: that row gets nothing, the total still balances', () => {
    const out = allocateByLargestRemainder(1_000_001n, [
      row('input', 0n, 0),
      row('output', 1n, 1),
      row('cache-read', 2n, 2),
    ])!
    expect(sum(out)).toBe(1_000_001n)
    expect(out.find((r) => r.key === 'input')!.costMicros).toBe(0n)
  })

  it('is INDEPENDENT of the order the rows arrive in', () => {
    const rows = [
      row('input', 3_141n, tokenTypePriority('input')),
      row('output', 2_718n, tokenTypePriority('output')),
      row('cache-read', 1_618n, tokenTypePriority('cache-read')),
      row('cache-write', 1_414n, tokenTypePriority('cache-write')),
    ]
    const canonical = new Map(
      allocateByLargestRemainder(999_983n, rows)!.map((r) => [r.key, r.costMicros]),
    )
    // Every permutation must produce the same per-key answer.
    const permute = (xs: AllocationRow[]): AllocationRow[][] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) =>
            permute([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
          )
    for (const p of permute(rows)) {
      const out = allocateByLargestRemainder(999_983n, p)!
      expect(sum(out)).toBe(999_983n)
      for (const r of out) expect(r.costMicros).toBe(canonical.get(r.key))
    }
  })

  it('property sweep: Σ === total and no negatives, over 2000 seeded random spans', () => {
    const rnd = lcg(20260725)
    for (let i = 0; i < 2000; i++) {
      const n = 1 + Math.floor(rnd() * 4)
      const total = BigInt(Math.floor(rnd() * 5_000_000))
      const rows = Array.from({ length: n }, (_, k) =>
        // Zero weights are part of the input space: a token type the card
        // prices at nothing (e.g. a free cache read tier).
        row(TOKEN_TYPE_PRIORITY[k] ?? `t${k}`, BigInt(Math.floor(rnd() * 100_000)), k),
      )
      const out = allocateByLargestRemainder(total, rows)
      if (out === null) {
        // Only legitimate when there is nothing to be proportional to.
        expect(rows.every((r) => r.weightMicros === 0n)).toBe(true)
        continue
      }
      expect(sum(out)).toBe(total)
      for (const r of out) expect(r.costMicros >= 0n).toBe(true)
    }
  })

  it('returns null rather than guessing when the split is undefined', () => {
    expect(allocateByLargestRemainder(100n, [])).toBeNull()
    expect(allocateByLargestRemainder(-1n, [row('input', 1n)])).toBeNull()
    expect(allocateByLargestRemainder(100n, [row('input', -1n)])).toBeNull()
    expect(allocateByLargestRemainder(100n, [row('input', 0n), row('output', 0n)])).toBeNull()
  })

  it('a zero total spreads zero everywhere (still exact)', () => {
    const out = allocateByLargestRemainder(0n, [row('input', 5n), row('output', 7n)])!
    expect(sum(out)).toBe(0n)
    expect(out.every((r) => r.costMicros === 0n)).toBe(true)
  })
})

describe('decideCostingRung — provider, then rate card, then skip', () => {
  it('rung 1: a positive provider cost wins', () => {
    expect(decideCostingRung({ providerCostUsd: 0.0123, rateCardCanPrice: true })).toEqual({
      rung: 'provider',
      totalMicros: 12_300n,
    })
    // …and wins even when the card cannot price a single row.
    expect(decideCostingRung({ providerCostUsd: 0.0123, rateCardCanPrice: false }).rung).toBe(
      'provider',
    )
  })

  it('rung 2: missing, zero or negative provider cost falls back to the card', () => {
    for (const providerCostUsd of [undefined, null, 0, -1.5, Number.NaN]) {
      expect(decideCostingRung({ providerCostUsd, rateCardCanPrice: true })).toEqual({
        rung: 'rate-card',
        totalMicros: null,
      })
    }
    // A positive figure below half a micro cannot be stored, so it is ZERO here.
    expect(decideCostingRung({ providerCostUsd: 4e-7, rateCardCanPrice: true }).rung).toBe(
      'rate-card',
    )
  })

  it('rung 3: neither rung can price it', () => {
    expect(decideCostingRung({ providerCostUsd: undefined, rateCardCanPrice: false })).toEqual({
      rung: 'skip',
      totalMicros: null,
    })
  })

  it('has NO plausibility band — an absurd provider figure is still recorded', () => {
    // Deliberate: the design removed the ceiling an earlier draft had. A units
    // mix-up is a million-fold error and the loudest failure available; a
    // write-time guard would only defend the one thing that cannot fail
    // silently while catching none of the small errors.
    expect(decideCostingRung({ providerCostUsd: 12_300, rateCardCanPrice: true })).toEqual({
      rung: 'provider',
      totalMicros: 12_300_000_000n,
    })
    // A five-figure span cost is absurd and is still taken at face value, right
    // up to the last figure the column can hold.
    expect(decideCostingRung({ providerCostUsd: '99999999.999999', rateCardCanPrice: true })).toEqual(
      { rung: 'provider', totalMicros: MAX_COST_MICROS },
    )
  })

  it('an UNSTORABLE figure falls to rung 2 — the same door as "the provider reported nothing"', () => {
    // Not a judgement about the figure: the column cannot hold it, so it cannot
    // become cost_usd whatever we think of it. Taking the rate-card rung means
    // the span is still written AND the rateCard counter fires, which is the
    // alert. The alternative — letting it reach the INSERT — throws inside the
    // per-session try/catch and wedges that session's attribution for good.
    expect(decideCostingRung({ providerCostUsd: 1e8, rateCardCanPrice: true })).toEqual({
      rung: 'rate-card',
      totalMicros: null,
    })
    expect(decideCostingRung({ providerCostUsd: '100000000.000000', rateCardCanPrice: true }).rung).toBe(
      'rate-card',
    )
    // …and with no card either, it skips, exactly like any other unusable figure.
    expect(decideCostingRung({ providerCostUsd: 1e8, rateCardCanPrice: false }).rung).toBe('skip')
  })
})

describe('planSpanCosting — the composed decision for one span', () => {
  const spanRow = (tokenType: string, rateCardMicros: bigint | null): SpanRow => ({
    key: `${tokenType} claude-fable-5`,
    tokenType,
    rateCardMicros,
  })

  const fourTypes = [
    spanRow('input', 3_000n),
    spanRow('output', 3_000n),
    spanRow('cache-read', 500n),
    spanRow('cache-write', 3_750n),
  ]

  it('slices a provider-costed span across the rows, summing to the provider figure', () => {
    const plan = planSpanCosting({ providerCostUsd: 0.0123, rows: fourTypes })
    expect(plan.rung).toBe('provider')
    expect(plan.shape).toBe('sliced')
    expect([...plan.costs.values()].reduce((a, b) => a + b, 0n)).toBe(12_300n)
    expect(plan.costs.size).toBe(4)
    expect(plan.carrierKey).toBeNull()
    expect(plan.unknownTokenTypes).toEqual([])
  })

  it('an UNKNOWN token type carries the span on ONE row — never mis-slotted, never dropped', () => {
    const rows = [...fourTypes, spanRow('reasoning', null)]
    const plan = planSpanCosting({ providerCostUsd: 0.0123, rows })
    expect(plan.rung).toBe('provider')
    expect(plan.shape).toBe('carrier')
    expect(plan.unknownTokenTypes).toEqual(['reasoning'])
    // Every row is still present (tokens are recorded); only the carrier is paid.
    expect(plan.costs.size).toBe(5)
    expect(plan.carrierKey).toBe('input claude-fable-5')
    expect(plan.costs.get('input claude-fable-5')).toBe(12_300n)
    expect([...plan.costs.values()].reduce((a, b) => a + b, 0n)).toBe(12_300n)
  })

  it('no rate card at all (every estimate null) still records the provider figure on a carrier', () => {
    const rows = [spanRow('output', null), spanRow('cache-read', null)]
    const plan = planSpanCosting({ providerCostUsd: 1.5, rows })
    expect(plan.shape).toBe('carrier')
    // 'output' outranks 'cache-read' in TOKEN_TYPE_PRIORITY even though input
    // is absent (pruned as zero-token).
    expect(plan.carrierKey).toBe('output claude-fable-5')
    expect([...plan.costs.values()].reduce((a, b) => a + b, 0n)).toBe(1_500_000n)
  })

  it('a card whose span estimate is <= 0 is a DISTINCT case from "no card" — also carrier', () => {
    // The card exists and priced every row, but at zero: there are no shares to
    // be proportional to, so slicing is undefined.
    const rows = [spanRow('input', 0n), spanRow('output', 0n)]
    const plan = planSpanCosting({ providerCostUsd: 2, rows })
    expect(plan.shape).toBe('carrier')
    expect(plan.unknownTokenTypes).toEqual([])
    expect(plan.costs.get('input claude-fable-5')).toBe(2_000_000n)
    expect(plan.costs.get('output claude-fable-5')).toBe(0n)
  })

  it('rung 2 keeps each row on its OWN card estimate (no re-slicing of history)', () => {
    const plan = planSpanCosting({ providerCostUsd: undefined, rows: fourTypes })
    expect(plan.rung).toBe('rate-card')
    expect(plan.shape).toBe('rate-card')
    expect(plan.costs.get('input claude-fable-5')).toBe(3_000n)
    expect(plan.costs.get('cache-write claude-fable-5')).toBe(3_750n)
    expect([...plan.costs.values()].reduce((a, b) => a + b, 0n)).toBe(10_250n)
  })

  it('rung 2 with a partially-priceable card omits the unpriceable rows (the pre-existing skip)', () => {
    const rows = [spanRow('input', 3_000n), spanRow('reasoning', null)]
    const plan = planSpanCosting({ providerCostUsd: undefined, rows })
    expect(plan.shape).toBe('rate-card')
    expect(plan.costs.has('input claude-fable-5')).toBe(true)
    expect(plan.costs.has('reasoning claude-fable-5')).toBe(false)
    expect(plan.unknownTokenTypes).toEqual(['reasoning'])
  })

  it('rung 3: no provider cost and no card → nothing is written', () => {
    const plan = planSpanCosting({
      providerCostUsd: undefined,
      rows: [spanRow('input', null), spanRow('output', null)],
    })
    expect(plan.rung).toBe('skip')
    expect(plan.shape).toBe('skip')
    expect(plan.costs.size).toBe(0)
  })

  it('an empty span is a skip, not a crash', () => {
    const plan = planSpanCosting({ providerCostUsd: 1, rows: [] })
    expect(plan.shape).toBe('skip')
    expect(plan.costs.size).toBe(0)
  })

  it('is deterministic: identical input always yields identical output', () => {
    const a = planSpanCosting({ providerCostUsd: 0.0123, rows: fourTypes })
    const b = planSpanCosting({ providerCostUsd: 0.0123, rows: [...fourTypes].reverse() })
    expect([...a.costs.entries()].sort()).toEqual([...b.costs.entries()].sort())
  })
})

describe('replanAgainstBooked — a half-written span still totals the provider figure', () => {
  const spanRow = (tokenType: string, rateCardMicros: bigint | null): SpanRow => ({
    key: `${tokenType}\0claude-fable-5`,
    tokenType,
    rateCardMicros,
  })
  const k = (tokenType: string) => `${tokenType}\0claude-fable-5`
  const nothingBooked = { bookedMicros: 0n, writtenKeys: new Set<string>() }
  const booked = (micros: bigint, ...keys: string[]) => ({
    bookedMicros: micros,
    writtenKeys: new Set(keys.map(k)),
  })
  // Shares 1 : 5 : 0.1 — the shape the real card has.
  const rows = [spanRow('input', 3_000n), spanRow('output', 15_000n), spanRow('cache-read', 300n)]
  const total = (plan: { costs: Map<string, bigint> }) =>
    [...plan.costs.values()].reduce((a, b) => a + b, 0n)

  it('is a NO-OP when nothing is booked yet — the normal path is untouched', () => {
    const base = planSpanCosting({ providerCostUsd: 0.0123, rows })
    expect(replanAgainstBooked(base, rows, nothingBooked)).toBe(base)
  })

  it('gives the UNWRITTEN rows exactly what is left of the provider figure', () => {
    // 'input' is already on the ledger at 2_000 micros — whatever an earlier
    // pass, under an older rate card, happened to give it. It is frozen. The
    // remaining 10_300 must be split across the other two, so the span still
    // books exactly 12_300.
    const base = planSpanCosting({ providerCostUsd: 0.0123, rows })
    const plan = replanAgainstBooked(base, rows, booked(2_000n, 'input'))
    expect(plan.costs.get(k('input'))).toBe(0n) // never reaches the DB (DO NOTHING)
    expect(plan.costs.get(k('output'))! + plan.costs.get(k('cache-read'))!).toBe(10_300n)
    expect(total(plan) + 2_000n).toBe(12_300n)
  })

  it('the ORIGINAL slice is what a full pass produces — the re-plan only changes the remainder', () => {
    // Sanity anchor: the same span written in one go sums to the provider
    // figure, and written in two goes ALSO sums to it. That equality is the
    // whole point; the per-row split legitimately differs between the two.
    const base = planSpanCosting({ providerCostUsd: 0.0123, rows })
    expect(total(base)).toBe(12_300n)
    const firstHalf = base.costs.get(k('input'))!
    const rest = replanAgainstBooked(base, rows, booked(firstHalf, 'input'))
    expect(firstHalf + total(rest)).toBe(12_300n)
  })

  it('a span already FULLY booked adds nothing — a replay cannot inflate it', () => {
    const base = planSpanCosting({ providerCostUsd: 0.0123, rows })
    const plan = replanAgainstBooked(
      base,
      rows,
      booked(12_300n, 'input', 'output', 'cache-read'),
    )
    expect(total(plan)).toBe(0n)
  })

  it('OVER-booked clamps at zero rather than clawing back with a negative row', () => {
    // Rows are frozen, so an earlier over-book cannot be undone; handing the
    // remaining rows a negative share would only spread the damage.
    const base = planSpanCosting({ providerCostUsd: 0.0123, rows })
    const plan = replanAgainstBooked(base, rows, booked(99_999n, 'input'))
    expect(total(plan)).toBe(0n)
    for (const v of plan.costs.values()) expect(v >= 0n).toBe(true)
  })

  it('carries the remainder on ONE row when the card cannot slice it', () => {
    // Unknown token type → no share ratio exists, so the leftover must land on a
    // single deterministic carrier among the rows still to be written.
    const withUnknown = [...rows, spanRow('reasoning', null)]
    const base = planSpanCosting({ providerCostUsd: 0.0123, rows: withUnknown })
    expect(base.shape).toBe('carrier')
    const plan = replanAgainstBooked(base, withUnknown, booked(300n, 'input'))
    expect(plan.shape).toBe('carrier')
    // 'input' is written, so 'output' is the earliest remaining type.
    expect(plan.carrierKey).toBe(k('output'))
    expect(plan.costs.get(k('output'))).toBe(12_000n)
    expect(total(plan) + 300n).toBe(12_300n)
  })

  it('leaves rung 2 and rung 3 alone — neither has a span total to conserve', () => {
    const rateCard = planSpanCosting({ providerCostUsd: undefined, rows })
    expect(replanAgainstBooked(rateCard, rows, booked(999n, 'input'))).toBe(rateCard)
    const skip = planSpanCosting({
      providerCostUsd: undefined,
      rows: [spanRow('input', null)],
    })
    expect(replanAgainstBooked(skip, [spanRow('input', null)], booked(999n, 'input'))).toBe(skip)
  })

  it('property sweep: however a span is split in two, the booked total is the provider figure', () => {
    const rnd = lcg(20260726)
    for (let i = 0; i < 500; i++) {
      const providerMicros = BigInt(1 + Math.floor(rnd() * 5_000_000))
      const n = 2 + Math.floor(rnd() * 3)
      const spanRows = Array.from({ length: n }, (_, j) =>
        spanRow(TOKEN_TYPE_PRIORITY[j] ?? `t${j}`, BigInt(1 + Math.floor(rnd() * 100_000))),
      )
      const base = planSpanCosting({
        providerCostUsd: microsToUsd(providerMicros),
        rows: spanRows,
      })
      // Write a random prefix of the rows, then reconcile the rest.
      const cut = 1 + Math.floor(rnd() * (n - 1))
      const writtenRows = spanRows.slice(0, cut)
      const bookedMicros = writtenRows.reduce((acc, r) => acc + base.costs.get(r.key)!, 0n)
      const plan = replanAgainstBooked(base, spanRows, {
        bookedMicros,
        writtenKeys: new Set(writtenRows.map((r) => r.key)),
      })
      const unwrittenTotal = spanRows
        .slice(cut)
        .reduce((acc, r) => acc + plan.costs.get(r.key)!, 0n)
      expect(bookedMicros + unwrittenTotal).toBe(providerMicros)
      for (const v of plan.costs.values()) expect(v >= 0n).toBe(true)
    }
  })
})

describe('tallySpanPlan', () => {
  it('partitions spans across the four mutually-exclusive rungs', () => {
    const counts = emptyCostingRungCounts()
    const r = (tokenType: string, m: bigint | null): SpanRow => ({
      key: tokenType,
      tokenType,
      rateCardMicros: m,
    })
    tallySpanPlan(counts, planSpanCosting({ providerCostUsd: 1, rows: [r('input', 5n)] }))
    tallySpanPlan(counts, planSpanCosting({ providerCostUsd: 1, rows: [r('input', null)] }))
    tallySpanPlan(counts, planSpanCosting({ providerCostUsd: 0, rows: [r('input', 5n)] }))
    tallySpanPlan(counts, planSpanCosting({ providerCostUsd: 0, rows: [r('input', null)] }))
    expect(counts).toEqual({ provider: 1, carrier: 1, rateCard: 1, skipped: 1 })
  })
})
