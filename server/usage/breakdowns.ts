/*
 * Usage read-model — the ONE place breakdown SQL and pivot logic live
 * (design: docs/design/session-granularity-sprint.md §0.5.2).
 *
 * The session endpoints, the CSV export, and (next sprint) the My
 * Consumption / My Projects endpoints are thin consumers of these
 * primitives; no breakdown SQL belongs in route handlers. Everything is
 * teammate-scoped: callers pass the authenticated teammate id and queries
 * bind it — never trust a conversation id alone.
 *
 * Two layers:
 *   - query helpers (take the RLS-bound tx) → flat (conversation × model ×
 *     token_type) cells from attribution_record;
 *   - pure pivot helpers (unit-testable, no DB) → the shared response
 *     vocabulary in shared/schemas/usage.ts.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { conversationKeyExpr } from '../db/conversation-key'
import type {
  CacheStats,
  FidelitySplit,
  ModelSpend,
  QuerySourceSpend,
  SessionMatrixCell,
  SessionTokenTypeSpend,
  TokenTypeSpend,
  UsageMatrixCell,
} from '../../shared/schemas/usage'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** One grouped ledger cell. tier2_cost_usd ⊆ cost_usd (advisory share). */
export interface BreakdownCell {
  conversation_id: string
  model: string
  token_type: string
  tokens: number
  cost_usd: number
  tier2_cost_usd: number
  /**
   * POSITIVE evidence that this cell's money was priced PER TOKEN LANE: true =
   * every ledger row behind it was priced from one of our rate cards
   * (`rate_card_id IS NOT NULL`), which is the only way a span's cost is split
   * across token types at all. False = it was not — a credit-denominated
   * provider lane, or a span we never had a card for. See pricedPerLane below.
   *
   * NULL where the read simply does not carry the fact — the rollup readers
   * (consumption.ts, activity-detail.ts) build cells from sources that never
   * recorded it. NULL is "not asked", and it is NOT the reassuring answer:
   * `pricedPerLane` demands `true`, so a null never becomes a per-lane claim.
   *
   * ── WHY NOT `credit_qty IS NOT NULL` (what this used to be) ────────────────
   * `credit_qty` was ADDED by migration 0038 with NO backfill, so every Copilot
   * row written before it carries NULL — indistinguishable, on that operand,
   * from a token-priced Claude row. The old derivation therefore reported
   * "priced per lane" for all historical Copilot data and rendered its
   * structural zeros as real $0.00 lane prices: exactly the defect F3 exists to
   * remove, still live on every pre-0038 session. `rate_card_id` has been
   * NOT-NULL-on-card-priced-rows since 0001 and is NULL on every Copilot row by
   * construction (azure-monitor-reader.ts:1264, 1573), so it answers the same
   * question for the whole history — and it is migration 0091's own marker for
   * "we did not price this" (`rate_card_id IS NULL OR cost_basis =
   * 'provider-reported'`), not a third definition invented here.
   */
  lane_priced: boolean | null
}

interface CellRow extends Record<string, unknown> {
  conversation_id: string
  model: string
  token_type: string
  tokens: string
  cost_usd: string
  tier2_cost_usd: string
  lane_priced: boolean
}

/**
 * (model × token_type) cells for a set of conversations owned by `teammateId`.
 * A "conversation" is keyed on COALESCE(claude_session_id, instance_id::text)
 * — the same grouping the session list endpoints use. Bounded by the callers
 * (recent ≤50, untagged ≤100, detail = 1), so no pagination here.
 */
