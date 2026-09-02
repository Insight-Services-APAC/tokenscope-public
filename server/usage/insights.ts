/*
 * Insights engine — evidence-based usage findings + personalised lever
 * estimates (brief §4.2, adapted from AEUF's pattern-detector / R-lever
 * architecture with per-dev thresholds and OUR rate cards).
 *
 * Product principles enforced here:
 *   - evidence before advice: a lever shows a $ estimate ONLY when its
 *     detector fired on the dev's own 28-day window;
 *   - personalised: estimates derive from the dev's own cells × rate-card
 *     lines (a documented list-ratio fallback covers wildcard-only cards);
 *   - honest: every estimate carries its method in `evidence`, and
 *     conservatism factors are explicit constants, not vibes.
 *
 * Pure core: detectors take pre-fetched cells/catalog/rates and return
 * Finding[] — unit-testable with zero DB. Fetch helpers live at the bottom.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { classifyQuerySource } from '../../shared/usage/query-source'

type Tx = PostgresJsDatabase<Record<string, unknown>>

// ── Shapes ───────────────────────────────────────────────────────────────

/** One aggregate cell (teammate scope, daily grain) inside the window. */
export interface InsightCell {
  day: string
  tool: string
  model: string
  token_type: string
  query_source: string | null
  tokens: number
  cost_usd: number
}

export interface CatalogEntry {
  model_pattern: string
  tier: 'frontier' | 'workhorse' | 'lightweight' | 'specialised'
  sort_order: number
}

/**
 * One behavioural-signal aggregate cell (teammate scope, 28-day window),
 * grouped by (tool, signal_name) with count/sum/min/max — the NON-billing lane
 * (mig 0065). avg = sum/count. Detectors read these; tokens never mix in.
 */
export interface SignalCell {
  tool: string
  signal_name: string
  sample_count: number
  sum_value: number
  min_value: number
  max_value: number
}

/** Flattened rate_line (active card). model NULL = wildcard default. */
export interface RateLineLite {
  unit: string
  model: string | null
  unit_qty: number
  unit_cost_usd: number
}

export type PracticeGroup = 'tool-mastery' | 'context-management' | 'session-hygiene'

/** Every detector id — the ack endpoint's allowlist (single source). */
export const FINDING_IDS = [
  'cache-hit-starvation',
  'cache-write-churn',
  'frontier-overreliance',
  'model-concentration',
  'aux-overhead',
  // Copilot behavioural-signal detectors (mig 0065 lane; design:
  // docs/design/copilot-usage-signals.md). Informational (no $ estimate).
  'tool-surface-bloat',
  'context-saturation',
  'turn-churn',
] as const
export type FindingId = (typeof FINDING_IDS)[number]

export interface Finding {
  id: string
  severity: 'low' | 'medium'
  group: PracticeGroup
  headline: string
  /** Structured metrics backing the headline — every number the UI shows. */
  evidence: Record<string, number | string | null>
  /** Playbook levers this finding is evidence for (R1–R6). */
  related_levers: string[]
  /** Personalised $/month estimate; null = informational finding. */
  estimated_monthly_savings_usd: string | null
}

// ── Thresholds (brief §4.2 — sign-off 2026-06-10) ───────────────────────

