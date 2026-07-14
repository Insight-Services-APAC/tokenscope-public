/*
 * Anthropic Claude Enterprise Analytics API client (the "Enterprise" client).
 *
 * Talks to the Claude Enterprise Analytics API:
 *   GET https://api.anthropic.com/v1/organizations/analytics/user_usage_report
 *   GET https://api.anthropic.com/v1/organizations/analytics/user_cost_report
 *   header: x-api-key: <analytics key>   (scope: read:analytics)
 *
 * This is ONE of two Anthropic reconciliation APIs TokenScope supports (selected
 * per-org via provider_org.api_kind, mig 0063). The other is the Claude Code
 * Analytics API (Admin) in server/anthropic/client.ts. DEV uses Enterprise.
 *
 * WIRE SHAPE (per the documented contract, 2026-06):
 *   - DATES are RFC-3339 timestamps (e.g. 2026-06-01T00:00:00Z), NOT date-only.
 *     bucket_width=1d. Data only exists >= 2026-01-01; a single span is <= 31 days.
 *   - group_by[] uses BRACKET notation — repeat the key:
 *     group_by[]=product&group_by[]=model.
 *   - cursor pagination: response carries has_more + next_page; we follow it via the
 *     `page` query param. Cursors are query-bound — params NEVER change mid-sequence.
 *   - rate limit is 60 RPM org-wide; honour 429 + retry-after (resilientFetch does).
 *   - user_usage_report: per-actor token counts (uncached_input/cache_creation/
 *     cache_read/output/total).
 *   - user_cost_report: per-actor cost; `amount` is a FRACTIONAL CENTS decimal
 *     STRING → USD = parse decimal / 100 (parsed as a decimal, not a binary float,
 *     so huge values don't lose precision).
 */
import { z } from 'zod'
import { resilientFetch } from '../utils/resilient-fetch'

/* The user_actor identity carried by both reports. email/name are nullable; a
 * deleted user is flagged (the caller carries forward / skips, never guesses). */