export async function fetchBreakdownCells(
  tx: Tx,
  teammateId: string,
  conversationIds: string[],
): Promise<BreakdownCell[]> {
  if (conversationIds.length === 0) return []
  // Explicit IN list: drizzle's sql template can't bind a JS array as a PG
  // array param here (22P02). Bounded by the callers (≤100 ids); it appears in
  // BOTH key arms below, so the bind count is 2× the id count.
  const inList = sql.join(
    conversationIds.map((id) => sql`${id}`),
    sql`, `,
  )
  const rows = await tx.execute<CellRow>(sql`
    SELECT
      ${conversationKeyExpr('ar')} AS conversation_id,
      ar.model,
      ar.token_type,
      SUM(ar.tokens)::text AS tokens,
      SUM(ar.cost_usd)::text AS cost_usd,
      COALESCE(SUM(ar.cost_usd) FILTER (WHERE ar.fidelity_tier = 'tier-2'), 0)::text AS tier2_cost_usd,
      -- Was this money priced PER TOKEN LANE (D14)? bool_AND, not bool_or: one
      -- row we never priced from a card is enough to make the cell's per-lane
      -- split structural rather than quoted. NOT credit_qty IS NOT NULL: that
      -- column was added by 0038 with no backfill, so it reads NULL on every
      -- historical Copilot row (see BreakdownCell.lane_priced).
      -- (No backticks anywhere in this literal — one inside a SQL comment CLOSES
      -- the sql template and the parse error points at the wrong line.)
      bool_and(ar.rate_card_id IS NOT NULL) AS lane_priced
    FROM attribution_record ar
    WHERE ar.teammate_id = ${teammateId}::uuid
      -- The OR-of-two-equalities shape conversation-key.ts documents, NEVER
      -- COALESCE(...) IN (...) — the COALESCE form drags EVERY row through an
      -- expression; here the claude_session_id arm is index-servable and the
      -- legacy instance_id::text arm (pre-0016 rows only) stays a filter
      -- bounded by the teammate qual
      -- (docs/design/request-floor-performance.md F6). A row matches when its
      -- claude_session_id hits the list, or (legacy pre-0016 rows only) when
      -- claude_session_id IS NULL and its instance id does — the same rows
      -- the COALESCE key selects.
      AND (ar.claude_session_id IN (${inList})
           OR (ar.claude_session_id IS NULL AND ar.instance_id::text IN (${inList})))
    GROUP BY ${conversationKeyExpr('ar')}, ar.model, ar.token_type
  `)
  return [...rows].map((r) => ({
    conversation_id: r.conversation_id,
    model: r.model,
    token_type: r.token_type,
    tokens: Number(r.tokens),
    cost_usd: Number(r.cost_usd),
    tier2_cost_usd: Number(r.tier2_cost_usd),
    lane_priced: r.lane_priced === true,
  }))
}

const usd = (n: number) => n.toFixed(n < 0.01 && n > 0 ? 4 : 2)

/** Group cells by conversation id (helper for list endpoints). */
export function groupCells(cells: BreakdownCell[]): Map<string, BreakdownCell[]> {
  const out = new Map<string, BreakdownCell[]>()
  for (const c of cells) {
    const list = out.get(c.conversation_id) ?? []
    list.push(c)
    out.set(c.conversation_id, list)
  }
  return out
}

/** Per-model slices, cost-share desc — the ModelBadge / model-mix input. */
export function pivotByModel(cells: BreakdownCell[]): ModelSpend[] {
  const agg = new Map<string, { tokens: number; cost: number }>()
  for (const c of cells) {
    const a = agg.get(c.model) ?? { tokens: 0, cost: 0 }
    a.tokens += c.tokens
    a.cost += c.cost_usd
    agg.set(c.model, a)
  }
  return [...agg.entries()]
    .sort((x, y) => y[1].cost - x[1].cost || y[1].tokens - x[1].tokens)
    .map(([model, a]) => ({ model, tokens: a.tokens, cost_usd: usd(a.cost) }))
}

/** Per-token-type slices (ledger vocabulary order: input, output, cache-read, cache-write). */
export function pivotByTokenType(cells: BreakdownCell[]): TokenTypeSpend[] {
  const ORDER = ['input', 'output', 'cache-read', 'cache-write']
  const agg = new Map<string, { tokens: number; cost: number }>()
  for (const c of cells) {
    const a = agg.get(c.token_type) ?? { tokens: 0, cost: 0 }
    a.tokens += c.tokens
    a.cost += c.cost_usd
    agg.set(c.token_type, a)
  }
  return [...agg.entries()]
    .sort((x, y) => {
      const ix = ORDER.indexOf(x[0])
      const iy = ORDER.indexOf(y[0])
      return (ix < 0 ? ORDER.length : ix) - (iy < 0 ? ORDER.length : iy)
    })
    .map(([token_type, a]) => ({ token_type, tokens: a.tokens, cost_usd: usd(a.cost) }))
}

/** The full (model × token_type) matrix, model cost-share desc then type order. */
export function toMatrix(cells: BreakdownCell[]): UsageMatrixCell[] {
  const modelOrder = pivotByModel(cells).map((m) => m.model)
  const typeOrder = pivotByTokenType(cells).map((t) => t.token_type)
  return [...cells]
    .sort(
      (a, b) =>
        modelOrder.indexOf(a.model) - modelOrder.indexOf(b.model) ||
        typeOrder.indexOf(a.token_type) - typeOrder.indexOf(b.token_type),
    )
    .map((c) => ({
      model: c.model,
      token_type: c.token_type,
      tokens: c.tokens,
      cost_usd: usd(c.cost_usd),
    }))
}

