// @vitest-environment node
/*
 * Analytics poller — pagination + conflict-key aggregation regressions
 * (robustness review 2026-06-09):
 *   - ING-2: the client follows the next_page cursor — records on page 2+ land
 *     (they previously vanished silently, corrupting the reconciliation ceiling).
 *   - ING-4: two records for one actor-day (e.g. API + subscription rows, or one
 *     day split across pages) SUM into the (teammate, date, tool, source) row —
 *     the DO UPDATE upsert previously let the last record clobber the others.
 */
import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { AnthropicAnalyticsClient } from '../../../server/anthropic/client'
import { runAnalyticsPoll } from '../../../server/workers/analytics-poller'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let stub: Server
let stubUrl = ''
let priyaId = ''
const SPEND_DATE = '2026-06-01'

// Real claude_code Admin shape (mig 0063): FLAT per-user record; tokens + cost
// NESTED under model_breakdown[]; estimated_cost.amount in CENTS; actor union;
// customer_type. `costCents` is the model-slice cost in cents.
const record = (
  email: string,
  input: number,
  output: number,
  costCents: number,
  customerType = 'api',
) => ({
  date: SPEND_DATE,
  actor: { type: 'user_actor', email_address: email },
  customer_type: customerType,
  model_breakdown: [
    {
      model: 'claude-sonnet-4-6',
      tokens: { input, output, cache_read: 0, cache_creation: 0 },
      estimated_cost: { currency: 'USD', amount: costCents },
    },
  ],
})

// Tracks which pages the poller actually requested.
const pagesRequested: string[] = []

beforeAll(async () => {
  t = await startTestDb()

  // Three-page report for ONE day: priya appears on every page (same-day records
  // split across pages AND a same-page subscription_type sibling on page 1).
  stub = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/v1/organizations/usage_report/claude_code') {
      const page = url.searchParams.get('page') ?? 'p1'
      pagesRequested.push(page)
      res.writeHead(200, { 'content-type': 'application/json' })
      // FLAT data[] per page (no { date, records[] } wrapper). priya appears on
      // every page (same-day records split across pages AND a same-page customer_type
      // sibling on page 1). Costs in CENTS: 10 + 2 + 30 → $0.42.
      if (page === 'p1') {
        res.end(JSON.stringify({
          has_more: true,
          next_page: 'p2',
          data: [
            record('priya.iyer@example.com', 1000, 500, 10),
            record('priya.iyer@example.com', 200, 100, 2, 'subscription'),
          ],
        }))
      } else if (page === 'p2') {
        res.end(JSON.stringify({
          has_more: true,
          next_page: 'p3',
          data: [record('priya.iyer@example.com', 3000, 1500, 30)],
        }))
      } else {
        res.end(JSON.stringify({
          has_more: false,
          data: [record('ghost@nowhere.com', 10, 5, 0.01)],
        }))
      }
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) =>
    stub.listen(0, '127.0.0.1', () => {
      const addr = stub.address()
      stubUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
      r()
    }),
  )

  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'apac-pg', displayName: 'APAC' })
    .returning()
  const [org] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: region!.id, path: 'apac.pg', code: 'pg-bu', displayName: 'Pg BU', unitType: 'bu' })
    .returning()
  const [priya] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-priya-pg', email: 'priya.iyer@example.com', regionId: region!.id, orgUnitId: org!.id })
    .returning()
  priyaId = priya!.id
}, 180_000)

afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()))
  await stopTestDb(t)
}, 30_000)

describe('runAnalyticsPoll — pagination (ING-2) + same-key aggregation (ING-4)', () => {
  it('consumes every has_more page and SUMS same actor-day records instead of clobbering', async () => {
    const client = new AnthropicAnalyticsClient(stubUrl)
    const result = await runAnalyticsPoll(t.db, client, {
      startingAt: SPEND_DATE,
      endingAt: SPEND_DATE,
    })

    // All three pages were requested for the single day.
    expect(pagesRequested).toEqual(['p1', 'p2', 'p3'])
    expect(result.recordsTotal).toBe(4)
    expect(result.recordsSkippedUnknownUser).toBe(1) // ghost on page 3
    expect(result.recordsUpserted).toBe(1) // one aggregated actor-day row

    // 1000 + 200 + 3000 input; 0.10 + 0.02 + 0.30 USD — summed, not the last record.
    const rows = await t.client<{ input_tokens: string; output_tokens: string; cost_usd: string }[]>`
      SELECT input_tokens::text AS input_tokens, output_tokens::text AS output_tokens,
             cost_usd::text AS cost_usd
      FROM actual_spend WHERE teammate_id = ${priyaId}::uuid AND date = ${SPEND_DATE}::date`
    expect(rows.length).toBe(1)
    expect(rows[0]!.input_tokens).toBe('4200')
    expect(rows[0]!.output_tokens).toBe('2100')
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(0.42, 6)
  })

  it('re-poll is idempotent (refreshes the aggregated row, no duplicates)', async () => {
    pagesRequested.length = 0
    const client = new AnthropicAnalyticsClient(stubUrl)
    const result = await runAnalyticsPoll(t.db, client, { startingAt: SPEND_DATE, endingAt: SPEND_DATE })
    expect(result.recordsUpserted).toBe(1)
    const rows = await t.client<{ count: string; cost_usd: string }[]>`
      SELECT COUNT(*)::text AS count, MAX(cost_usd)::text AS cost_usd
      FROM actual_spend WHERE teammate_id = ${priyaId}::uuid`
    expect(rows[0]!.count).toBe('1')
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(0.42, 6)
  })
})
