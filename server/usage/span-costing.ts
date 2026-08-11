/*
 * Span costing — the PURE arithmetic behind attribution_record.cost_usd.
 *
 * Design: docs/design/provider-cost-precedence.md ("Cost accuracy without a
 * price list"). THE PRINCIPLE: *the provider states what it cost; record that,
 * do not re-derive it.* The rate card is demoted from "the costing mechanism"
 * to (a) a fallback when the provider reported nothing, and (b) the thing that
 * decides how one span total is SLICED across our per-token-type rows.
 *
 * Why this is its own module rather than more logic in the joiner:
 * every function here is pure — no DB, no clock, no env — so the invariants
 * below are unit-testable without testcontainers, and the joiner keeps doing
 * the one thing it is good at (I/O + attribution). The joiner
 * (server/workers/azure-monitor-reader.ts) is the only production caller.
 *
 * INVARIANTS (pinned in tests/unit/usage/span-costing.test.ts):
 *   1. Σ(row costs) === the span total, EXACTLY, for every input.
 *   2. No row is ever negative.
 *   3. Deterministic: identical input always yields identical output —
 *      independent of the ORDER the rows arrive in (the KQL has no ORDER BY).
 *
 * WHY BIGINT AND NOT `number`: attribution_record.cost_usd is NUMERIC(14,6),
 * so a micro-dollar is the minor unit and every representable cost is an
 * integer number of micros. JavaScript `number` is binary floating point:
 * 0.1 + 0.2 !== 0.3, and a sum of four float shares will miss the span total
 * by a few ulps roughly half the time — which would break invariant 1 on real
 * traffic, silently, in the direction of "our chart disagrees with the bill".
 * So all arithmetic here is exact integer arithmetic on bigint micros, and
 * floats only ever appear at the boundary (parsing the provider's reported
 * figure, which arrives as a double from the KQL `todouble`).
 */

/** attribution_record.cost_usd is NUMERIC(14,6) — micro-USD is the minor unit. */
export const COST_DECIMALS = 6
export const MICROS_PER_USD = 1_000_000n

/*
 * The largest magnitude attribution_record.cost_usd can PHYSICALLY hold:
 * NUMERIC(14,6) is 14 significant digits with 6 after the point, so 8 integer
 * digits — 99999999.999999, i.e. 99,999,999,999,999 micros
 * (drizzle/migrations/0001_schema.sql:185).
 *
 * THIS IS A STORABILITY CHECK, NOT THE PLAUSIBILITY BAND THE DESIGN REJECTED.
 * Do not read it as a re-introduced ceiling: the design deliberately has NO view
 * on whether a provider figure is believable (see decideCostingRung), and this
 * bound expresses something entirely different and non-negotiable — the database
 * cannot store the number at all. Anything past it is not "suspicious", it is
 * unwritable, and Postgres answers it with `numeric field overflow`.
 *
 * WHY IT MATTERS THAT WE CATCH IT HERE rather than at the INSERT: the joiner
 * isolates faults PER SESSION (ING-6), so a throw from the insert is swallowed
 * and the same session is retried on every subsequent tick — where the same
 * poisoned span throws again. One unstorable figure would durably block
 * attribution for that whole session, silently, instead of raising the loud
 * one-time alert the design intends. Rejecting it here sends it down the SAME
 * path as "the provider reported nothing": rung 2 (the rate card) plus the
 * rateCard counter, which IS the alert.
 */
export const MAX_COST_MICROS = 99_999_999_999_999n

/*
 * ING-5: fixed cost-carrier order. When a span's cost has to land on ONE row
 * (the Copilot lane always; the Claude lane when the rate card cannot slice the
 * span), the carrier is the present token_type EARLIEST in this list, with
 * unknown types ordered after the known ones.
 *
 * It doubles as the tie-break for the largest-remainder residue below. A fixed
 * "always give the residue to the last row" plug would push the same
 * sub-micro-dollar onto the same token type on every span — across millions of
 * rows that is a systematic bias in one column of the per-type breakdown, not
 * rounding noise. Largest-remainder + a stable tie-break spreads it.
 *
 * Lives here (not in the joiner) so the Copilot carrier, the Claude carrier and
 * the residue tie-break can never drift apart into three different orders.
 */