export const THRESHOLDS = {
  /** cache-hit-starvation: hit ratio below this on enough prompt volume. */
  CACHE_HIT_MIN_RATIO: 0.25,
  CACHE_HIT_MIN_PROMPT_TOKENS: 2_000_000,
  /** Savings model: what the ratio could plausibly rise to with R2/R3. */
  CACHE_HIT_TARGET_RATIO: 0.5,
  /** cache-write-churn: writes exceeding reads by this factor. */
  CACHE_CHURN_WRITE_OVER_READ: 1.5,
  CACHE_CHURN_MIN_CACHE_TOKENS: 2_000_000,
  /** frontier-overreliance (per-dev floors, not AEUF's org floors). */
  FRONTIER_MIN_SHARE: 0.8,
  FRONTIER_MIN_SPEND_USD: 50,
  FRONTIER_MIN_CLASSIFIED_RATIO: 0.5,
  /** model-concentration. */
  CONCENTRATION_TOP_SHARE: 0.9,
  CONCENTRATION_MAX_DISTINCT: 2,
  CONCENTRATION_MIN_SPEND_USD: 50,
  /** aux-overhead: harness lanes vs everything classified. */
  AUX_MIN_TOKEN_SHARE: 0.15,
  AUX_MIN_TOKENS: 1_000_000,
  /**
   * aux-overhead: the FLOOR ON THE OTHER HALF OF THE RATIO. `aux_share` is
   * aux/(main+aux), so an empty (or near-empty) main lane pins it at ~1 whatever
   * the aux volume is — "no conversation-lane signal" wearing the costume of
   * "all of your volume is overhead". 10k tokens is a couple of real turns: below
   * it the main lane is noise, not a denominator, and the detector stays silent.
   */
  AUX_MIN_MAIN_TOKENS: 10_000,
  /** Estimate conservatism: applied to behavioural-change estimates. */
  CONSERVATISM: 0.5,
  /** Workhorse/frontier blended-rate ratio when the rate card is
   * wildcard-only (Anthropic list: Sonnet ≈ 1/5 of Opus per token). */
  LIST_RATIO_FALLBACK: 0.2,
  /** Findings with an estimate at/above this are severity 'medium'. */
  MEDIUM_SEVERITY_MIN_USD: 10,
  /** 28-day window → calendar-month scale. */
  MONTHLY_SCALE: 30 / 28,
  // ── Copilot behavioural signals (mig 0065) — PROVISIONAL, MS/Anthropic-informed.
  // These are sign-off constants awaiting real-data calibration (see design doc).
  /** Min signal observations in the window before a behavioural detector fires. */
  SIGNAL_MIN_SAMPLES: 20,
  /** tool-surface-bloat: avg tool definitions / MCP servers loaded per request. */
  TOOL_BLOAT_AVG_TOOLS: 30, // MS field guidance: ~13 essential vs ~40 loaded
  TOOL_BLOAT_AVG_MCP: 6,
  /** context-saturation: peak AND typical % of the context window used. */
  CTX_SATURATION_MAX_PCT: 90,
  CTX_SATURATION_AVG_PCT: 60,
  /** turn-churn: avg agent-turn iterations per invocation. */
  TURN_CHURN_AVG: 8,
} as const

const usd = (n: number) => n.toFixed(2)

// ── Tier resolution ─────────────────────────────────────────────────────

/** Substring match against lower(model), first match by sort_order. */
export function resolveTier(model: string, catalog: CatalogEntry[]): CatalogEntry['tier'] | null {
  const id = model.toLowerCase()
  let best: CatalogEntry | null = null
  for (const entry of catalog) {
    if (!id.includes(entry.model_pattern.toLowerCase())) continue
    if (!best || entry.sort_order < best.sort_order) best = entry
  }
  return best?.tier ?? null
}

// ── Rate helpers ─────────────────────────────────────────────────────────

/** $/token for a unit, preferring an exact-model line over the wildcard. */
function ratePerToken(lines: RateLineLite[], unit: string, model: string): number | null {
  const candidates = lines.filter((l) => l.unit === unit && l.unit_qty > 0)
  const exact = candidates.find((l) => l.model === model)
  const line = exact ?? candidates.find((l) => l.model === null)
  if (!line) return null
  return line.unit_cost_usd / line.unit_qty
}

/**
 * AEUF's blended $/turn (5k input / 1k output / 40% cached) over OUR rate
 * lines — used for the workhorse-vs-frontier cost ratio. Null when the card
 * has no rates for the model (caller falls back to LIST_RATIO_FALLBACK).
 */
export function blendedCostPerTurn(lines: RateLineLite[], model: string): number | null {
  const input = ratePerToken(lines, 'input', model)
  const output = ratePerToken(lines, 'output', model)
  const cached = ratePerToken(lines, 'cache-read', model) ?? input
  if (input == null || output == null || cached == null) return null
  return 5000 * 0.6 * input + 5000 * 0.4 * cached + 1000 * output
}

