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
