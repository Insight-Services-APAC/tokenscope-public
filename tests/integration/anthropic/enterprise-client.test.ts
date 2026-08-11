// @vitest-environment node
/*
 * AnthropicEnterpriseClient — the Claude Enterprise Analytics API client.
 * Real local HTTP server (no fetch mocking), mirroring resilient-fetch.test.ts.
 *
 * Proves:
 *   - user_usage_report parses to typed rows (tokens, cache_creation, actor union)
 *   - user_cost_report `amount` (fractional CENTS decimal string) -> USD via ÷100,
 *     precision-preserving (no binary-float drift on huge values)
 *   - cursor pagination follows next_page, concatenating data[]
 *   - the request carries x-api-key + group_by[] BRACKET notation + RFC-3339 dates
 *   - 429 + retry-after is honoured (resilientFetch retries through the client)
 */
import { createServer, type Server } from 'node:http'
import { describe, it, expect, afterEach } from 'vitest'
import {
  AnthropicEnterpriseClient,
  centsStringToUsd,
  oneBucketAfter,
  sumUsageTokens,
} from '../../../server/anthropic/enterprise-client'

let server: Server | null = null

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler)
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  const addr = server!.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
  }
})

const ACTOR = {
  type: 'user_actor',
  user_id: 'u-1',
  name: 'Dev One',
  email: 'dev.one@example.com',
  deleted: false,
}

describe('centsStringToUsd', () => {
  it('divides fractional-cents decimal strings by 100', () => {
    expect(centsStringToUsd('250')).toBeCloseTo(2.5, 9) // 250 cents -> $2.50
    expect(centsStringToUsd('34')).toBeCloseTo(0.34, 9)
    expect(centsStringToUsd('0.1')).toBeCloseTo(0.001, 9)
    expect(centsStringToUsd('12345.67')).toBeCloseTo(123.4567, 9)
    expect(centsStringToUsd('-500')).toBeCloseTo(-5, 9)
  })
  it('preserves precision on a huge value (no binary-float drift)', () => {
    // 9_999_999_999_999.99 cents -> $99_999_999_999.9999. A naive parseFloat/100
    // would lose the trailing cents; the string-shift keeps them.
    expect(centsStringToUsd('9999999999999.99')).toBe(99999999999.9999)
  })
  it('returns NaN for garbage (caller guards; never silently 0)', () => {
    expect(Number.isNaN(centsStringToUsd('abc'))).toBe(true)
    expect(Number.isNaN(centsStringToUsd(''))).toBe(true)
  })
})

describe('oneBucketAfter', () => {
  it('returns starting_at + 1 day as RFC-3339 Z (incl. month roll)', () => {
    expect(oneBucketAfter('2026-06-08T00:00:00Z')).toBe('2026-06-09T00:00:00Z')
    expect(oneBucketAfter('2026-06-30T00:00:00Z')).toBe('2026-07-01T00:00:00Z')
  })
  it('returns the input unchanged when it cannot be parsed (let the API surface the error)', () => {
    expect(oneBucketAfter('not-a-date')).toBe('not-a-date')
  })
})

