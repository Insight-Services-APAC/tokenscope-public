/*
 * Usage-breakdown vocabulary — the response shapes for per-session /
 * per-scope spend granularity (design: docs/design/session-granularity-sprint.md
 * §0.5.3). Defined ONCE here and reused verbatim by the session endpoints,
 * the CSV export, the UI primitives, and (next sprint) the My Consumption /
 * My Projects endpoints. Server-side aggregation lives in
 * server/usage/breakdowns.ts; these schemas are the contract.
 *
 * Money is always a STRING (decimal-formatted USD), token counts are numbers
 * — matching the existing /me API conventions.
 */
import { z } from 'zod'

/** rate_line.unit vocabulary — the four token lanes of one api_request. */
export const TOKEN_TYPES = ['input', 'output', 'cache-read', 'cache-write'] as const
export type TokenType = (typeof TOKEN_TYPES)[number]

/** Per-model slice of a scope's spend, ordered by cost share (desc). */
export const ModelSpend = z.object({
  model: z.string(),
  tokens: z.number(),
  cost_usd: z.string(),
})
export type ModelSpend = z.infer<typeof ModelSpend>

/** Per-token-type slice of a scope's spend. */
export const TokenTypeSpend = z.object({
  token_type: z.string(),
  tokens: z.number(),
  cost_usd: z.string(),
})
export type TokenTypeSpend = z.infer<typeof TokenTypeSpend>

/** One (model × token_type) cell of the session detail matrix. */
export const UsageMatrixCell = z.object({
  model: z.string(),
  token_type: z.string(),
  tokens: z.number(),
  cost_usd: z.string(),
})
export type UsageMatrixCell = z.infer<typeof UsageMatrixCell>

/*
 * ── The "not priced per lane" pair (fix-sprint F3 / D15) ──────────────────
 *
 * Some providers do not quote a price PER TOKEN LANE at all. A credit-priced
 * lane (GitHub Copilot today) bills in AI credits for the whole request, so the
 * ledger conserves that one figure by placing it on a single deterministic
 * CARRIER token type (server/usage/span-costing.ts:61-76). Σ(lanes) is then
 * still exactly the span total — correct arithmetic — but the OTHER lanes hold
 * a structural 0 that was never a price.
 *
 * Rendering that 0 as money says "cache reads were free". They were not; the
 * provider simply never priced them separately. So the wire gets a way to SAY
 * SO: cost_usd is nullable on these two shapes, and NULL means **not priced per
 * lane**, never zero. A genuine measured zero is still '0.00'.
 *
 * Deliberately NOT applied to the shared TokenTypeSpend / UsageMatrixCell:
 * those serve list rows and scope rollups whose consumers all read money as a
 * string. Only the session drill-down — the surface that shows the four lanes
 * side by side, where the lie is legible — opts in.
 */
export const SessionTokenTypeSpend = TokenTypeSpend.extend({
  /** NULL = this provider does not price per token lane (see above). */
  cost_usd: z.string().nullable(),
})
export type SessionTokenTypeSpend = z.infer<typeof SessionTokenTypeSpend>

export const SessionMatrixCell = UsageMatrixCell.extend({
  /** NULL = this provider does not price per token lane (see above). */
  cost_usd: z.string().nullable(),
})
export type SessionMatrixCell = z.infer<typeof SessionMatrixCell>

/**
 * Per-query-source slice (mig 0045). `query_source` NULL = captured before
 * the attr existed / unknown lane — render as unknown, never fold into 'main'.
 */
export const QuerySourceSpend = z.object({
  query_source: z.string().nullable(),
  tokens: z.number(),
  cost_usd: z.string(),
})
export type QuerySourceSpend = z.infer<typeof QuerySourceSpend>

/**
 * Cache economics for a scope. hit_ratio = cache_read / (cache_read + input),
 * null when that denominator is 0. savings_usd = what the cache-read tokens
 * WOULD have cost at each model's effective input rate minus what they did
 * cost — derived per model from the scope's own ledger rows (pinned
 * historical rates), null when no model has both input and cache-read spend.
 */
export const CacheStats = z.object({
  read_tokens: z.number(),
  write_tokens: z.number(),
  input_tokens: z.number(),
  hit_ratio: z.number().nullable(),
  savings_usd: z.string().nullable(),
})
export type CacheStats = z.infer<typeof CacheStats>

/** Estimated (tier-1) vs advisory (tier-2 / telemetry-only) split. */
export const FidelitySplit = z.object({
  tier1_cost_usd: z.string(),
  tier2_cost_usd: z.string(),
})
export type FidelitySplit = z.infer<typeof FidelitySplit>

