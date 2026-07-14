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
}

interface CellRow extends Record<string, unknown> {
  conversation_id: string
  model: string
  token_type: string
  tokens: string
  cost_usd: string
  tier2_cost_usd: string
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
  // array param here (22P02). Bounded by the callers (≤100 ids).
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
      COALESCE(SUM(ar.cost_usd) FILTER (WHERE ar.fidelity_tier = 'tier-2'), 0)::text AS tier2_cost_usd
    FROM attribution_record ar
    WHERE ar.teammate_id = ${teammateId}::uuid
      AND ${conversationKeyExpr('ar')} IN (${inList})
    GROUP BY ${conversationKeyExpr('ar')}, ar.model, ar.token_type
  `)
  return [...rows].map((r) => ({
    conversation_id: r.conversation_id,
    model: r.model,
    token_type: r.token_type,
    tokens: Number(r.tokens),
    cost_usd: Number(r.cost_usd),
    tier2_cost_usd: Number(r.tier2_cost_usd),
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
      AND ${conversationKeyExpr('ar')} = ${conversationId}
    GROUP BY ar.query_source
    ORDER BY SUM(ar.cost_usd) DESC
  `)
  return [...rows].map((r) => ({
    query_source: r.query_source,
    tokens: Number(r.tokens),
    cost_usd: usd(Number(r.cost_usd)),
  }))
}
