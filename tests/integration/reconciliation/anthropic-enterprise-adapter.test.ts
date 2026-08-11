// @vitest-environment node
/*
 * Anthropic adapter — the ENTERPRISE-ANALYTICS branch (mig 0063 api_kind).
 * In-process Enterprise Analytics API stub + testcontainers Postgres.
 *
 * Proves:
 *   - scope.apiKind='enterprise-analytics' pulls user_usage_report + user_cost_report
 *     and emits ONE model_tokens ReconciledLine per (teammate, day): quantity = Σ
 *     total_tokens, amountUsd = Σ(cost ÷ 100), periodDate = bucket day, spendClass
 *     'estimated', subject = the EXACT (non-provisional) teammate.
 *   - the PER-PRODUCT breakdown is preserved in `raw` (engine collapses to per-day).
 *   - nullable / deleted actor emails are carried forward (skipped), not guessed.
 *   - scope.apiKind branch selection: 'claude-code-admin' (or unset) does NOT hit the
 *     enterprise endpoints.
 */
import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { createAnthropicAdapter } from '../../../server/reconciliation/adapters/anthropic'
import type { ResolvedCredential } from '../../../server/reconciliation/credentials'

let t: TestDb
let stub: Server
let stubUrl = ''
let teammateId = ''
const SPEND_DATE = '2026-06-08'
const TEAM_EMAIL = 'dev.one@example.com'

const CRED_ENT: ResolvedCredential = {
  secretName: 'insight',
  value: 'analytics-key',
  level: 'org',
  apiKind: 'enterprise-analytics',
}

const usageActor = (email: string | null, deleted = false) => ({
  type: 'user_actor',
  user_id: email ? `u-${email}` : null,
  name: email ? 'A Dev' : null,
  email,
  deleted,
})

// Tracks which endpoints the adapter hit (branch-selection assertion).
let usagePathHit = false
/** group_by[] as the ADAPTER actually sent it, per report. */
const costGroupBySeen: string[][] = []
const usageGroupBySeen: string[][] = []
let costPathHit = false

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'apac-ea', 'APAC')`
  const [region] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'apac-ea'`
  await t.client`INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
    VALUES (gen_random_uuid(), ${region!.id}, 'apac.ea', 'ea-bu', 'EA BU', 'bu')`
  const [org] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code = 'ea-bu'`
  await t.client`INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
    VALUES (gen_random_uuid(), 'oid-ea', ${TEAM_EMAIL}, ${region!.id}, ${org!.id})`
  const [tm] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'oid-ea'`
  teammateId = tm!.id

  stub = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const onDay = u.searchParams.get('starting_at')?.startsWith(SPEND_DATE) ?? false
    if (u.pathname === '/v1/organizations/analytics/user_usage_report') {
      usageGroupBySeen.push(u.searchParams.getAll('group_by[]'))
      usagePathHit = true
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          organization_id: 'org-ea',
          has_more: false,
          next_page: null,
          data_refreshed_at: `${SPEND_DATE}T06:00:00Z`,
          data: onDay
            ? [
                // Known dev, TWO products → two usage rows for one (teammate, day).
                {
                  actor: usageActor(TEAM_EMAIL),
                  product: 'claude_code',
                  model: 'claude-sonnet-4-6',
                  uncached_input_tokens: 1000,
                  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
                  cache_read_input_tokens: 0,
                  output_tokens: 500,
                  total_tokens: 1500,
                  requests: 3,
                },
                {
                  actor: usageActor(TEAM_EMAIL),
                  product: 'claude_api',
                  model: 'claude-opus-4-8',
                  uncached_input_tokens: 100,
                  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
                  cache_read_input_tokens: 0,
                  output_tokens: 100,
                  total_tokens: 200,
                  requests: 1,
                },
                // Unknown email → carried forward (skip).
                {
                  actor: usageActor('ghost@nowhere.com'),
                  product: 'claude_code',
                  model: 'm',
                  total_tokens: 999,
                  requests: 1,
                },
                // Deleted actor → carried forward (skip), even though email present.
                {
                  actor: usageActor(TEAM_EMAIL, true),
                  product: 'claude_code',
                  model: 'm',
                  total_tokens: 7,
                  requests: 1,
                },
              ]
            : [],
        }),
      )
      return
    }
    if (u.pathname === '/v1/organizations/analytics/user_cost_report') {
      costPathHit = true
      /*
       * Record what the ADAPTER asked for. The stub returns cost_type whatever
       * the request says, so without this a caller that stopped requesting
       * cost_type would leave every test green while production got null back
       * and folded web-search cost into per-developer model_tokens.
       *
       * The poller has the same coverage; this is its sibling. The two callers
       * build the array independently, so one being right proves nothing about
       * the other.
       */
      costGroupBySeen.push(u.searchParams.getAll('group_by[]'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          organization_id: 'org-ea',
          has_more: false,
          next_page: null,
          data: onDay
            ? [
                // claude_code: 250 cents -> $2.50
                {
                  actor: usageActor(TEAM_EMAIL),
                  currency: 'USD',
                  amount: '250',
                  cost_type: 'tokens',
                  token_type: 'input',
                  product: 'claude_code',
                  requests: 3,
                },
                // claude_api: 50 cents -> $0.50
                {
                  actor: usageActor(TEAM_EMAIL),
                  currency: 'USD',
                  amount: '50',
                  cost_type: 'tokens',
                  token_type: 'output',
                  product: 'claude_api',
                  requests: 1,
                },
                // web_search tool cost: 100 cents -> $1.00. Routes to its OWN category
                // line (NOT folded into model_tokens) — consistent with the admin path.
                {
                  actor: usageActor(TEAM_EMAIL),
                  currency: 'USD',
                  amount: '100',
                  cost_type: 'web_search',
                  token_type: null,
                  product: 'claude_code',
                  requests: 5,
                },
              ]
            : [],
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => stub.listen(0, r))
  const addr = stub.address()
  stubUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
  process.env.NUXT_ANTHROPIC_API_ENDPOINT = stubUrl
}, 180_000)

afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()))
  delete process.env.NUXT_ANTHROPIC_API_ENDPOINT
  await stopTestDb(t)
})

describe('Anthropic enterprise-analytics adapter branch', () => {
  it('emits one per-teammate-day model_tokens line with per-product raw; skips unknown/deleted', async () => {
    const adapter = createAnthropicAdapter(t.db, {
      externalRef: 'org-ea',
      credential: CRED_ENT,
      apiKind: 'enterprise-analytics',
    })
    const lines = await adapter.pull({ startDate: SPEND_DATE, endDate: SPEND_DATE })

    const model = lines.filter((l) => l.category === 'model_tokens')
    expect(model).toHaveLength(1) // collapsed to ONE per-teammate-day line
    const line = model[0]!
    expect(line.subject).toEqual({ kind: 'teammate', teammateId })
    expect(line.periodDate).toBe(SPEND_DATE)
    expect(line.spendClass).toBe('estimated')
    // tokens: 1500 (claude_code) + 200 (claude_api) = 1700.
    expect(line.unit).toEqual({ quantity: 1700, unitType: 'tokens' })
    // USD: (250 + 50) cents ÷ 100 = $3.00 — token cost ONLY (web_search excluded).
    expect(Number(line.amountUsd)).toBeCloseTo(3.0, 6)

    // web_search tool cost routes to its OWN ORG-GRAIN category line (§8.5: not
    // pro-rata'd onto developers — matches the admin path), NOT folded into model_tokens.
    const ws = lines.filter((l) => l.category === 'web_search')
    expect(ws).toHaveLength(1)
    expect(ws[0]!.subject).toEqual({ kind: 'org', costOwningUnitId: null })
    expect(Number(ws[0]!.amountUsd)).toBeCloseTo(1.0, 6)

    // PER-PRODUCT breakdown preserved in raw.
    const raw = line.raw as { day: string; perProduct: Array<{ product: string; tokens: number; usd: number }> }
    expect(raw.day).toBe(SPEND_DATE)
    const byProduct = Object.fromEntries(raw.perProduct.map((p) => [p.product, p]))
    expect(byProduct.claude_code!.tokens).toBe(1500)
    expect(byProduct.claude_code!.usd).toBeCloseTo(2.5, 6)
    expect(byProduct.claude_api!.tokens).toBe(200)
    expect(byProduct.claude_api!.usd).toBeCloseTo(0.5, 6)
  })

  it('binds the REAL teammate, never a provisional shadow sharing the email', async () => {
    await t.client`
      INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id, provisional)
      SELECT gen_random_uuid(), 'provisional:ea-shadow', ${TEAM_EMAIL}, region_id, org_unit_id, true
        FROM teammate WHERE entra_oid = 'oid-ea'`
    const adapter = createAnthropicAdapter(t.db, {
      externalRef: 'org-ea',
      credential: CRED_ENT,
      apiKind: 'enterprise-analytics',
    })
    const lines = await adapter.pull({ startDate: SPEND_DATE, endDate: SPEND_DATE })
    const model = lines.filter((l) => l.category === 'model_tokens')
    expect(model).toHaveLength(1)
    expect(model[0]!.subject).toEqual({ kind: 'teammate', teammateId })
    await t.client`DELETE FROM teammate WHERE entra_oid = 'provisional:ea-shadow'`
  })

  it('api_kind branch selection: claude-code-admin / unset does NOT hit the enterprise endpoints', async () => {
    usagePathHit = false
    costPathHit = false
    // claude-code-admin scope -> the legacy path (claude_code/cost_report). The stub
    // 404s those, so the adapter yields no enterprise lines and never touches the
    // analytics endpoints.
    const adapter = createAnthropicAdapter(t.db, {
      externalRef: 'org-ea',
      credential: { ...CRED_ENT, apiKind: 'claude-code-admin' },
      apiKind: 'claude-code-admin',
    })
    await adapter.pull({ startDate: SPEND_DATE, endDate: SPEND_DATE }).catch(() => undefined)
    expect(usagePathHit).toBe(false)
    expect(costPathHit).toBe(false)
  })
})

describe('the group_by the reconciliation adapter ACTUALLY sends', () => {
  it('asks the cost report for cost_type, and does not ask the usage report for it', () => {
    /*
     * The sibling of the poller's assertion. `cost_type` is what makes the
     * adapter's org-grain aggregation reachable at all -- the field is null on
     * every row until it is grouped, so `toolCostByCategory` had never once
     * populated and web-search / code-execution cost folded into per-developer
     * totals instead.
     */
    expect(costGroupBySeen.length).toBeGreaterThan(0)
    for (const g of costGroupBySeen) expect(g).toContain('cost_type')
    for (const g of usageGroupBySeen) expect(g).not.toContain('cost_type')
  })
})