// ── Compounding (AEUF forecast.py:87 port) ───────────────────────────────

/** Multiplicative compounding of savings fractions: 1 − Π(1 − sᵢ). */
export function compoundSavings(fractions: number[]): number {
  let multiplier = 1
  for (const s of fractions) {
    multiplier *= 1 - Math.min(1, Math.max(0, s))
  }
  return 1 - multiplier
}

// ── Detectors ────────────────────────────────────────────────────────────

interface LaneTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  inputCost: number
  cacheReadCost: number
  cacheWriteCost: number
}

function laneTotals(cells: InsightCell[]): LaneTotals {
  const t: LaneTotals = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    inputCost: 0, cacheReadCost: 0, cacheWriteCost: 0,
  }
  for (const c of cells) {
    if (c.token_type === 'input') { t.input += c.tokens; t.inputCost += c.cost_usd }
    else if (c.token_type === 'output') t.output += c.tokens
    else if (c.token_type === 'cache-read') { t.cacheRead += c.tokens; t.cacheReadCost += c.cost_usd }
    else if (c.token_type === 'cache-write') { t.cacheWrite += c.tokens; t.cacheWriteCost += c.cost_usd }
  }
  return t
}

function severityFor(estimate: number | null): 'low' | 'medium' {
  return estimate !== null && estimate >= THRESHOLDS.MEDIUM_SEVERITY_MIN_USD ? 'medium' : 'low'
}

function detectCacheHitStarvation(cells: InsightCell[], lines: RateLineLite[]): Finding | null {
  const t = laneTotals(cells)
  const promptTokens = t.input + t.cacheRead
  if (promptTokens < THRESHOLDS.CACHE_HIT_MIN_PROMPT_TOKENS) return null
  const hit = t.cacheRead / promptTokens
  if (hit >= THRESHOLDS.CACHE_HIT_MIN_RATIO) return null

  // Savings: tokens that would move input → cache-read if the ratio rose to
  // the target, priced at the (default-line) input-vs-cache-read delta.
  const inputRate = ratePerToken(lines, 'input', '')
  const cacheRate = ratePerToken(lines, 'cache-read', '')
  let estimate: number | null = null
  let method = 'no-rates'
  if (inputRate != null && cacheRate != null && inputRate > cacheRate) {
    const movedTokens = (THRESHOLDS.CACHE_HIT_TARGET_RATIO - hit) * promptTokens
    estimate =
      movedTokens * (inputRate - cacheRate) * THRESHOLDS.CONSERVATISM * THRESHOLDS.MONTHLY_SCALE
    method = `moved-tokens × (input − cache-read rate) × ${THRESHOLDS.CONSERVATISM} conservatism, scaled 28d→month`
  }
  return {
    id: 'cache-hit-starvation',
    severity: severityFor(estimate),
    group: 'context-management',
    headline: `${Math.round(hit * 100)}% of your prompt volume came from cache over the last 28 days (typical healthy sessions sit well above ${Math.round(
      THRESHOLDS.CACHE_HIT_MIN_RATIO * 100,
    )}%). Long prompts are paying full price for context the model has already seen.`,
    evidence: {
      fresh_input_tokens: t.input,
      cache_read_tokens: t.cacheRead,
      prompt_total_tokens: promptTokens,
      cache_hit_ratio: Number(hit.toFixed(4)),
      threshold: THRESHOLDS.CACHE_HIT_MIN_RATIO,
      target_ratio: THRESHOLDS.CACHE_HIT_TARGET_RATIO,
      estimate_method: method,
    },
    related_levers: ['R2', 'R3'],
    estimated_monthly_savings_usd: estimate === null ? null : usd(estimate),
  }
}