export const TOKEN_TYPE_PRIORITY = ['input', 'output', 'cache-read', 'cache-write'] as const

/** Rank of a token type in TOKEN_TYPE_PRIORITY; unknown types sort last. */
export function tokenTypePriority(tokenType: string): number {
  const i = TOKEN_TYPE_PRIORITY.indexOf(tokenType as (typeof TOKEN_TYPE_PRIORITY)[number])
  return i === -1 ? TOKEN_TYPE_PRIORITY.length : i
}

/**
 * The deterministic carrier among the token types present on a span: lowest
 * TOKEN_TYPE_PRIORITY rank, ties broken lexically so the answer never depends
 * on arrival order. Returns null for an empty span.
 */
export function pickCarrierTokenType(tokenTypes: readonly string[]): string | null {
  let best: string | null = null
  for (const tt of tokenTypes) {
    if (best === null) {
      best = tt
      continue
    }
    const d = tokenTypePriority(tt) - tokenTypePriority(best)
    if (d < 0 || (d === 0 && tt < best)) best = tt
  }
  return best
}

// A plain decimal literal. Exponent form ('1e-7') is DELIBERATELY rejected:
// nothing on this path produces it (Number#toFixed never does, and rate-card
// values come out of Postgres NUMERIC as plain decimals), and silently
// accepting it would mean guessing at a value we did not expect.
const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d*))?$/

/**
 * Exact decimal -> integer micro-USD.
 *
 * A `number` is normalised through `toFixed(COST_DECIMALS)` first: that is the
 * only correctly-rounded decimal rendering of a double available without a
 * decimal library, and 6 dp is exactly the precision the column stores, so no
 * information that could ever reach the database is lost. A `string` is parsed
 * digit-by-digit (never via Number()) so a value that already carries more than
 * 6 decimals rounds half-up rather than picking up float drift on the way in.
 *
 * Returns null for anything unusable (NaN, ±Infinity, malformed text, or a
 * magnitude the NUMERIC(14,6) column cannot store — see MAX_COST_MICROS) —
 * callers treat null as "this cannot be priced", never as zero.
 */
export function usdToMicros(value: number | string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null
  let text: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    // toFixed switches to exponential notation at 1e21, which DECIMAL_RE would
    // reject anyway; bailing here keeps the rejection reason legible. The real
    // bound is MAX_COST_MICROS below, twelve orders of magnitude tighter.
    if (Math.abs(value) >= 1e21) return null
    text = value.toFixed(COST_DECIMALS)
  } else {
    text = value.trim()
  }
  const m = DECIMAL_RE.exec(text)
  if (!m) return null
  const negative = m[1] === '-'
  const whole = BigInt(m[2]!)
  const fracRaw = m[3] ?? ''
  const frac = (fracRaw + '0'.repeat(COST_DECIMALS)).slice(0, COST_DECIMALS)
  let micros = whole * MICROS_PER_USD + BigInt(frac)
  // Round half-up on the magnitude (so -0.0000005 -> -0.000001, symmetric with
  // +0.0000005 -> +0.000001) when the input carried more precision than we store.
  const nextDigit = fracRaw.charCodeAt(COST_DECIMALS)
  if (nextDigit >= 0x35 && nextDigit <= 0x39) micros += 1n
  // The destination column's magnitude bound, applied AFTER the half-up rounding
  // so a figure that only crosses the bound by rounding up (99999999.9999995)
  // is judged on the value we would actually attempt to store. See
  // MAX_COST_MICROS: storability, not plausibility.
  if (micros > MAX_COST_MICROS) return null
  return negative ? -micros : micros
}

/** Integer micro-USD -> the fixed 6-decimal string the numeric column takes. */
export function microsToUsd(micros: bigint): string {
  const negative = micros < 0n
  const abs = negative ? -micros : micros
  const whole = abs / MICROS_PER_USD
  const frac = (abs % MICROS_PER_USD).toString().padStart(COST_DECIMALS, '0')
  return `${negative ? '-' : ''}${whole}.${frac}`
}

// ── The ladder ────────────────────────────────────────────────────────────────

/**
 * Which rung of the precedence ladder priced a span:
 *   'provider'  — the provider's own reported cost (the healthy case)
 *   'rate-card' — nothing usable from the provider; our card priced it (ALERT)
 *   'skip'      — neither could; the span is not written at all
 */
