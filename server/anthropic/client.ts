/*
 * Anthropic Claude Code Analytics API client (the "Admin" client).
 *
 * Talks to the Claude Code Analytics API (Admin):
 *   GET https://api.anthropic.com/v1/organizations/usage_report/claude_code
 *   headers: x-api-key: <admin key sk-ant-admin01-...>, anthropic-version: 2023-06-01
 *
 * This is ONE of two Anthropic reconciliation APIs TokenScope supports (selected
 * per-org via provider_org.api_kind, mig 0063). The other is the Claude Enterprise
 * Analytics API (server/anthropic/enterprise-client.ts). DEV uses Enterprise.
 *
 * NUXT_ANTHROPIC_API_ENDPOINT picks the base URL — synthetic stub in local dev,
 * the real api.anthropic.com in deployment.
 *
 * WIRE SHAPE (verified against the live docs, 2026-06):
 *   - response: { data: [ <flat per-user record> ], has_more, next_page }.
 *     data[] is a FLAT array of per-user records (NOT { date, records[] }).
 *   - params: starting_at (YYYY-MM-DD, a SINGLE day — there is NO ending_at),
 *     limit (max 1000), page (opaque cursor from response next_page).
 *   - each record: { date, actor, organization_id, customer_type, terminal_type,
 *     core_metrics, tool_actions, model_breakdown: [ { model, tokens:{...},
 *     estimated_cost:{ currency, amount } } ] }.
 *   - tokens + cost are NESTED under model_breakdown[]; estimated_cost.amount is
 *     in CENTS (integer). Sum tokens + cost across model_breakdown.
 *   - actor is a union: user_actor (has email_address) | api_actor (api_key_name,
 *     NO email). Identity = actor.email_address for user_actor only.
 */
import { z } from 'zod'
import { resilientFetch } from '../utils/resilient-fetch'

/**
 * Inclusive list of UTC YYYY-MM-DD days from start..end. The Claude Code report is
 * single-day-per-request (starting_at is a single day, no ending_at), so both the
 * analytics poller and the reconciliation adapter iterate per UTC day (ING-2).
 * Bounded so an inverted/garbage range can't produce an unbounded loop.
 */