function detectCacheWriteChurn(cells: InsightCell[]): Finding | null {
  const t = laneTotals(cells)
  const cacheTokens = t.cacheRead + t.cacheWrite
  if (cacheTokens < THRESHOLDS.CACHE_CHURN_MIN_CACHE_TOKENS) return null
  if (t.cacheWrite <= THRESHOLDS.CACHE_CHURN_WRITE_OVER_READ * t.cacheRead) return null

  // The share of cache-write spend not "justified" by reads, conservatively.
  const justified = t.cacheWrite > 0 ? Math.min(1, t.cacheRead / t.cacheWrite) : 1
  const estimate =
    t.cacheWriteCost * (1 - justified) * THRESHOLDS.CONSERVATISM * THRESHOLDS.MONTHLY_SCALE
  return {
    id: 'cache-write-churn',
    severity: severityFor(estimate),
    group: 'session-hygiene',
    headline: `You wrote ${Math.round(
      t.cacheWrite / 1_000_000,
    )}M tokens to cache but read back only ${Math.round(
      t.cacheRead / 1_000_000,
    )}M over the last 28 days — paying to cache context that is rarely re-used. Carrying context across unrelated tasks is the usual cause.`,
    evidence: {
      cache_write_tokens: t.cacheWrite,
      cache_read_tokens: t.cacheRead,
      cache_write_cost_usd: usd(t.cacheWriteCost),
      write_over_read_threshold: THRESHOLDS.CACHE_CHURN_WRITE_OVER_READ,
      estimate_method: `unjustified write-spend share × ${THRESHOLDS.CONSERVATISM} conservatism, scaled 28d→month`,
    },
    related_levers: ['R6', 'R2'],
    estimated_monthly_savings_usd: usd(estimate),
  }
}

function detectFrontierOverreliance(
  cells: InsightCell[],
  catalog: CatalogEntry[],
  lines: RateLineLite[],
): Finding | null {
  const byModel = new Map<string, number>()
  for (const c of cells) byModel.set(c.model, (byModel.get(c.model) ?? 0) + c.cost_usd)
  let total = 0
  let classified = 0
  let frontier = 0
  let topFrontierModel = ''
  let topFrontierCost = 0
  for (const [model, cost] of byModel) {
    total += cost
    const tier = resolveTier(model, catalog)
    if (!tier) continue
    classified += cost
    if (tier === 'frontier') {
      frontier += cost
      if (cost > topFrontierCost) {
        topFrontierCost = cost
        topFrontierModel = model
      }
    }
  }
  if (total < THRESHOLDS.FRONTIER_MIN_SPEND_USD) return null
  /*
   * DEGENERATE DENOMINATOR — refuse before dividing, not with a ternary.
   *
   * `share` is frontier/classified, and `classified` is only non-zero because
   * `model_catalog` matched at least one model. An unseeded/failed catalog
   * classifies nothing, and the finding would then be a statement about the
   * catalog, not about the teammate. Today FRONTIER_MIN_CLASSIFIED_RATIO (0.5)
   * makes that unreachable — which is exactly why it is stated POSITIVELY here:
   * the invariant must not rest on the value of a threshold declared elsewhere,
   * because setting that threshold to 0 would silently reopen it.
   */
  if (classified <= 0) return null
  if (classified / total < THRESHOLDS.FRONTIER_MIN_CLASSIFIED_RATIO) return null
  const share = frontier / classified
  if (share <= THRESHOLDS.FRONTIER_MIN_SHARE) return null

  // Workhorse/frontier blended-rate ratio from OUR rate card; documented
  // list-ratio fallback when the card is wildcard-only (ratio would be 1).
  const frontierTurn = blendedCostPerTurn(lines, topFrontierModel)
  const workhorseTurn = blendedCostPerTurn(lines, 'claude-sonnet')
  let ratio = THRESHOLDS.LIST_RATIO_FALLBACK
  let method = `list-ratio fallback (${THRESHOLDS.LIST_RATIO_FALLBACK})`
  if (frontierTurn != null && workhorseTurn != null && workhorseTurn < frontierTurn) {
    ratio = workhorseTurn / frontierTurn
    method = 'blended $/turn ratio from rate card'
  }
  const estimate =
    frontier * (1 - ratio) * THRESHOLDS.CONSERVATISM * THRESHOLDS.MONTHLY_SCALE
  return {
    id: 'frontier-overreliance',
    severity: severityFor(estimate),
    group: 'tool-mastery',
    headline: `${Math.round(
      share * 100,
    )}% of your classified spend runs on frontier-tier models. Many routine tasks tolerate a workhorse-tier model at a fraction of the token cost — worth a try where the task allows.`,
    evidence: {
      frontier_spend_usd: usd(frontier),
      classified_spend_usd: usd(classified),
      total_spend_usd: usd(total),
      frontier_share: Number(share.toFixed(4)),
      threshold: THRESHOLDS.FRONTIER_MIN_SHARE,
      top_frontier_model: topFrontierModel,
      rate_ratio: Number(ratio.toFixed(4)),
      estimate_method: `frontier spend × (1 − ${method}) × ${THRESHOLDS.CONSERVATISM} conservatism, scaled 28d→month`,
    },
    related_levers: ['R1'],
    estimated_monthly_savings_usd: usd(estimate),
  }
}