/** Estimated vs advisory split. tier1 = total − tier2 (tier2 ⊆ total). */
export function fidelitySplit(cells: BreakdownCell[]): FidelitySplit {
  let total = 0
  let tier2 = 0
  for (const c of cells) {
    total += c.cost_usd
    tier2 += c.tier2_cost_usd
  }
  return { tier1_cost_usd: usd(Math.max(0, total - tier2)), tier2_cost_usd: usd(tier2) }
}

/**
 * Cache economics, derived from the scope's OWN ledger rows so historical
 * (pinned) rates apply — no live rate-card join:
 *   - hit_ratio = cache_read / (cache_read + input); null when both are 0.
 *   - savings: per model with BOTH input and cache-read spend, the cache-read
 *     tokens repriced at that model's effective input rate minus their actual
 *     cost. Models missing an input row contribute nothing (conservative).
 *     null when NO model qualifies (ratio without price signal).
 */
export function cacheStats(cells: BreakdownCell[]): CacheStats {
  let readTokens = 0
  let writeTokens = 0
  let inputTokens = 0
  const perModel = new Map<string, { inTok: number; inCost: number; crTok: number; crCost: number }>()
  for (const c of cells) {
    if (c.token_type === 'cache-read') readTokens += c.tokens
    if (c.token_type === 'cache-write') writeTokens += c.tokens
    if (c.token_type === 'input') inputTokens += c.tokens
    if (c.token_type === 'input' || c.token_type === 'cache-read') {
      const m = perModel.get(c.model) ?? { inTok: 0, inCost: 0, crTok: 0, crCost: 0 }
      if (c.token_type === 'input') {
        m.inTok += c.tokens
        m.inCost += c.cost_usd
      } else {
        m.crTok += c.tokens
        m.crCost += c.cost_usd
      }
      perModel.set(c.model, m)
    }
  }
  const denom = readTokens + inputTokens
  let savings: number | null = null
  for (const m of perModel.values()) {
    if (m.inTok <= 0 || m.crTok <= 0) continue
    const inputRate = m.inCost / m.inTok
    savings = (savings ?? 0) + (m.crTok * inputRate - m.crCost)
  }
  return {
    read_tokens: readTokens,
    write_tokens: writeTokens,
    input_tokens: inputTokens,
    hit_ratio: denom > 0 ? Number((readTokens / denom).toFixed(4)) : null,
    savings_usd: savings === null ? null : usd(savings),
  }
}

/**
 * The list-endpoint enrichment block (recent / untagged rows): model order is
 * cost-share desc, so models[0] is the dominant model the UI chips.
 * advisory_cost_usd is the tier-2 (telemetry-only / backfill) share.
 */
export function breakdownFields(cells: BreakdownCell[]): {
  models: string[]
  by_model: ModelSpend[]
  by_token_type: TokenTypeSpend[]
  advisory_cost_usd: string
} {
  const byModel = pivotByModel(cells)
  return {
    models: byModel.map((m) => m.model),
    by_model: byModel,
    by_token_type: pivotByTokenType(cells),
    advisory_cost_usd: fidelitySplit(cells).tier2_cost_usd,
  }
}

// ── Priced-per-lane (fix-sprint F3, D14/D15) ─────────────────────────────