export function daysInclusive(start: string, end: string): string[] {
  const out: string[] = []
  const d = new Date(`${start}T00:00:00.000Z`)
  const last = new Date(`${end}T00:00:00.000Z`)
  for (let i = 0; i < 367 && d.getTime() <= last.getTime(); i++) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

// One model's slice of a per-user record. tokens are split; estimated_cost.amount
// is in CENTS (integer). Tolerant of optional cache fields (default 0).
const ModelBreakdown = z.object({
  model: z.string(),
  tokens: z.object({
    input: z.number().int().nonnegative().optional().default(0),
    output: z.number().int().nonnegative().optional().default(0),
    cache_read: z.number().int().nonnegative().optional().default(0),
    cache_creation: z.number().int().nonnegative().optional().default(0),
  }),
  estimated_cost: z
    .object({
      currency: z.string().optional(),
      // CENTS (integer) per the live docs. Tolerate a fractional/decimal too so a
      // shape drift doesn't crash; the consumers divide by 100.
      amount: z.number(),
    })
    .optional(),
})
export type AnthropicModelBreakdown = z.infer<typeof ModelBreakdown>

// actor: user_actor carries email_address; api_actor carries api_key_name (no
// email). Union-tolerant: both legs optional so an unseen actor type still parses
// (recordEmail returns null and the consumer carries it forward / skips).
const Actor = z
  .object({
    type: z.string(),
    email_address: z.string().nullish(),
    api_key_name: z.string().nullish(),
  })
  .passthrough()

// One flat per-user record. .passthrough so the verbatim payload survives into
// ReconciledLine.raw (core_metrics / tool_actions / terminal_type are preserved
// but not consumed here).
const UsageRecord = z
  .object({
    date: z.string(),
    actor: Actor,
    organization_id: z.string().nullish(),
    customer_type: z.string().nullish(), // 'api' | 'subscription'
    terminal_type: z.string().nullish(),
    model_breakdown: z.array(ModelBreakdown).default([]),
  })
  .passthrough()

const UsageReport = z.object({
  // FLAT array of per-user records (NOT { date, records[] }).
  data: z.array(UsageRecord),
  has_more: z.boolean(),
  // Opaque cursor for the next page (present when has_more). Tolerated absent.
  next_page: z.string().nullish(),
})

export type UsageReport = z.infer<typeof UsageReport>
export type UsageRecord = z.infer<typeof UsageRecord>

/** Identity for a record: the user_actor email, else null (api_actor has none). */
export function recordEmail(rec: UsageRecord): string | null {
  if (rec.actor.type === 'user_actor') return rec.actor.email_address ?? null
  // Defensive: some payloads may omit the explicit type but still carry an email.
  return rec.actor.email_address ?? null
}

/** UTC day (YYYY-MM-DD) for a record's `date` (which is an RFC-3339 timestamp). */
export function recordDate(rec: UsageRecord): string {
  return rec.date.slice(0, 10)
}

/** Total tokens for a record = sum of input+output+cache across model_breakdown[]. */
export function sumRecordTokens(rec: UsageRecord): number {
  let total = 0
  for (const m of rec.model_breakdown) {
    total += m.tokens.input + m.tokens.output + m.tokens.cache_read + m.tokens.cache_creation
  }
  return total
}

/** Uncached input tokens for a record = sum of tokens.input across model_breakdown[]. */
export function sumRecordInputTokens(rec: UsageRecord): number {
  let t = 0
  for (const m of rec.model_breakdown) t += m.tokens.input
  return t
}

/** Output tokens for a record = sum of tokens.output across model_breakdown[]. */
export function sumRecordOutputTokens(rec: UsageRecord): number {
  let t = 0
  for (const m of rec.model_breakdown) t += m.tokens.output
  return t
}

/**
 * Total USD for a record = sum of estimated_cost.amount (CENTS) across
 * model_breakdown[], divided by 100. Returns a number (callers .toFixed for the
 * ledger). A model slice with no estimated_cost contributes 0.
 */
export function sumRecordCostUsd(rec: UsageRecord): number {
  let cents = 0
  for (const m of rec.model_breakdown) {
    if (m.estimated_cost) cents += m.estimated_cost.amount
  }
  return cents / 100
}

// cost_report (org-grain USD) — web search + code execution surface ONLY here, not
// in claude_code. [VERIFY against the live Admin API once an admin key is available:
// the exact result shape and whether `amount` is dollars or cents (docs say decimal
// strings in cents).] Tolerant parse (passthrough) so a shape drift doesn't crash.
const CostResult = z
  .object({
    currency: z.string().optional(),
    amount: z.string(),
    description: z.string().nullish(),
    workspace_id: z.string().nullish(),
  })
  .passthrough()
const CostBucket = z.object({
  starting_at: z.string(),
  ending_at: z.string().optional(),
  results: z.array(CostResult),
})
const CostReport = z.object({
  data: z.array(CostBucket),
  has_more: z.boolean().optional().default(false),
  next_page: z.string().nullish(),
})
export type CostReport = z.infer<typeof CostReport>

// Hard cap on cursor-following per call. The pages are large (a whole day);
// hitting this means the upstream is looping a cursor — surface it rather than
// spin forever or silently truncate.
const MAX_PAGES = 100

// limit=1000 is the documented max — fewer round-trips for a heavy day.
const PAGE_LIMIT = 1000

export class AnthropicAnalyticsClient {
  // apiKey is the per-org admin key (multi-org polling). Omitted for the local
  // synthetic stub (no auth); set per reconciled org in deployment.
  constructor(
    private readonly endpoint: string,
    private readonly apiKey?: string,
  ) {}

  private headers(): Record<string, string> | undefined {
    return this.apiKey
      ? { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }
      : undefined
  }

  /*
   * Claude Code per-user usage for a SINGLE day. There is NO ending_at on this
   * endpoint — starting_at is one day. Follows the next_page cursor until exhausted
   * and returns the CONCATENATED records (has_more: false — pagination is internal).
   *
   * `endingAt` is accepted but IGNORED (callers pass day=day); kept in the signature
   * for call-site compatibility with the per-day iteration both consumers do.
   */
  async getClaudeCodeUsage(opts: { startingAt: string; endingAt?: string }): Promise<UsageReport> {
    const base =
      `${this.endpoint}/v1/organizations/usage_report/claude_code` +
      `?starting_at=${encodeURIComponent(opts.startingAt)}` +
      `&limit=${PAGE_LIMIT}`
    const data: UsageReport['data'] = []
    let page: string | null = null
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await resilientFetch(page ? `${base}&page=${encodeURIComponent(page)}` : base, {
        headers: this.headers(),
      })
      if (!res.ok) {
        throw new Error(`Anthropic claude_code usage report HTTP ${res.status}`)
      }
      const parsed = UsageReport.parse(await res.json())
      data.push(...parsed.data)
      if (!parsed.has_more || !parsed.next_page) {
        return { data, has_more: false, next_page: null }
      }
      page = parsed.next_page
    }
    throw new Error(`Anthropic claude_code usage report exceeded ${MAX_PAGES} pages — cursor loop?`)
  }

  /*
   * Cheapest read-only liveness probe for the admin health route. Fetches a
   * SINGLE page of the claude_code usage report for one day (no cursor-following)
   * and reports whether the org's wired admin key authenticates + the response
   * parses. Never throws — returns {ok,status,parsed} so the caller maps it to a
   * SAFE reason without leaking the key or raw error text. `parsed:false` with
   * status 200 = endpoint answered but wrong shape (parse-mismatch signal).
   */
  async probe(startingAt: string): Promise<{ ok: boolean; status: number; parsed: boolean }> {
    const url =
      `${this.endpoint}/v1/organizations/usage_report/claude_code` +
      `?starting_at=${encodeURIComponent(startingAt)}&limit=1`
    try {
      const res = await resilientFetch(url, { headers: this.headers() })
      if (!res.ok) return { ok: false, status: res.status, parsed: false }
      try {
        UsageReport.parse(await res.json())
        return { ok: true, status: res.status, parsed: true }
      } catch {
        return { ok: false, status: res.status, parsed: false }
      }
    } catch {
      return { ok: false, status: 0, parsed: false }
    }
  }

  async getCostReport(opts: { startingAt: string; endingAt: string }): Promise<CostReport> {
    const base =
      `${this.endpoint}/v1/organizations/cost_report` +
      `?starting_at=${encodeURIComponent(opts.startingAt)}` +
      `&ending_at=${encodeURIComponent(opts.endingAt)}` +
      `&bucket_width=1d` + // daily buckets so each result carries its own day
      `&group_by[]=description`
    const data: CostReport['data'] = []
    let page: string | null = null
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await resilientFetch(page ? `${base}&page=${encodeURIComponent(page)}` : base, {
        headers: this.headers(),
      })
      if (!res.ok) {
        throw new Error(`Anthropic cost report HTTP ${res.status}`)
      }
      const parsed = CostReport.parse(await res.json())
      data.push(...parsed.data)
      if (!parsed.has_more || !parsed.next_page) {
        return { data, has_more: false, next_page: null }
      }
      page = parsed.next_page
    }
    throw new Error(`Anthropic cost report exceeded ${MAX_PAGES} pages — cursor loop?`)
  }
}

export function getAnthropicClient(): AnthropicAnalyticsClient {
  const endpoint = process.env.NUXT_ANTHROPIC_API_ENDPOINT
  if (!endpoint) {
    throw new Error(
      'NUXT_ANTHROPIC_API_ENDPOINT not set — poller cannot reach the synthetic Anthropic API',
    )
  }
  return new AnthropicAnalyticsClient(endpoint)
}