function detectModelConcentration(cells: InsightCell[]): Finding | null {
  const byModel = new Map<string, number>()
  let total = 0
  for (const c of cells) {
    byModel.set(c.model, (byModel.get(c.model) ?? 0) + c.cost_usd)
    total += c.cost_usd
  }
  if (total < THRESHOLDS.CONCENTRATION_MIN_SPEND_USD) return null
  if (byModel.size > THRESHOLDS.CONCENTRATION_MAX_DISTINCT) return null
  const [topModel, topCost] = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
  const share = total > 0 ? topCost / total : 0
  if (share <= THRESHOLDS.CONCENTRATION_TOP_SHARE) return null
  return {
    id: 'model-concentration',
    severity: 'low',
    group: 'tool-mastery',
    headline: `${Math.round(share * 100)}% of your spend goes to a single model (${topModel}) across only ${byModel.size} distinct model${
      byModel.size === 1 ? '' : 's'
    }. Different tasks benefit from different models — the playbook's routing lever has examples.`,
    evidence: {
      top_model: topModel,
      top_share: Number(share.toFixed(4)),
      distinct_models: byModel.size,
      total_spend_usd: usd(total),
      max_share_threshold: THRESHOLDS.CONCENTRATION_TOP_SHARE,
    },
    related_levers: ['R1'],
    estimated_monthly_savings_usd: null,
  }
}

function detectAuxOverhead(cells: InsightCell[]): Finding | null {
  // Unknown query_source = pre-0045 capture / attr absent — EXCLUDED from both
  // sides so legacy data can never fabricate a finding. The main-vs-aux test is
  // the shared classifier, NOT `=== 'main'`: no emitter sends that literal for
  // Claude Code (shared/usage/query-source.ts).
  let main = 0
  let aux = 0
  let auxCost = 0
  for (const c of cells) {
    const lane = classifyQuerySource(c.query_source)
    if (lane === 'unknown') continue
    if (lane === 'main') main += c.tokens
    else {
      aux += c.tokens
      auxCost += c.cost_usd
    }
  }
  const known = main + aux
  if (known < THRESHOLDS.AUX_MIN_TOKENS) return null
  /*
   * DEGENERATE DENOMINATOR — refuse, do not publish.
   *
   * `share` is aux/(main+aux). An empty main lane drives it to exactly 1 and
   * turns "we have no conversation-lane signal" into the finding "100% of your
   * volume is harness overhead", with a $/month estimate attached. Those two
   * are not the same claim, and this detector cannot tell them apart from the
   * ratio alone — so it declines to speak when the denominator has only one
   * half. A missing main lane is an INGESTION question (a renamed emitter
   * vocabulary, a dropped attribute), never a savings recommendation.
   */
  if (main < THRESHOLDS.AUX_MIN_MAIN_TOKENS) return null
  const share = aux / known
  if (share <= THRESHOLDS.AUX_MIN_TOKEN_SHARE) return null
  const excessShare = share - THRESHOLDS.AUX_MIN_TOKEN_SHARE
  const estimate = auxCost * (excessShare / share) * THRESHOLDS.MONTHLY_SCALE
  return {
    id: 'aux-overhead',
    severity: severityFor(estimate),
    group: 'tool-mastery',
    headline: `${Math.round(
      share * 100,
    )}% of your classified token volume is harness overhead (auxiliary lanes like title generation), not your conversations. Output filtering keeps the harness lanes lean.`,
    evidence: {
      aux_tokens: aux,
      main_tokens: main,
      aux_share: Number(share.toFixed(4)),
      aux_cost_usd: usd(auxCost),
      threshold: THRESHOLDS.AUX_MIN_TOKEN_SHARE,
      estimate_method: 'aux cost × excess share over threshold, scaled 28d→month',
    },
    related_levers: ['R4'],
    estimated_monthly_savings_usd: usd(estimate),
  }
}