export type CostingRung = 'provider' | 'rate-card' | 'skip'

export interface RungDecision {
  rung: CostingRung
  /**
   * The span total in micros, for rung 'provider' only. rung 'rate-card' has no
   * single total to distribute — each row simply keeps its own card estimate,
   * exactly as before this design — and rung 'skip' has no cost at all.
   */
  totalMicros: bigint | null
}

/**
 * The precedence ladder, per docs/design/provider-cost-precedence.md:
 *
 *     1. the provider's reported cost for the span
 *     2. the rate card, exactly as today (when the provider reports nothing)
 *     3. skip the span (under-reporting beats a silent zero)
 *
 * THE ONLY GUARD IS `missing, zero, or negative -> rung 2, and ALERT`. There is
 * deliberately NO plausibility band, ceiling or ratio check: an earlier draft
 * had one and it was removed on review. A units mix-up (cost_usd vs
 * cost_usd_micros) is a million-fold error — the loudest failure available,
 * obvious in every chart within minutes — so guarding it at write time defends
 * the one thing that cannot fail silently while doing nothing about the small
 * errors no threshold can catch either. The rate card is NOT a costing
 * mechanism; if it ever prices a real span that IS the anomaly, and the correct
 * response is to tell somebody, not to compute a better guess quietly.
 *
 * ONE thing that is NOT a plausibility judgement still lands here: a figure the
 * NUMERIC(14,6) column physically cannot store (MAX_COST_MICROS). usdToMicros
 * returns null for it, so it takes the identical "the provider reported
 * nothing" path — rung 2 plus the alert — instead of throwing a numeric
 * overflow at the INSERT, which the joiner's per-session try/catch would swallow
 * and then re-throw on every following tick, wedging that session's attribution.
 * Falling through the same door is deliberate: the alert already means "the
 * provider's number did not reach the ledger", which is exactly what happened.
 */
export function decideCostingRung(input: {
  /** The provider's reported cost for the span (MAX, never SUM — see below). */
  providerCostUsd?: number | string | null
  /** True when the rate card can price at least one of the span's rows. */
  rateCardCanPrice: boolean
}): RungDecision {
  const providerMicros = usdToMicros(input.providerCostUsd)
  // "missing, zero, or negative": a positive figure that rounds to 0 micros is
  // ZERO as far as the ledger is concerned (the column cannot hold it), so it
  // takes the same fallback rather than writing a $0.00 row and calling it
  // provider-reported.
  if (providerMicros !== null && providerMicros > 0n) {
    return { rung: 'provider', totalMicros: providerMicros }
  }
  if (input.rateCardCanPrice) return { rung: 'rate-card', totalMicros: null }
  return { rung: 'skip', totalMicros: null }
}

// ── Largest-remainder allocation ──────────────────────────────────────────────

export interface AllocationRow {
  /** Stable, unique identity for the row (the caller maps costs back by it). */
  key: string
  /** This row's rate-card estimate in micros. Must be >= 0. */
  weightMicros: bigint
  /** Tie-break rank for the residue; LOWER wins first (TOKEN_TYPE_PRIORITY). */
  rank: number
}

export interface AllocatedRow {
  key: string
  costMicros: bigint
}

/**
 * Slice `totalMicros` across `rows` in proportion to their weights, exactly.
 *
 *   base_i    = floor(total * w_i / W)          — TRUNCATED, never rounded
 *   residue   = total - Σ base_i                — hence 0 <= residue < rows.length
 *   remainder = (total * w_i) mod W             — the exact fractional part
 *
 * Truncation (not rounding) is what makes the residue provably NON-NEGATIVE:
 * every base_i is at or below its true share, so Σ base_i <= total always, and
 * there is never a deficit to claw back out of somebody's row. The residue is
 * then handed out one micro at a time to the LARGEST REMAINDERS — the classic
 * largest-remainder (Hamilton) apportionment — with TOKEN_TYPE_PRIORITY
 * breaking ties, so the bias a fixed always-last plug would bake into one
 * column across millions of rows is spread instead.
 *
 * Returns null when the split is not defined: no rows, a negative total, a
 * negative weight, or a total weight of zero (nothing to be proportional TO).
 * Callers fall back to the single-carrier pattern rather than dropping the span.
 */