// ── Consumption / projects dashboards (night sprint, brief §6.4) ─────────

/** Trailing-window selector shared by the dashboard endpoints. */
export const WindowQuery = z.object({
  window: z.coerce
    .number()
    .int()
    .refine((v) => v === 30 || v === 90, 'window must be 30 or 90')
    .default(30),
})
export type WindowQuery = z.infer<typeof WindowQuery>

export const DaySpend = z.object({
  day: z.string(), // 'YYYY-MM-DD' (UTC); gap days are absent, charts pad
  cost_usd: z.string(),
  tokens: z.number(),
})
export type DaySpend = z.infer<typeof DaySpend>

export const ModelDaySpend = z.object({
  day: z.string(),
  model: z.string(),
  cost_usd: z.string(),
})
export type ModelDaySpend = z.infer<typeof ModelDaySpend>

export const RunRate = z.object({
  projected_month_end_usd: z.string(),
  days_elapsed: z.number(),
  days_in_month: z.number(),
  method: z.literal('linear-mtd'),
  /**
   * False on the last day of the month, where the linear scale factor is 1 and
   * the "projection" is the month-to-date figure relabelled. See
   * server/usage/projections.ts — the UI must say what is true on that day
   * rather than print a forecast that forecasts nothing.
   */
  is_projection: z.boolean(),
})
export type RunRate = z.infer<typeof RunRate>

export const AuxSplit = z.object({
  main_tokens: z.number(),
  aux_tokens: z.number(),
  // NULL query_source lanes (pre-0045) — shown as unknown, never as main.
  unknown_tokens: z.number(),
  aux_cost_usd: z.string(),
  aux_share: z.number().nullable(),
})
export type AuxSplit = z.infer<typeof AuxSplit>

export const Finding = z.object({
  id: z.string(),
  severity: z.enum(['low', 'medium']),
  group: z.enum(['tool-mastery', 'context-management', 'session-hygiene']),
  headline: z.string(),
  evidence: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  related_levers: z.array(z.string()),
  estimated_monthly_savings_usd: z.string().nullable(),
})
export type Finding = z.infer<typeof Finding>

export const VelocityState = z.object({
  current_week_usd: z.string(),
  trailing_mean_usd: z.string(),
  delta_pct: z.number().nullable(),
  is_flagged: z.boolean(), // ≥25% above 4-week mean (velocity-watch's bar)
})
export type VelocityState = z.infer<typeof VelocityState>

/** One day of a project card's MTD sparkline (§A lane; gap days absent). */
export const ProjectSparkDay = z.object({
  day: z.string(), // 'YYYY-MM-DD' (UTC)
  cost_usd: z.string(),
})
export type ProjectSparkDay = z.infer<typeof ProjectSparkDay>

export const ProjectCard = z.object({
  id: z.string(),
  code: z.string(),
  display_name: z.string(),
  type: z.string(),
  wbs_code: z.string().nullable(),
  end_date: z.string().nullable(),
  ended: z.boolean(),
  member_count: z.number(),
  mtd_cost_usd: z.string(),
  allocation_usd: z.string(),
  utilisation: z.number().nullable(), // mtd / allocation; null when no allocation
  projected_exhaustion_date: z.string().nullable(),
  velocity: VelocityState,
  /**
   * The CALLER's own contribution to this project's MTD figure (developer-pages
   * W3 D25/D26) — same lane, same window, same provisional option as
   * `mtd_cost_usd`, so the "yours $X · N%" share can never exceed 100%.
   */
  mine_mtd_usd: z.string(),
  /** Same-window per-day series for the card sparkline (D26). */
  spark: z.array(ProjectSparkDay),
})
export type ProjectCard = z.infer<typeof ProjectCard>

/**
 * One row of the project model mix (developer-pages W3 D27.4) — the
 * reason-typed shape `ModelSplitPanel` consumes. `key` comes from
 * `modelDriverKey` (shared/reports/model-attribution.ts): a real model id, or a
 * `__`-sentinel remainder key the panel's classifier sends to the coverage
 * footer — never a category row (fix 3). Replaces the folded-ONE-bucket
 * `ModelSpend[]` shape that served the retired composition donut.
 */
export const ProjectModelRow = z.object({
  key: z.string(),
  label: z.string(),
  cost_usd: z.string(),
  tokens: z.number(),
  /** WHY a remainder row carries no model (mig 0124) — null on named models. */
  gap_reason: z.string().nullable(),
})
export type ProjectModelRow = z.infer<typeof ProjectModelRow>