// ── Behavioural-signal detectors (mig 0065, Copilot lane) ────────────────────
// These read SignalCell[] (NON-token), are informational (no $ estimate), and key
// on the same evidence-before-advice contract. Thresholds are PROVISIONAL — see
// docs/design/copilot-usage-signals.md. Claude emits none of these signals, so the
// detectors are naturally inert for Claude-only teammates.

interface SignalStat {
  count: number
  avg: number
  min: number
  max: number
}

/** Combined stat for a signal across cells (tool-agnostic; signals are single-tool today). */
function signalStat(cells: SignalCell[], name: string): SignalStat | null {
  let count = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const c of cells) {
    if (c.signal_name !== name) continue
    count += c.sample_count
    sum += c.sum_value
    min = Math.min(min, c.min_value)
    max = Math.max(max, c.max_value)
  }
  if (count <= 0 || !Number.isFinite(min) || !Number.isFinite(max)) return null
  return { count, avg: sum / count, min, max }
}

function detectToolSurfaceBloat(cells: SignalCell[]): Finding | null {
  const tools = signalStat(cells, 'tool_count')
  const mcp = signalStat(cells, 'mcp_count')
  // Need enough samples on at least one lane to say anything.
  // A lane only contributes (to firing AND to the headline/evidence) when it has
  // enough samples — symmetric guards so the headline never quotes an average from
  // a lane it deemed too thin to fire on.
  const toolsOk = !!tools && tools.count >= THRESHOLDS.SIGNAL_MIN_SAMPLES
  const mcpOk = !!mcp && mcp.count >= THRESHOLDS.SIGNAL_MIN_SAMPLES
  const toolsFire = toolsOk && tools!.avg >= THRESHOLDS.TOOL_BLOAT_AVG_TOOLS
  const mcpFire = mcpOk && mcp!.avg >= THRESHOLDS.TOOL_BLOAT_AVG_MCP
  if (!toolsFire && !mcpFire) return null

  const parts: string[] = []
  if (toolsOk) parts.push(`${Math.round(tools!.avg)} tool definitions`)
  if (mcpOk) parts.push(`${Math.round(mcp!.avg)} MCP servers`)
  return {
    id: 'tool-surface-bloat',
    severity: 'low',
    group: 'tool-mastery',
    headline: `Your sessions carry a large tool surface — on average ${parts.join(
      ' and ',
    )} are advertised to the model. Every tool's schema is re-sent as input on each request; curating to the handful you actually use trims that overhead on every turn.`,
    evidence: {
      // null when below the sample floor — never quote an under-sampled average.
      avg_tool_count: toolsOk ? Number(tools!.avg.toFixed(1)) : null,
      max_tool_count: toolsOk ? tools!.max : null,
      avg_mcp_count: mcpOk ? Number(mcp!.avg.toFixed(1)) : null,
      max_mcp_count: mcpOk ? mcp!.max : null,
      tool_threshold: THRESHOLDS.TOOL_BLOAT_AVG_TOOLS,
      mcp_threshold: THRESHOLDS.TOOL_BLOAT_AVG_MCP,
      samples: (toolsOk ? tools!.count : 0) + (mcpOk ? mcp!.count : 0),
    },
    related_levers: ['R7'],
    estimated_monthly_savings_usd: null,
  }
}

