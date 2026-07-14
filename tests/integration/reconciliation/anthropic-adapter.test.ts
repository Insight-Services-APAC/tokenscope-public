// @vitest-environment node
/*
 * Anthropic adapter -> engine, end-to-end against an in-process Admin-API stub +
 * testcontainers Postgres. Proves: claude_code per-user lines resolve actor email
 * -> teammate (unknown emails carried forward), cost_report org lines map to
 * web_search/code_execution, and the engine writes the expected reconciliation_record rows.
 */
import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { createAnthropicAdapter } from '../../../server/reconciliation/adapters/anthropic'
import { runReconcileEngine } from '../../../server/reconciliation/engine'
import type { ResolvedCredential } from '../../../server/reconciliation/credentials'

let t: TestDb
let stub: Server
let stubUrl = ''
let teammateId = ''
const SPEND_DATE = '2026-06-08'
const NOW = new Date('2026-06-08T12:00:00.000Z')
const TEAM_EMAIL = 'dev.one@example.com'
const CRED: ResolvedCredential = { secretName: 'partner-demo', value: 'test-key', level: 'org' }

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'apac-aa', 'APAC')`
  const [region] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'apac-aa'`
  await t.client`INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
    VALUES (gen_random_uuid(), ${region!.id}, 'apac.aa', 'aa-bu', 'AA BU', 'bu')`
  const [org] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code = 'aa-bu'`
  await t.client`INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
    VALUES (gen_random_uuid(), 'oid-aa', ${TEAM_EMAIL}, ${region!.id}, ${org!.id})`
  const [tm] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'oid-aa'`
  teammateId = tm!.id

  stub = createServer((req, res) => {
    if (req.url?.startsWith('/v1/organizations/usage_report/claude_code')) {
      // Return records only for the spend day (the adapter calls per-day).
      const isDay = req.url.includes(`starting_at=${SPEND_DATE}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      // Real claude_code Admin shape (mig 0063): FLAT data[] of per-user records;
      // tokens + cost NESTED under model_breakdown[]; estimated_cost.amount in CENTS;
      // actor union user_actor/api_actor; customer_type. 250 cents -> $2.50.
      res.end(
        JSON.stringify({
          has_more: false,
          data: isDay
            ? [
                {
                  date: SPEND_DATE,
                  actor: { type: 'user_actor', email_address: TEAM_EMAIL },
                  customer_type: 'api',
                  model_breakdown: [
                    {
                      model: 'claude-sonnet-4-6',
                      tokens: { input: 1000, output: 500, cache_read: 0, cache_creation: 0 },
                      estimated_cost: { currency: 'USD', amount: 250 },
                    },
                  ],
                },
                {
                  date: SPEND_DATE,
                  actor: { type: 'user_actor', email_address: 'unknown@nowhere.com' },
                  customer_type: 'api',
                  model_breakdown: [
                    {
                      model: 'claude-sonnet-4-6',
                      tokens: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
                      estimated_cost: { currency: 'USD', amount: 10 },
                    },
                  ],
                },
              ]
            : [],
        }),
      )
      return
    }
    if (req.url?.startsWith('/v1/organizations/cost_report')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          has_more: false,
          data: [
            {
              starting_at: `${SPEND_DATE}T00:00:00Z`,
              results: [
                { currency: 'USD', amount: '34', description: 'Code Execution Usage' },
                { currency: 'USD', amount: '500', description: 'Claude tokens' }, // not a category -> skipped
              ],
            },
          ],
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

describe('Anthropic adapter', () => {
  it('normalises claude_code per-user + cost_report org lines, skipping unknown actors', async () => {
    const adapter = createAnthropicAdapter(t.db, { externalRef: 'org-aa', credential: CRED })
    const lines = await adapter.pull({ startDate: SPEND_DATE, endDate: SPEND_DATE })

    const model = lines.filter((l) => l.category === 'model_tokens')
    expect(model).toHaveLength(1) // unknown@nowhere.com carried forward
    expect(model[0]!.subject).toEqual({ kind: 'teammate', teammateId })
    // amountUsd is the cents-sum (250) ÷ 100, scale-6 (adapter .toFixed(6)).
    expect(model[0]!.amountUsd).toBe('2.500000')
    expect(Number(model[0]!.amountUsd)).toBeCloseTo(2.5, 6)
    expect(model[0]!.unit).toEqual({ quantity: 1500, unitType: 'tokens' })

    const codeExec = lines.filter((l) => l.category === 'code_execution')
    expect(codeExec).toHaveLength(1)
    expect(codeExec[0]!.subject).toEqual({ kind: 'org', costOwningUnitId: null })
    expect(Number(codeExec[0]!.amountUsd)).toBeCloseTo(0.34, 6) // 34 cents
  })

  it('binds the provider bill to the REAL teammate, never a provisional shadow sharing the email (FIX 1)', async () => {
    // mig 0057 made teammate.email a PARTIAL unique index (WHERE NOT provisional),
    // so a provisional shadow can share a real teammate's email. The money path must
    // resolve the REAL teammate. Insert a shadow claiming TEAM_EMAIL, then pull.
    await t.client`
      INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id, provisional)
      SELECT gen_random_uuid(), 'provisional:aa-shadow', ${TEAM_EMAIL}, region_id, org_unit_id, true
        FROM teammate WHERE entra_oid = 'oid-aa'`
    const adapter = createAnthropicAdapter(t.db, { externalRef: 'org-aa', credential: CRED })
    const lines = await adapter.pull({ startDate: SPEND_DATE, endDate: SPEND_DATE })
    const model = lines.filter((l) => l.category === 'model_tokens')
    expect(model).toHaveLength(1)
    // Resolves to the real teammate, NOT the provisional shadow.
    expect(model[0]!.subject).toEqual({ kind: 'teammate', teammateId })
    await t.client`DELETE FROM teammate WHERE entra_oid = 'provisional:aa-shadow'`
  })

  it('feeds the engine: a per-user row + an org-scope code_execution row', async () => {
    await t.client`DELETE FROM reconciliation_record`
    const adapter = createAnthropicAdapter(t.db, { externalRef: 'org-aa', credential: CRED })
    const lines = await adapter.pull({ startDate: SPEND_DATE, endDate: SPEND_DATE })
    const r = await runReconcileEngine(t.db, lines, { now: NOW })
    expect(r.recordsWritten).toBe(2)

    const [tmRow] = await t.client<{ disposition: string; delta: string }[]>`
      SELECT disposition, delta_usd::text AS delta FROM reconciliation_record
      WHERE scope = 'teammate' AND category = 'model_tokens'`
    expect(tmRow!.disposition).toBe('no_install') // teammate has no OTel history
    expect(Number(tmRow!.delta)).toBeCloseTo(2.5, 6)

    const [orgRow] = await t.client<{ disposition: string; delta: string; tm: string | null }[]>`
      SELECT disposition, delta_usd::text AS delta, teammate_id::text AS tm
      FROM reconciliation_record WHERE scope = 'org' AND category = 'code_execution'`
    expect(orgRow!.disposition).toBe('untagged')
    expect(orgRow!.tm).toBeNull()
    expect(Number(orgRow!.delta)).toBeCloseTo(0.34, 6)
  })
})