export function allocateByLargestRemainder(
  totalMicros: bigint,
  rows: readonly AllocationRow[],
): AllocatedRow[] | null {
  if (rows.length === 0) return null
  if (totalMicros < 0n) return null
  let totalWeight = 0n
  for (const r of rows) {
    if (r.weightMicros < 0n) return null
    totalWeight += r.weightMicros
  }
  if (totalWeight <= 0n) return null

  const scratch = rows.map((r, index) => {
    const numerator = totalMicros * r.weightMicros
    return {
      index,
      key: r.key,
      rank: r.rank,
      base: numerator / totalWeight, // bigint division truncates; operands are >= 0
      remainder: numerator % totalWeight,
    }
  })

  let assigned = 0n
  for (const s of scratch) assigned += s.base
  // 0 <= residue < rows.length: each row loses strictly less than one micro to
  // truncation, and none can gain.
  let residue = totalMicros - assigned

  // Order-independent total order: biggest remainder first, then the fixed
  // token-type priority, then the key. `rows` arrives in whatever order the KQL
  // happened to return, so the sort must not depend on `index` at all.
  const order = [...scratch].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1
    if (a.rank !== b.rank) return a.rank - b.rank
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
  for (const s of order) {
    if (residue <= 0n) break
    s.base += 1n
    residue -= 1n
  }

  // Return in the caller's row order — the allocation itself is order-free.
  return scratch.map((s) => ({ key: s.key, costMicros: s.base }))
}

// ── The composed span plan ────────────────────────────────────────────────────

export interface SpanRow {
  /** Unique within the span. The joiner uses `${tokenType}\0${model}`. */
  key: string
  tokenType: string
  /**
   * The rate card's estimate for this row, in micros. null means the card had
   * NO line for this (token type, model) — an UNKNOWN token type, e.g. a future
   * reasoning-token or a new cache tier. It must never be silently mis-slotted
   * into another type's share nor dropped.
   */
  rateCardMicros: bigint | null
}

/**
 * How a span's total ended up distributed:
 *   'sliced'    — provider total, split across the rows by rate-card share
 *   'carrier'   — provider total, on ONE deterministic row (card could not slice)
 *   'rate-card' — no provider total; each row keeps its own card estimate
 *   'skip'      — nothing could price it; no rows are written
 */
export type SpanCostShape = 'sliced' | 'carrier' | 'rate-card' | 'skip'

export interface SpanCostPlan {
  rung: CostingRung
  shape: SpanCostShape
  /**
   * The span total the provider reported, in micros — the number Σ(costs) must
   * come to. Non-null on rung 'provider' only (rung 'rate-card' has no single
   * total; rung 'skip' has no cost). Carried on the plan so replanAgainstBooked
   * does not have to recover it by summing the slices back up.
   */
  totalMicros: bigint | null
  /**
   * key -> cost in micros. A row ABSENT from this map is skipped (not written):
   * that happens only on shape 'rate-card', for the rows the card could not
   * price, and matches the pre-existing per-row skip behaviour exactly.
   */
  costs: Map<string, bigint>
  /** The carrying row's key on shape 'carrier'; null otherwise. */
  carrierKey: string | null
  /**
   * Token types the rate card had no line for. Non-empty forces shape
   * 'carrier' on a provider-costed span (there is no honest share to give the
   * unknown row) and is worth counting loudly — it means a new billable token
   * type has appeared.
   */
  unknownTokenTypes: string[]
}

/**
 * Decide, for ONE span, what every row's cost_usd should be.
 *
 * `providerCostUsd` MUST be the MAX of the span's reported costs, NEVER the SUM
 * — see the joiner for why (the KQL mv-expand copies the provider's per-span
 * figure onto every surviving token-type row, so summing multiplies it by 1-4x,
 * correlated with cache usage).
 */