export const MemberContribution = z.object({
  teammate_id: z.string(),
  display_name: z.string().nullable(),
  email: z.string(),
  cost_usd: z.string(),
  tokens: z.number(),
  active_days: z.number(),
  cost_per_active_day: z.string(), // AEUF's intensity metric
  last_event: z.string().nullable(),
})
export type MemberContribution = z.infer<typeof MemberContribution>

export const ActivitySlice = z.object({
  activity: z.string().nullable(), // NULL = untagged-within-project
  cost_usd: z.string(),
  tokens: z.number(),
})
export type ActivitySlice = z.infer<typeof ActivitySlice>

/** GET /api/v1/me/sessions/{sid} — the session drill-down contract. */
export const SessionDetail = z.object({
  session_id: z.string(),
  instance_id: z.string().nullable(),
  tool: z.string(),
  project_id: z.string().nullable(),
  project_code: z.string().nullable(),
  project_display_name: z.string().nullable(),
  activity: z.string().nullable(),
  ts_start: z.string(),
  ts_last: z.string(),
  record_count: z.number(),
  span_count: z.number(),
  tokens: z.number(),
  cost_usd: z.string(),
  /**
   * D14 — does this session's provider quote a price PER TOKEN LANE?
   *
   * Derived server-side from the pricing DENOMINATION the ledger already
   * records (server/usage/breakdowns.ts::pricedPerLane), never from a tool
   * name. False ⇒ every lane/matrix `cost_usd` below is NULL, and `cost_usd`
   * above is where this session's money is stated — once.
   */
  priced_per_lane: z.boolean(),
  matrix: z.array(SessionMatrixCell),
  by_model: z.array(ModelSpend),
  by_token_type: z.array(SessionTokenTypeSpend),
  by_query_source: z.array(QuerySourceSpend),
  cache: CacheStats,
  fidelity: FidelitySplit,
})
export type SessionDetail = z.infer<typeof SessionDetail>

// ── My-usage "recent spend" strip ────────────────────────────────────────
//
// A rolling-window snapshot for the developer home page (My usage). The page's
// hero stays month-to-date (budget vs allocation is inherently monthly); this
// strip is the honest home for the 7/30/90-day time controls — pure spend
// velocity over attribution_aggregate, NO budget/quota framing.

/** Rolling-window selector for the recent-spend strip (distinct from the 30|90 dashboard WindowQuery). */
export const RecentWindowQuery = z.object({
  window: z.coerce
    .number()
    .int()
    .refine((v) => v === 7 || v === 30 || v === 90, 'window must be 7, 30 or 90')
    .default(30),
})
export type RecentWindowQuery = z.infer<typeof RecentWindowQuery>

/** GET /api/v1/me/home/recent — the rolling-window spend snapshot. */
export const RecentUsage = z.object({
  window_days: z.number(),
  total_cost_usd: z.string(),
  total_tokens: z.number(),
  // Distinct calendar days with any spend in the window (gap days absent from series).
  active_days: z.number(),
  // total / active_days — the intensity metric (null when no active days).
  cost_per_active_day: z.string().nullable(),
  series: z.array(DaySpend),
  by_model: z.array(ModelSpend),
})
export type RecentUsage = z.infer<typeof RecentUsage>

// ── Activity / tag drill-down ────────────────────────────────────────────
//
// "How much did tag X cost me, across which models and sessions?" — a
// teammate-scoped, window-bounded breakdown of ONE activity label. Reads the
// ledger (activity is not a dimension of attribution_aggregate), same
// sanctioned single-subject shape as the session drill-down.

/** One session that carried the activity, for the drill-down's session list. */
export const ActivitySession = z.object({
  session_id: z.string(),
  project_code: z.string().nullable(),
  project_display_name: z.string().nullable(),
  cost_usd: z.string(),
  tokens: z.number(),
  ts_last: z.string(),
})
export type ActivitySession = z.infer<typeof ActivitySession>

/** GET /api/v1/me/activity/{activity} — the tag drill-down contract. */
export const ActivityDetail = z.object({
  activity: z.string(),
  window_days: z.number(),
  total_cost_usd: z.string(),
  total_tokens: z.number(),
  session_count: z.number(),
  by_model: z.array(ModelSpend),
  by_token_type: z.array(TokenTypeSpend),
  cache: CacheStats,
  fidelity: FidelitySplit,
  sessions: z.array(ActivitySession),
})
export type ActivityDetail = z.infer<typeof ActivityDetail>