describe('AnthropicEnterpriseClient.getUserUsageReport', () => {
  it('sends x-api-key + bracket group_by[] + RFC-3339 dates and parses rows', async () => {
    let seenUrl = ''
    let seenAuth: string | undefined
    const url = await serve((req, res) => {
      seenUrl = req.url ?? ''
      seenAuth = req.headers['x-api-key'] as string | undefined
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          organization_id: 'org-x',
          has_more: false,
          next_page: null,
          data_refreshed_at: '2026-06-08T06:00:00Z',
          data: [
            {
              actor: ACTOR,
              product: 'claude_code',
              model: 'claude-sonnet-4-6',
              uncached_input_tokens: 1000,
              cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
              cache_read_input_tokens: 50,
              output_tokens: 500,
              total_tokens: 1750,
              requests: 3,
            },
          ],
        }),
      )
    })
    const client = new AnthropicEnterpriseClient(url, 'analytics-key')
    const report = await client.getUserUsageReport({
      startingAt: '2026-06-08T00:00:00Z',
      endingAt: '2026-06-09T00:00:00Z',
    })
    expect(seenAuth).toBe('analytics-key')
    expect(seenUrl).toContain('/v1/organizations/analytics/user_usage_report')
    expect(seenUrl).toContain('starting_at=2026-06-08T00%3A00%3A00Z')
    expect(seenUrl).toContain('ending_at=2026-06-09T00%3A00%3A00Z') // explicit endingAt sent
    expect(seenUrl).toContain('bucket_width=1d')
    // group_by[] BRACKET notation kept literal on the wire (the key is not encoded),
    // repeated per dimension.
    expect(seenUrl).toContain('group_by[]=product')
    expect(seenUrl).toContain('group_by[]=model')
    expect(report.data).toHaveLength(1)
    expect(report.data[0]!.total_tokens).toBe(1750)
    expect(report.data[0]!.cache_creation.ephemeral_5m_input_tokens).toBe(200)
    expect(report.data[0]!.actor.email).toBe('dev.one@example.com')
    expect(sumUsageTokens(report.data)).toBe(1750)
    expect(report.data_refreshed_at).toBe('2026-06-08T06:00:00Z')
  })

  it('DEFAULTS ending_at to starting_at + 1 day when a caller omits it (Anthropic 400s without it)', async () => {
    let seenUrl = ''
    const url = await serve((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ organization_id: 'org-x', has_more: false, next_page: null, data: [] }))
    })
    const client = new AnthropicEnterpriseClient(url, 'k')
    await client.getUserUsageReport({ startingAt: '2026-06-08T00:00:00Z' }) // NO endingAt (the discover-probe path)
    expect(seenUrl).toContain('ending_at=2026-06-09T00%3A00%3A00Z')
  })

  it('follows next_page, concatenating data[] across pages', async () => {
    const pages: string[] = []
    const url = await serve((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost')
      const page = u.searchParams.get('page') ?? 'p0'
      pages.push(page)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (page === 'p0') {
        res.end(
          JSON.stringify({
            has_more: true,
            next_page: 'p1',
            data: [{ actor: ACTOR, product: 'claude_code', model: 'm', total_tokens: 100 }],
          }),
        )
      } else {
        res.end(
          JSON.stringify({
            has_more: false,
            next_page: null,
            data: [{ actor: ACTOR, product: 'claude_code', model: 'm', total_tokens: 200 }],
          }),
        )
      }
    })
    const client = new AnthropicEnterpriseClient(url, 'k')
    const report = await client.getUserUsageReport({ startingAt: '2026-06-08T00:00:00Z' })
    expect(pages).toEqual(['p0', 'p1'])
    expect(report.data).toHaveLength(2)
    expect(sumUsageTokens(report.data)).toBe(300)
  })

  it('honours 429 + retry-after, then succeeds (retries through resilientFetch)', async () => {
    let hits = 0
    const url = await serve((_req, res) => {
      hits += 1
      if (hits === 1) {
        res.writeHead(429, { 'retry-after': '0' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ has_more: false, next_page: null, data: [] }))
    })
    const client = new AnthropicEnterpriseClient(url, 'k')
    const report = await client.getUserUsageReport({ startingAt: '2026-06-08T00:00:00Z' })
    expect(hits).toBe(2)
    expect(report.data).toHaveLength(0)
  })
})

describe('AnthropicEnterpriseClient.getUserCostReport', () => {
  it('parses cost rows and exposes amount as a fractional-cents string', async () => {
    let seenUrl = ''
    const url = await serve((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          organization_id: 'org-x',
          has_more: false,
          next_page: null,
          data: [
            {
              actor: ACTOR,
              currency: 'USD',
              amount: '250.5', // fractional cents -> $2.505
              list_amount: '300',
              cost_type: 'tokens',
              token_type: 'input',
              product: 'claude_code',
              requests: 3,
            },
          ],
        }),
      )
    })
    const client = new AnthropicEnterpriseClient(url, 'k')
    const report = await client.getUserCostReport({ startingAt: '2026-06-08T00:00:00Z' })
    expect(seenUrl).toContain('/v1/organizations/analytics/user_cost_report')
    expect(report.data).toHaveLength(1)
    expect(report.data[0]!.amount).toBe('250.5')
    expect(centsStringToUsd(report.data[0]!.amount)).toBeCloseTo(2.505, 9)
  })
})