export function planSpanCosting(input: {
  providerCostUsd?: number | string | null
  rows: readonly SpanRow[]
}): SpanCostPlan {
  const { rows } = input
  const unknownTokenTypes = [
    ...new Set(rows.filter((r) => r.rateCardMicros === null).map((r) => r.tokenType)),
  ].sort()
  const priceable = rows.filter((r) => r.rateCardMicros !== null)
  const decision = decideCostingRung({
    providerCostUsd: input.providerCostUsd,
    rateCardCanPrice: priceable.length > 0,
  })

  if (decision.rung === 'skip' || rows.length === 0) {
    return {
      rung: 'skip',
      shape: 'skip',
      totalMicros: null,
      costs: new Map(),
      carrierKey: null,
      unknownTokenTypes,
    }
  }

  if (decision.rung === 'rate-card') {
    // Rung 2 = "the rate card, exactly as today": every row keeps its OWN
    // estimate and the rows the card cannot price are skipped, byte-identical
    // to the pre-design behaviour. There is no span total to apportion here —
    // inventing one and re-slicing it would change historic numbers for no gain.
    const costs = new Map<string, bigint>()
    for (const r of priceable) costs.set(r.key, r.rateCardMicros!)
    return {
      rung: 'rate-card',
      shape: 'rate-card',
      totalMicros: null,
      costs,
      carrierKey: null,
      unknownTokenTypes,
    }
  }

  const totalMicros = decision.totalMicros!
  const distributed = distributeProviderTotal(totalMicros, rows, unknownTokenTypes.length > 0)
  return {
    rung: 'provider',
    shape: distributed.shape,
    totalMicros,
    costs: distributed.costs,
    carrierKey: distributed.carrierKey,
    unknownTokenTypes,
  }
}

/**
 * Spread one provider total across `rows`: sliced by rate-card share when that
 * is defensible, otherwise onto a single deterministic carrier. Shared by
 * planSpanCosting and replanAgainstBooked so the two can never disagree about
 * what "the card cannot slice this" means or about which row carries.
 */
function distributeProviderTotal(
  totalMicros: bigint,
  rows: readonly SpanRow[],
  hasUnknownTokenType: boolean,
): { shape: 'sliced' | 'carrier'; costs: Map<string, bigint>; carrierKey: string | null } {
  const allocation = hasUnknownTokenType
    ? // An unknown token type has no share ratio, so NO split across these
      // rows is defensible. Carry the whole (correct) provider total on one
      // row instead of guessing — the money stays exact, only the per-type
      // breakdown degrades, and the counter says so out loud.
      null
    : allocateByLargestRemainder(
        totalMicros,
        rows.map((r) => ({
          key: r.key,
          weightMicros: r.rateCardMicros!,
          rank: tokenTypePriority(r.tokenType),
        })),
      )

  if (allocation === null) {
    // Cannot slice: an unknown token type, no lines at all, or a card whose
    // estimate for this span is <= 0 (a distinct case from "no card" — the card
    // exists but prices the span at nothing, so there are no shares to be
    // proportional to). Single deterministic carrier, exactly the pattern the
    // Copilot lane has used since ING-5. NEVER drop the span, never emit NaN.
    const carrierTokenType = pickCarrierTokenType(rows.map((r) => r.tokenType))
    const carrierRow =
      rows
        .filter((r) => r.tokenType === carrierTokenType)
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0] ?? rows[0]!
    const costs = new Map<string, bigint>()
    for (const r of rows) costs.set(r.key, r.key === carrierRow.key ? totalMicros : 0n)
    return { shape: 'carrier', costs, carrierKey: carrierRow.key }
  }

  const costs = new Map<string, bigint>()
  for (const a of allocation) costs.set(a.key, a.costMicros)
  return { shape: 'sliced', costs, carrierKey: null }
}

/** What the ledger ALREADY holds for one span, read inside the write transaction. */
export interface BookedSpan {
  /** Σ(cost_usd) over the span's rows already on the ledger, in micros. */
  bookedMicros: bigint
  /** The `key` of every row of this span already on the ledger. */
  writtenKeys: ReadonlySet<string>
}