function detectContextSaturation(cells: SignalCell[]): Finding | null {
  const ctx = signalStat(cells, 'ctx_pct')
  if (!ctx || ctx.count < THRESHOLDS.SIGNAL_MIN_SAMPLES) return null
  // Fire only when the window is BOTH peaked (a real ceiling hit) AND typically
  // high (not a single outlier) — avoids nagging on the occasional long session.
  if (ctx.max < THRESHOLDS.CTX_SATURATION_MAX_PCT || ctx.avg < THRESHOLDS.CTX_SATURATION_AVG_PCT) return null
  // Clamp the DISPLAYED percentage at 100 (the emit-time cap lives in the
  // transcoder; clamp again here so a hand-inserted/backfilled row can never make
  // the headline claim "peaking at 140%"). Firing still keys off the raw value.
  const maxPct = Math.min(100, Math.round(ctx.max))
  const avgPct = Math.min(100, Number(ctx.avg.toFixed(1)))
  return {
    id: 'context-saturation',
    severity: 'low',
    group: 'context-management',
    headline: `Your sessions regularly run near the context ceiling — peaking at ${maxPct}% of the window with a ${Math.round(
      avgPct,
    )}% average. Compacting or clearing before it fills avoids paying to re-read a bloated context (and the auto-compaction churn that follows).`,
    evidence: {
      max_ctx_pct: maxPct,
      avg_ctx_pct: avgPct,
      max_threshold: THRESHOLDS.CTX_SATURATION_MAX_PCT,
      avg_threshold: THRESHOLDS.CTX_SATURATION_AVG_PCT,
      samples: ctx.count,
    },
    related_levers: ['R2'],
    estimated_monthly_savings_usd: null,
  }
}

function detectTurnChurn(cells: SignalCell[]): Finding | null {
  const turns = signalStat(cells, 'turn_count')
  if (!turns || turns.count < THRESHOLDS.SIGNAL_MIN_SAMPLES) return null
  if (turns.avg < THRESHOLDS.TURN_CHURN_AVG) return null
  return {
    id: 'turn-churn',
    severity: 'low',
    group: 'session-hygiene',
    headline: `Your agent turns average ${Math.round(
      turns.avg,
    )} iterations (peaking at ${Math.round(
      turns.max,
    )}). Tighter, more specific prompts — or planning the change before executing — reach the same outcome in fewer paid round-trips.`,
    evidence: {
      avg_turn_count: Number(turns.avg.toFixed(1)),
      max_turn_count: turns.max,
      threshold: THRESHOLDS.TURN_CHURN_AVG,
      samples: turns.count,
    },
    related_levers: ['R8'],
    estimated_monthly_savings_usd: null,
  }
}

/**
 * Run every detector over a teammate's 28-day window. Severity-ordered
 * (medium first, then by estimate desc); the ENDPOINT applies ack filtering
 * and the max-3 display cap — the engine reports everything it sees.
 *
 * `signalCells` is the NON-token behavioural lane (mig 0065); it defaults to []
 * so token-only callers (and existing tests) are unaffected. Signal detectors are
 * informational (low severity, null estimate), so they sort below any $-bearing
 * token finding and surface when the cap has room.
 */
export function detectFindings(
  cells: InsightCell[],
  catalog: CatalogEntry[],
  lines: RateLineLite[],
  signalCells: SignalCell[] = [],
): Finding[] {
  const findings = [
    detectCacheHitStarvation(cells, lines),
    detectCacheWriteChurn(cells),
    detectFrontierOverreliance(cells, catalog, lines),
    detectModelConcentration(cells),
    detectAuxOverhead(cells),
    detectToolSurfaceBloat(signalCells),
    detectContextSaturation(signalCells),
    detectTurnChurn(signalCells),
  ].filter((f): f is Finding => f !== null)
  return findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'medium' ? -1 : 1
    return (
      Number(b.estimated_monthly_savings_usd ?? 0) - Number(a.estimated_monthly_savings_usd ?? 0)
    )
  })
}