/**
 * D14 — is this scope's money actually quoted PER TOKEN LANE?
 *
 * THE OPERAND IS WHETHER WE PRICED IT FROM A RATE CARD, NOT THE PROVIDER'S
 * NAME. A span's cost is split across token types by exactly one mechanism —
 * the rate card's per-type lines (span-costing.ts) — and `rate_card_id` records
 * whether that mechanism ran. Where it did not, the whole span total sits on one
 * carrier lane and every other lane holds a structural 0. Any future
 * credit-priced lane inherits this answer for free; no `tool === 'copilot-cli'`
 * appears here, and none should.
 *
 * POSITIVE EVIDENCE IS REQUIRED, and that is the whole shape of it: this returns
 * true only when EVERY cell is known to have been card-priced. An unknown (a
 * reader that never carried the fact, or an empty scope) is not a per-lane
 * price, and defaulting it to the reassuring answer is how the previous
 * derivation shipped $0.00 lane prices for all historical Copilot data.
 *
 * WHY IT MATTERS. When a span cannot be priced per token type, span-costing
 * puts the WHOLE span total on one deterministic CARRIER lane
 * (span-costing.ts:61-76). That conserves the money exactly — Σ(lanes) is still
 * the span total — but the remaining lanes then hold a structural 0 that was
 * never a price. Displayed as money it reads "cache reads were free". This flag
 * is what lets the surface say the true thing instead.
 *
 * THE RESIDUAL BOUND, stated because the name over-promises otherwise: a span
 * that DID have a card, but whose card could not slice it (an unknown token
 * type, or a card that prices the span at <= 0), also lands on a carrier
 * (span-costing.ts:449-463) while still carrying a `rate_card_id`. The ledger
 * keeps no per-row marker for that case, so such a span still reports `true`
 * here. Narrowing it would need a new column, not a new derivation. This is a
 * strictly SMALLER hole than the one it replaced — "no card at all" used to fall
 * into it too, and no longer does.
 */
export function pricedPerLane(cells: BreakdownCell[]): boolean {
  // EVERY cell must be known card-priced. A cell whose pricing was never read
  // (null) is silent, and silence is not a price: it cannot carry the claim on
  // its own, and it cannot be out-voted into one by its neighbours either.
  // An empty scope has no evidence at all, so it makes no claim.
  return cells.length > 0 && cells.every((c) => c.lane_priced === true)
}

/** The lane-axis half of the session drill-down, honest about D15's NULL. */
export interface SessionLaneView {
  priced_per_lane: boolean
  by_token_type: SessionTokenTypeSpend[]
  matrix: SessionMatrixCell[]
  cache: CacheStats
}

/**
 * D15 — the lane axis of ONE session, with money either stated per lane or
 * declared absent. Pure, so the "NULL, not 0" decision is unit-testable.
 *
 * On a credit-priced session it also drops `cache.savings_usd`: that figure is
 * derived by repricing cache-read tokens at the model's effective INPUT rate
 * (cacheStats), and on a carrier span the input lane holds the whole span total
 * while cache-read holds 0 — so the subtraction would print a large, entirely
 * fabricated saving. The same defect class, one section down. `read_tokens` /
 * `write_tokens` / `hit_ratio` are token quantities and stay.
 */
export function sessionLaneView(cells: BreakdownCell[]): SessionLaneView {
  const priced = pricedPerLane(cells)
  const cache = cacheStats(cells)
  if (priced) {
    return {
      priced_per_lane: true,
      by_token_type: pivotByTokenType(cells),
      matrix: toMatrix(cells),
      cache,
    }
  }
  return {
    priced_per_lane: false,
    by_token_type: pivotByTokenType(cells).map((r) => ({ ...r, cost_usd: null })),
    matrix: toMatrix(cells).map((c) => ({ ...c, cost_usd: null })),
    cache: { ...cache, savings_usd: null },
  }
}

interface QuerySourceRow extends Record<string, unknown> {
  query_source: string | null
  tokens: string
  cost_usd: string
}

/**
 * Per-query-source slices for ONE conversation (mig 0045). NULL stays NULL —
 * pre-0045 rows are an unknown lane, not 'main'.
 */
export async function fetchQuerySourceSplit(
  tx: Tx,
  teammateId: string,
  conversationId: string,
): Promise<QuerySourceSpend[]> {
  const rows = await tx.execute<QuerySourceRow>(sql`
    SELECT ar.query_source,
           SUM(ar.tokens)::text AS tokens,
           SUM(ar.cost_usd)::text AS cost_usd
    FROM attribution_record ar
    WHERE ar.teammate_id = ${teammateId}::uuid
      -- OR of two equalities (claude arm index-servable; legacy arm a
      -- teammate-bounded filter), never COALESCE(...) = id — same constraint
      -- and legacy-arm semantics as fetchBreakdownCells above
      -- (conversation-key.ts; docs/design/request-floor-performance.md F6).
      AND (ar.claude_session_id = ${conversationId}
           OR (ar.claude_session_id IS NULL AND ar.instance_id::text = ${conversationId}))
    GROUP BY ar.query_source
    ORDER BY SUM(ar.cost_usd) DESC
  `)
  return [...rows].map((r) => ({
    query_source: r.query_source,
    tokens: Number(r.tokens),
    cost_usd: usd(Number(r.cost_usd)),
  }))
}