describe('cost_type grouping — the request shape that makes the tool-cost split reachable', () => {
  it('parses a cost row whose `requests` is NULL', async () => {
    /*
     * Anthropic returns `requests: null` whenever group_by includes cost_type
     * or token_type. `z.number().optional().default(0)` substitutes only for an
     * ABSENT key, so an explicit null threw a ZodError.
     *
     * That throw is not contained: it escapes the per-day loop in
     * runEnterpriseAnalyticsPoll, the per-org catch records "poll failed", and
     * the org writes NO actual_spend rows on that cycle or any cycle after,
     * until a human notices. Requesting cost_type without this is a
     * deterministic outage on the next poll, which is why it is pinned here
     * rather than left to the poller's own tests.
     */
    const base = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: [
            {
              actor: { type: 'user_actor', email: 'a@x.test' },
              amount: '4200.000000',
              currency: 'USD',
              cost_type: 'web_search',
              product: 'claude_code',
              requests: null,
            },
          ],
          has_more: false,
          next_page: null,
        }),
      )
    })
    const client = new AnthropicEnterpriseClient(base, 'k')
    const report = await client.getUserCostReport({
      startingAt: '2026-07-31T00:00:00Z',
      endingAt: '2026-08-01T00:00:00Z',
      groupBy: ['product', 'model', 'cost_type'],
    })
    expect(report.data).toHaveLength(1)
    expect(report.data[0]!.requests).toBe(0)
    expect(report.data[0]!.cost_type).toBe('web_search')
  })

  /*
   * TASK #32 — THE MODEL DIMENSION MUST SURVIVE THE PARSE.
   *
   * We have always ASKED for it (`group_by[]=model` on both reports) and the
   * provider has always sent it: the 2026-08-02 wire capture observed
   * `data[].model` on 255/255 live cost rows — and listed it under
   * `undeclaredByOurSchema`. Nothing then read it, and the model axis was built
   * from OTel instead, which is how 58% of Dev spend rendered as "not split by
   * model" under a label blaming collection. "We ask for the model, get it,
   * discard it, then blame OTel."
   *
   * THIS IS THE FIRST LINK OF THE CARRY, and the only one no test covered. The
   * rest is pinned in tests/integration/provider/provider-transform.test.ts,
   * whose fake client hands the poller row objects DIRECTLY — so it proves
   * raw_payload → provider_usage_fact.model and cannot see this parse at all.
   * Together: wire → parse → actual_spend.raw_payload → provider_usage_fact →
   * the billed model axis.
   *
   * MUTATION: delete `model` from CostRow and its `.passthrough()` — the field
   * is stripped and this goes red. (`.passthrough()` alone kept it, which is
   * exactly the accident the declaration replaces: the billed lane's whole model
   * axis rested on an undeclared field.)
   */
  it('carries the model through on BOTH reports, cost included', async () => {
    const base = await serve((req, res) => {
      const isCost = (req.url ?? '').includes('user_cost_report')
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: [
            isCost
              ? {
                  actor: ACTOR,
                  amount: '1234.5',
                  currency: 'USD',
                  cost_type: 'tokens',
                  product: 'claude_code',
                  model: 'claude-opus-5',
                  requests: null,
                }
              : { actor: ACTOR, product: 'chat', model: 'claude-opus-5', output_tokens: 7 },
          ],
          has_more: false,
          next_page: null,
        }),
      )
    })
    const client = new AnthropicEnterpriseClient(base, 'k')
    const window = { startingAt: '2026-07-31T00:00:00Z', endingAt: '2026-08-01T00:00:00Z' }

    const cost = await client.getUserCostReport({ ...window, groupBy: ['product', 'model', 'cost_type'] })
    expect(cost.data[0]!.model).toBe('claude-opus-5')

    const usage = await client.getUserUsageReport({ ...window, groupBy: ['product', 'model'] })
    expect(usage.data[0]!.model).toBe('claude-opus-5')
  })

  it('accepts an explicit null model without throwing the poll away', async () => {
    /*
     * Same failure mode `requests: null` had, one field over: a ZodError here
     * escapes the per-day loop and the org stops writing actual_spend entirely.
     * `.nullable().optional()` is what makes an absent OR null model a bucket
     * rather than an outage.
     */
    const base = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: [
            { actor: ACTOR, amount: '10', currency: 'USD', cost_type: 'web_search', model: null, requests: null },
            { actor: ACTOR, amount: '20', currency: 'USD', cost_type: 'tokens', requests: null },
          ],
          has_more: false,
          next_page: null,
        }),
      )
    })
    const client = new AnthropicEnterpriseClient(base, 'k')
    const report = await client.getUserCostReport({
      startingAt: '2026-07-31T00:00:00Z',
      endingAt: '2026-08-01T00:00:00Z',
      groupBy: ['product', 'model', 'cost_type'],
    })
    expect(report.data).toHaveLength(2)
    expect(report.data[0]!.model).toBeNull()
    expect(report.data[1]!.model).toBeUndefined()
  })

  /*
   * `server_tool_use` MUST SURVIVE THE PARSE — the same first link the model
   * dimension needed, one field later.
   *
   * The 2026-08-02 wire capture observed
   * `data[].server_tool_use.web_search_requests` on 85/85 live and 257/257
   * stored usage rows and listed BOTH the parent and the leaf under
   * `undeclaredByOurSchema`. It reached `actual_spend.raw_payload` only through
   * `.passthrough()`, so the carry rested on a field no schema declared.
   *
   * THIS TEST IS THE ONLY ONE THAT SEES THE PARSE.
   * tests/integration/provider/provider-server-tool-use.test.ts pins the rest of
   * the chain, but its fake client hands the poller row objects DIRECTLY and
   * therefore cannot detect a schema change at all — narrowing the declaration
   * leaves every assertion in that file green. Together: wire → parse →
   * actual_spend.raw_payload → provider_usage_fact.web_search_requests.
   *
   * MUTATION: delete `server_tool_use` from UsageRow — `.passthrough()` types
   * the property `unknown`, `report.data[0]!.server_tool_use?.web_search_requests`
   * stops compiling, and with the access loosened the value assertion still
   * holds only by accident of passthrough. The type-level guard
   * tests/unit/server/enterprise-server-tool-use.test-d.ts is the companion that
   * catches the declaration going away; this one catches the VALUE going away.
   */
  it('carries server_tool_use.web_search_requests through the parse', async () => {
    const base = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: [
            {
              actor: ACTOR,
              product: 'claude_code',
              model: 'claude-opus-5',
              output_tokens: 7,
              server_tool_use: { web_search_requests: 12 },
            },
          ],
          has_more: false,
          next_page: null,
        }),
      )
    })
    const client = new AnthropicEnterpriseClient(base, 'k')
    const report = await client.getUserUsageReport({
      startingAt: '2026-07-31T00:00:00Z',
      endingAt: '2026-08-01T00:00:00Z',
      groupBy: ['product', 'model'],
    })
    expect(report.data[0]!.server_tool_use?.web_search_requests).toBe(12)
  })

  /*
   * THE OUTAGE SHAPE. `.default()` substitutes only for an ABSENT key, so an
   * explicit `null` fails the parse — and that failure is not local: the throw
   * escapes the per-day loop in runEnterpriseAnalyticsPoll, the per-org catch
   * records "poll failed", and the org writes NO actual_spend rows on that cycle
   * or any cycle after, silently. This is the identical failure mode
   * `CostRow.requests` documents, and the reason the declaration is `.nullish()`
   * at BOTH levels rather than `.optional()`.
   *
   * MUTATION (verified): change the declaration to
   * `z.object({ web_search_requests: z.number().int().nonnegative() }).optional()`
   * — both rows below throw a ZodError and this goes red.
   */
  it('accepts an explicit null server_tool_use, and a null leaf, without throwing the poll away', async () => {
    const base = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: [
            { actor: ACTOR, product: 'claude_code', model: 'claude-opus-5', server_tool_use: null },
            {
              actor: ACTOR,
              product: 'claude_code',
              model: 'claude-sonnet-5',
              server_tool_use: { web_search_requests: null },
            },
            { actor: ACTOR, product: 'claude_code', model: 'claude-haiku-5' },
          ],
          has_more: false,
          next_page: null,
        }),
      )
    })
    const client = new AnthropicEnterpriseClient(base, 'k')
    const report = await client.getUserUsageReport({
      startingAt: '2026-07-31T00:00:00Z',
      endingAt: '2026-08-01T00:00:00Z',
      groupBy: ['product', 'model'],
    })
    // All three rows parsed — the day was not lost.
    expect(report.data).toHaveLength(3)
    expect(report.data[0]!.server_tool_use).toBeNull()
    expect(report.data[1]!.server_tool_use?.web_search_requests).toBeNull()
    expect(report.data[2]!.server_tool_use).toBeUndefined()
  })

  /*
   * T3 (W0a) — `context_window` MUST SURVIVE THE PARSE, on BOTH reports, in all
   * three wire states: a known band, an UNKNOWN band (the vocabulary is the
   * provider's to extend — no enum, so '1m+' rides through verbatim, never a
   * 500), and an explicit null — which is the `.default()` outage trap: the
   * wire sends `context_window: null` on every row whenever the dimension is
   * not in `group_by`, so a declaration that rejects null kills the org's
   * polling on the first ungrouped call.
   *
   * THIS TEST IS THE ONLY ONE THAT SEES THE PARSE — the provider suite's fake
   * client hands the poller row objects directly
   * (tests/integration/provider/provider-context-window.test.ts pins the rest
   * of the chain: raw_payload → provider_usage_fact.context_window).
   *
   * MUTATION: declare `context_window: z.enum(['0-200k', '200k+']).nullish()`
   * — the '1m+' rows throw and both unknown-band assertions go red. MUTATION:
   * declare `.optional()` instead of `.nullish()` — the explicit-null rows
   * throw and the null assertions go red.
   */
  it('carries context_window through the parse on BOTH reports — unknown bands and nulls included', async () => {
    const base = await serve((req, res) => {
      const isCost = (req.url ?? '').includes('user_cost_report')
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: isCost
            ? [
                { actor: ACTOR, amount: '10', currency: 'USD', cost_type: 'tokens', model: 'claude-opus-5', context_window: '0-200k', requests: null },
                { actor: ACTOR, amount: '20', currency: 'USD', cost_type: 'tokens', model: 'claude-opus-5', context_window: '1m+', requests: null },
                { actor: ACTOR, amount: '30', currency: 'USD', cost_type: 'tokens', model: 'claude-opus-5', context_window: null, requests: null },
              ]
            : [
                { actor: ACTOR, product: 'claude_code', model: 'claude-opus-5', output_tokens: 7, context_window: '200k+' },
                { actor: ACTOR, product: 'claude_code', model: 'claude-opus-5', output_tokens: 8, context_window: '1m+' },
                { actor: ACTOR, product: 'claude_code', model: 'claude-opus-5', output_tokens: 9, context_window: null },
                { actor: ACTOR, product: 'claude_code', model: 'claude-opus-5', output_tokens: 10 },
              ],
          has_more: false,
          next_page: null,
        }),
      )
    })
    const client = new AnthropicEnterpriseClient(base, 'k')
    const window = { startingAt: '2026-07-31T00:00:00Z', endingAt: '2026-08-01T00:00:00Z' }

    const usage = await client.getUserUsageReport({ ...window, groupBy: ['product', 'model', 'context_window'] })
    expect(usage.data).toHaveLength(4)
    expect(usage.data[0]!.context_window).toBe('200k+')
    expect(usage.data[1]!.context_window).toBe('1m+')
    expect(usage.data[2]!.context_window).toBeNull()
    expect(usage.data[3]!.context_window).toBeUndefined()

    const cost = await client.getUserCostReport({
      ...window,
      groupBy: ['product', 'model', 'cost_type', 'context_window'],
    })
    expect(cost.data).toHaveLength(3)
    expect(cost.data[0]!.context_window).toBe('0-200k')
    expect(cost.data[1]!.context_window).toBe('1m+')
    expect(cost.data[2]!.context_window).toBeNull()
  })

  it('sends cost_type to the COST report only', async () => {
    /*
     * `group_by[]` applies to whichever report receives it, and `cost_type`
     * exists only on CostRow. Sending it to the usage report fragments those
     * rows by a dimension we cannot read back -- more rows against the
     * 100-page ceiling, for nothing. The two callers build separate arrays;
     * this pins that they stay separate.
     */
    const seen: string[] = []
    const base = await serve((req, res) => {
      seen.push(req.url ?? '')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [], has_more: false, next_page: null }))
    })
    const client = new AnthropicEnterpriseClient(base, 'k')
    const window = { startingAt: '2026-07-31T00:00:00Z', endingAt: '2026-08-01T00:00:00Z' }
    await client.getUserUsageReport({ ...window, groupBy: ['product', 'model'] })
    await client.getUserCostReport({ ...window, groupBy: ['product', 'model', 'cost_type'] })

    const [usageUrl, costUrl] = seen
    expect(usageUrl).toContain('user_usage_report')
    expect(usageUrl).not.toContain('cost_type')
    expect(costUrl).toContain('user_cost_report')
    // Literal brackets, not percent-encoded — the client builds `group_by[]=`
    // by hand (buildUrl), which the file's header calls out as the bracket
    // notation Anthropic requires.
    expect(costUrl).toContain('group_by[]=cost_type')
  })
})