// ── Fetch helpers (thin; endpoints pass the RLS-bound tx) ────────────────

interface CellRow extends Record<string, unknown> {
  day: string
  tool: string
  model: string
  token_type: string
  query_source: string | null
  tokens: string
  cost_usd: string
}

/** A teammate's daily aggregate cells for the trailing `days` window. */
export async function fetchInsightCells(
  tx: Tx,
  teammateId: string,
  days = 28,
): Promise<InsightCell[]> {
  const rows = await tx.execute<CellRow>(sql`
    SELECT (period_start AT TIME ZONE 'UTC')::date::text AS day,
           tool, model, token_type, query_source,
           SUM(total_tokens)::text AS tokens,
           SUM(total_cost_usd)::text AS cost_usd
    FROM attribution_aggregate
    WHERE scope_type = 'teammate'
      AND scope_id = ${teammateId}::uuid
      AND period_kind = 'day'
      AND period_start >= (now() - make_interval(days => ${days}))
    GROUP BY 1, tool, model, token_type, query_source
  `)
  return [...rows].map((r) => ({
    day: r.day,
    tool: r.tool,
    model: r.model,
    token_type: r.token_type,
    query_source: r.query_source,
    tokens: Number(r.tokens),
    cost_usd: Number(r.cost_usd),
  }))
}

interface SignalCellRow extends Record<string, unknown> {
  tool: string
  signal_name: string
  sample_count: string
  sum_value: string
  min_value: string
  max_value: string
}

/**
 * A teammate's behavioural-signal stats over the trailing `days` window —
 * aggregated ON READ from the raw usage_signal_record (mig 0065), grouped by
 * (tool, signal_name) with count/sum/min/max. This is the SWAP SEAM: if signal
 * volume ever needs pre-materialising, point this at a rollup table without
 * touching a detector. Filters teammate_id explicitly (read scoping is correct
 * even where RLS is bypassed, e.g. the owner connection).
 */
export async function fetchSignalCells(
  tx: Tx,
  teammateId: string,
  days = 28,
): Promise<SignalCell[]> {
  const rows = await tx.execute<SignalCellRow>(sql`
    SELECT tool, signal_name,
           COUNT(*)::text          AS sample_count,
           SUM(value)::text        AS sum_value,
           MIN(value)::text        AS min_value,
           MAX(value)::text        AS max_value
    FROM usage_signal_record
    WHERE teammate_id = ${teammateId}::uuid
      AND ts_event >= (now() - make_interval(days => ${days}))
    GROUP BY tool, signal_name
  `)
  return [...rows].map((r) => ({
    tool: r.tool,
    signal_name: r.signal_name,
    sample_count: Number(r.sample_count),
    sum_value: Number(r.sum_value),
    min_value: Number(r.min_value),
    max_value: Number(r.max_value),
  }))
}

export async function fetchCatalog(tx: Tx): Promise<CatalogEntry[]> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    SELECT model_pattern, tier, sort_order FROM model_catalog WHERE is_active = true
  `)
  return [...rows].map((r) => ({
    model_pattern: String(r.model_pattern),
    tier: String(r.tier) as CatalogEntry['tier'],
    sort_order: Number(r.sort_order),
  }))
}

/** Rate lines of the ACTIVE anthropic:claude-code card (estimates only). */
export async function fetchRateLines(tx: Tx): Promise<RateLineLite[]> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    SELECT rl.unit, rl.model, rl.unit_qty::text AS unit_qty, rl.unit_cost_usd::text AS unit_cost_usd
    FROM rate_line rl
    JOIN rate_card rc ON rc.id = rl.rate_card_id
    WHERE rc.scope_key = 'anthropic:claude-code'
      AND rc.retired_at IS NULL
      AND rc.effective @> now()
  `)
  return [...rows].map((r) => ({
    unit: String(r.unit),
    model: r.model === null ? null : String(r.model),
    unit_qty: Number(r.unit_qty),
    unit_cost_usd: Number(r.unit_cost_usd),
  }))
}