/**
 * Re-plan a PROVIDER-costed span against the rows the ledger already holds for
 * it, so that Σ(cost_usd) over the finished span is still EXACTLY the provider's
 * figure.
 *
 * WHY THIS EXISTS. Rows are frozen on write (COST-8) and re-written with
 * `ON CONFLICT DO NOTHING`, so a row already on the ledger keeps its original
 * amount forever. If a span is ever written in two goes — a crash between rows
 * before the write became transactional, a reader whose row set for the span
 * GREW between ticks, an operator re-run — the second pass re-slices the SAME
 * provider total across the SAME rows against whatever the rate card says now.
 * The already-written rows ignore the new numbers; the new rows take them. Add a
 * rate-line edit in between (an ordinary admin action) and the two halves are
 * sliced with different weights, so the span's booked total silently stops being
 * the provider's figure — the one invariant every project, budget, rollup and
 * chargeback number in the system inherits.
 *
 * The fix is to treat what is already booked as a fact, not to recompute it:
 *
 *     still to allocate = provider total − already booked
 *
 * distributed across the rows NOT yet on the ledger. That lands the span exactly
 * on the provider's figure whatever the card did in between, and it degrades to
 * the plain plan (byte-identical) when nothing is booked yet — which is every
 * span, every tick, in normal operation.
 *
 * Only rung 'provider' is touched. Rung 'rate-card' rows each carry their OWN
 * per-row estimate with no span total to conserve, and rung 'skip' writes
 * nothing; re-planning either would change historic numbers for no gain.
 */
export function replanAgainstBooked(
  plan: SpanCostPlan,
  rows: readonly SpanRow[],
  booked: BookedSpan,
): SpanCostPlan {
  if (plan.rung !== 'provider' || plan.totalMicros === null) return plan
  // The overwhelmingly common case: this span is new, so there is nothing to
  // reconcile against and the plan already allocates the whole provider total.
  if (booked.bookedMicros === 0n && booked.writtenKeys.size === 0) return plan

  const unwritten = rows.filter((r) => !booked.writtenKeys.has(r.key))
  if (unwritten.length === 0) {
    // Every row is already on the ledger — a plain replay. The inserts below all
    // conflict and do nothing, so the amounts are irrelevant; zero them so the
    // plan cannot be misread as "these rows are owed this much".
    const costs = new Map<string, bigint>()
    for (const r of rows) costs.set(r.key, 0n)
    return { ...plan, costs, carrierKey: null }
  }

  // Clamped at zero. Booked ABOVE the provider total means an earlier pass
  // over-booked this span (e.g. a pre-ING-5 double carrier); the rows are frozen
  // so it cannot be clawed back, and handing the remaining rows a negative share
  // would only spread the damage. Under-report, never invent — the same
  // asymmetry rung 3 is built on. v_cost_drift's booked_cost_usd vs
  // law_cost_usd is where such a span is meant to be spotted.
  const remaining =
    plan.totalMicros > booked.bookedMicros ? plan.totalMicros - booked.bookedMicros : 0n
  const distributed = distributeProviderTotal(
    remaining,
    unwritten,
    plan.unknownTokenTypes.length > 0,
  )
  const costs = new Map(distributed.costs)
  // Rows already on the ledger keep a zero here for the same reason as above:
  // the value never reaches the database (ON CONFLICT DO NOTHING), and a
  // non-zero one would falsely suggest it might.
  for (const r of rows) if (!costs.has(r.key)) costs.set(r.key, 0n)
  return { ...plan, shape: distributed.shape, costs, carrierKey: distributed.carrierKey }
}

/**
 * Per-run tally of which rung priced each SPAN, surfaced on the joiner's run
 * result (worker_run.result) so Admin -> Diagnostics can show it and an alert
 * can fire. The four are MUTUALLY EXCLUSIVE and sum to the spans considered:
 *
 *   provider — provider figure, sliced across the token-type rows (healthy)
 *   carrier  — provider figure, but the card could not slice it, so the whole
 *              figure landed on one row (still exact money, degraded breakdown)
 *   rateCard — no usable provider figure; our card priced it. UNEXPECTED — the
 *              rate card is not a costing mechanism. This is the alert.
 *   skipped  — neither rung could price it; the span was not written
 *
 * `provider + carrier` is therefore the count of spans whose total is EXACTLY
 * the provider's number.
 */
export interface CostingRungCounts {
  provider: number
  rateCard: number
  carrier: number
  skipped: number
}

export function emptyCostingRungCounts(): CostingRungCounts {
  return { provider: 0, rateCard: 0, carrier: 0, skipped: 0 }
}

/** Fold one span's plan into the run tally. */
export function tallySpanPlan(counts: CostingRungCounts, plan: SpanCostPlan): void {
  switch (plan.shape) {
    case 'sliced':
      counts.provider += 1
      break
    case 'carrier':
      counts.carrier += 1
      break
    case 'rate-card':
      counts.rateCard += 1
      break
    case 'skip':
      counts.skipped += 1
      break
  }
}
