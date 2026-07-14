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
})
export type ProjectCard = z.infer<typeof ProjectCard>

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
  matrix: z.array(UsageMatrixCell),
  by_model: z.array(ModelSpend),
  by_token_type: z.array(TokenTypeSpend),
  by_query_source: z.array(QuerySourceSpend),
  cache: CacheStats,
  fidelity: FidelitySplit,
})
export type SessionDetail = z.infer<typeof SessionDetail>