const Actor = z
  .object({
    type: z.string(), // 'user_actor'
    user_id: z.string().nullish(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    deleted: z.boolean().optional().default(false),
  })
  .passthrough()
export type EnterpriseActor = z.infer<typeof Actor>

/* user_usage_report row — one (actor, product, model) bucket for a day. */
const UsageRow = z
  .object({
    actor: Actor,
    product: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    uncached_input_tokens: z.number().int().nonnegative().optional().default(0),
    cache_creation: z
      .object({
        ephemeral_5m_input_tokens: z.number().int().nonnegative().optional().default(0),
        ephemeral_1h_input_tokens: z.number().int().nonnegative().optional().default(0),
      })
      .optional()
      .default({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }),
    cache_read_input_tokens: z.number().int().nonnegative().optional().default(0),
    output_tokens: z.number().int().nonnegative().optional().default(0),
    total_tokens: z.number().int().nonnegative().optional().default(0),
    requests: z.number().int().nonnegative().optional().default(0),
  })
  .passthrough()
export type EnterpriseUsageRow = z.infer<typeof UsageRow>

const UsageReport = z.object({
  organization_id: z.string().nullish(),
  data: z.array(UsageRow),
  has_more: z.boolean().optional().default(false),
  next_page: z.string().nullish(),
  data_refreshed_at: z.string().nullish(),
})
export type EnterpriseUsageReport = z.infer<typeof UsageReport>

/* user_cost_report row — one (actor, product, cost_type, token_type) cost bucket
 * for a day. `amount` is a fractional CENTS decimal string. */
const CostRow = z
  .object({
    actor: Actor,
    currency: z.string().optional(), // 'USD'
    amount: z.string(), // fractional CENTS decimal string
    list_amount: z.string().nullish(),
    cost_type: z.string().nullable().optional(), // 'tokens'|'web_search'|'code_execution'|null
    token_type: z.string().nullable().optional(),
    product: z.string().nullable().optional(),
    requests: z.number().int().nonnegative().optional().default(0),
  })
  .passthrough()
export type EnterpriseCostRow = z.infer<typeof CostRow>

const CostReport = z.object({
  organization_id: z.string().nullish(),
  data: z.array(CostRow),
  has_more: z.boolean().optional().default(false),
  next_page: z.string().nullish(),
  data_refreshed_at: z.string().nullish(),
})
export type EnterpriseCostReport = z.infer<typeof CostReport>

/*
 * Parse a fractional-CENTS decimal string to USD (÷100). We shift the decimal point
 * left two places over the digit string with string arithmetic, THEN Number() the
 * result. NOTE: the final value is still an IEEE-754 double — this bounds the
 * magnitude (no ×100 overflow) but does NOT give arbitrary precision; at realistic
 * per-row magnitudes that is exact, and the engine sums in JS floats downstream
 * anyway. If true fixed-precision is ever needed, keep cents as integers end-to-end.
 * Returns NaN for an unparseable input so the caller can guard (never coerce garbage
 * to 0). Scientific notation (e.g. "1e3") is intentionally rejected.
 */
export function centsStringToUsd(amount: string): number {
  const s = (amount ?? '').trim()
  if (!/^-?\d+(\.\d+)?$/.test(s)) return Number.NaN
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const [intPart, fracPart = ''] = body.split('.')
  // The value is in CENTS; USD shifts the decimal point left by 2 more places.
  const digits = (intPart ?? '0') + fracPart
  const pointFromRight = fracPart.length + 2
  const padded = digits.padStart(pointFromRight + 1, '0')
  const cut = padded.length - pointFromRight
  const usdStr = `${padded.slice(0, cut)}.${padded.slice(cut)}`
  const n = Number(usdStr)
  return neg ? -n : n
}

/** Total tokens across usage rows. */
export function sumUsageTokens(rows: EnterpriseUsageRow[]): number {
  let t = 0
  for (const r of rows) t += r.total_tokens
  return t
}

/** UTC day (YYYY-MM-DD) for an RFC-3339 timestamp. */
export function rfc3339Day(ts: string): string {
  return ts.slice(0, 10)
}

/*
 * starting_at + one bucket (1 day), as RFC-3339 'Z' — the default ending_at when a caller
 * omits it (Anthropic requires ending_at when bucket_width is set). Returns the input
 * unchanged if it can't be parsed, so a malformed starting_at surfaces the API's own error
 * rather than throwing here.
 */
export function oneBucketAfter(startingAt: string): string {
  const d = new Date(startingAt)
  if (Number.isNaN(d.getTime())) return startingAt
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export interface EnterpriseReportOpts {
  /** RFC-3339 start (inclusive), e.g. 2026-06-01T00:00:00Z. */
  startingAt: string
  /** RFC-3339 end. Optional. */
  endingAt?: string
  /** products[] filter; omitted → all products. */
  products?: string[]
  /** group_by[] dimensions (bracket-repeated). Defaults to ['product','model']. */
  groupBy?: string[]
}

// Hard cap on cursor-following per call — a looping cursor surfaces rather than
// spinning forever or silently truncating.
const MAX_PAGES = 100
// Documented page cap.
const PAGE_LIMIT = 1000

export class AnthropicEnterpriseClient {
  // apiKey is the per-org analytics key (read:analytics). Omitted for a local
  // synthetic stub (no auth); set per reconciled org in deployment.
  constructor(
    private readonly endpoint: string,
    private readonly apiKey?: string,
  ) {}

  private headers(): Record<string, string> | undefined {
    return this.apiKey ? { 'x-api-key': this.apiKey } : undefined
  }

  /*
   * Build the base query (without `page`) for a report path. The query is FIXED
   * for the whole cursor sequence — group_by[] / products[] / dates never change
   * mid-pagination (cursors are query-bound).
   */
  private buildUrl(path: string, opts: EnterpriseReportOpts): string {
    const groupBy = opts.groupBy ?? ['product', 'model']
    const parts: string[] = [
      `starting_at=${encodeURIComponent(opts.startingAt)}`,
      `bucket_width=1d`,
      `limit=${PAGE_LIMIT}`,
    ]
    // Anthropic REQUIRES ending_at whenever bucket_width is set (HTTP 400 otherwise:
    // "ending_at is required when bucket_width is set so pagination stays consistent").
    // Default it to starting_at + one bucket (1 day) when a caller omits it — the
    // reconciliation adapter passes its own; the discover onboarding probe relied on the
    // old "only-if-provided" behaviour and 400'd (which classifyProbe then masked as
    // 'connect-failed'). Verified live 2026-06-30.
    parts.push(`ending_at=${encodeURIComponent(opts.endingAt ?? oneBucketAfter(opts.startingAt))}`)
    // group_by[] BRACKET notation — repeat the key per dimension.
    for (const g of groupBy) parts.push(`group_by[]=${encodeURIComponent(g)}`)
    // products[] BRACKET notation — repeat per product (omitted → all products).
    for (const p of opts.products ?? []) parts.push(`products[]=${encodeURIComponent(p)}`)
    return `${this.endpoint}/v1/organizations/analytics/${path}?${parts.join('&')}`
  }

  /** Follow the next_page cursor, yielding each page's raw JSON. */
  private async *pages(base: string): AsyncGenerator<unknown> {
    let page: string | null = null
    for (let i = 0; i < MAX_PAGES; i++) {
      const url = page ? `${base}&page=${encodeURIComponent(page)}` : base
      const res = await resilientFetch(url, { headers: this.headers() })
      if (!res.ok) {
        throw new Error(`Anthropic enterprise analytics HTTP ${res.status}`)
      }
      const json: unknown = await res.json()
      yield json
      const hasMore = (json as { has_more?: boolean }).has_more === true
      const nextPage = (json as { next_page?: string | null }).next_page
      if (!hasMore || !nextPage) return
      page = nextPage
    }
    throw new Error(`Anthropic enterprise analytics exceeded ${MAX_PAGES} pages — cursor loop?`)
  }

  /*
   * Cheapest read-only liveness probe for the admin health route. Fetches a
   * SINGLE page of user_usage_report for one in-range day (no cursor-following)
   * and reports whether the variant's wired key authenticates + the response
   * parses. Never throws — returns a classified {ok,status,parsed} so the caller
   * maps it to a SAFE reason without leaking the key or raw error text.
   *
   * `ok:true` means HTTP 200 + the UsageReport schema parsed. `parsed:false`
   * with status 200 means the endpoint answered but the body was the wrong
   * shape (a wrong-endpoint / drift signal the caller surfaces as parse-mismatch).
   */
  async probe(startingAt: string): Promise<{ ok: boolean; status: number; parsed: boolean }> {
    const url = this.buildUrl('user_usage_report', { startingAt })
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
      // Network/transport failure (DNS, TLS, refused). status 0 => caller treats
      // it as a generic connect failure, never as an auth/scope verdict.
      return { ok: false, status: 0, parsed: false }
    }
  }

  async getUserUsageReport(opts: EnterpriseReportOpts): Promise<EnterpriseUsageReport> {
    const base = this.buildUrl('user_usage_report', opts)
    const data: EnterpriseUsageReport['data'] = []
    let organizationId: string | null | undefined
    let dataRefreshedAt: string | null | undefined
    for await (const raw of this.pages(base)) {
      const parsed = UsageReport.parse(raw)
      data.push(...parsed.data)
      organizationId ??= parsed.organization_id
      // All pages of one query share a refresh marker; keep the last seen.
      dataRefreshedAt = parsed.data_refreshed_at ?? dataRefreshedAt
    }
    return {
      organization_id: organizationId ?? null,
      data,
      has_more: false,
      next_page: null,
      data_refreshed_at: dataRefreshedAt ?? null,
    }
  }

  async getUserCostReport(opts: EnterpriseReportOpts): Promise<EnterpriseCostReport> {
    const base = this.buildUrl('user_cost_report', opts)
    const data: EnterpriseCostReport['data'] = []
    let organizationId: string | null | undefined
    let dataRefreshedAt: string | null | undefined
    for await (const raw of this.pages(base)) {
      const parsed = CostReport.parse(raw)
      data.push(...parsed.data)
      organizationId ??= parsed.organization_id
      dataRefreshedAt = parsed.data_refreshed_at ?? dataRefreshedAt
    }
    return {
      organization_id: organizationId ?? null,
      data,
      has_more: false,
      next_page: null,
      data_refreshed_at: dataRefreshedAt ?? null,
    }
  }
}
