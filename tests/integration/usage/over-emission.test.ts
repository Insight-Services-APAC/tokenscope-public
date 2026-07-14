// @vitest-environment node
/*
 * §A integrity — over-emission: OTel reports MORE than the provider API corroborates
 * (forged/mis-tagged emission) → flag the day → the dev quarantines the suspect session →
 * it's excluded and the over clears. The owner's example: a day's OTel is $500 ($450 + $50)
 * but the API is $50, so $450 is uncorroborated. docs/design/provider-billing-attribution-model.md §A.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession, type Session } from '../../helpers/auth'
import * as schema from '../../../drizzle/schema'
import { detectOverEmission } from '../../../server/usage/over-emission-detection'
import { reconcileUnaccountedUsage } from '../../../server/usage/unaccounted-reconciliation'
import { getMyUsage } from '../../../server/utils/me-queries'
import overGet from '../../../server/api/v1/me/over-emission.get'
import resolveHandler from '../../../server/api/v1/me/over-emission/[id]/resolve.post'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let teammateId = ''
let instanceId = ''
const WINDOW = { startDate: '2026-06-01', endDate: '2026-06-30' }
const DAY = '2026-06-20'

async function bill(costUsd: string): Promise<void> {
  await t.db.insert(schema.actualSpend).values({ teammateId, date: DAY, tool: 'claude-code', inputTokens: 0n, outputTokens: 0n, costUsd, source: 'api' })
}
async function otelSession(conv: string, costUsd: string): Promise<void> {
  await t.db.insert(schema.attributionRecord).values({
    instanceId, claudeSessionId: conv, teammateId, regionId, orgUnitId,
    tool: 'claude-code', model: 'opus', tokenType: 'output', tokens: 1000n, costUsd,
    fidelityTier: 'tier-1', costBasis: 'estimated', tsEvent: new Date(`${DAY}T12:00:00.000Z`), sourceRunId: randomUUID(),
  })
}
function ev(opts: { id?: string; body?: unknown }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450', 'content-type': 'application/json' }
  const e = {
    method: 'POST', path: '/x', context: { params: opts.id ? { id: opts.id } : {} },
    node: {
      req: { method: opts.id ? 'POST' : 'GET', url: '/x', body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
      res: {
        _headers: {} as Record<string, string | string[]>, statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] }, setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' }, appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], { teammateId, email: 'oe@x.test', displayName: 'OE', role: 'developer', regionId, orgPath: 'oe' } as Session)
  return e
}

beforeAll(async () => {
  t = await startTestDb(); process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'oe', displayName: 'OE' }).returning(); regionId = r!.id
  const [ou] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'oe', code: 'oe-bu', displayName: 'OE', unitType: 'bu', isCostOwningUnit: true }).returning(); orgUnitId = ou!.id
  const [tm] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-oe', email: 'oe@x.test', regionId, orgUnitId }).returning(); teammateId = tm!.id
  instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({ instanceId, principalOid: 'oid-oe', teammateId, projectCodeHash: 'h', rawProjectCode: 'OE', tool: 'claude-code', tsStart: new Date('2026-06-01T00:00:00Z'), regionId, orgUnitId })
}, 180_000)
afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)
beforeEach(async () => {
  await t.client`DELETE FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM session_quarantine WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM attribution_record WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM actual_spend WHERE teammate_id = ${teammateId}::uuid`
})

describe('over-emission (§A integrity)', () => {
  it('flags a material over-emission (API $50, OTel $500 → $450 uncorroborated)', async () => {
    await bill('50.00')
    await otelSession('sess-big', '450.00')
    await otelSession('sess-small', '50.00')
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.flagged).toBe(1)
    expect(res.totalOverUsd).toBeCloseTo(450, 2)
  })

  it('does NOT flag legitimate estimate drift (bill $50, OTel estimate $65 = 1.3x)', async () => {
    // The bill-vs-estimate basis means honest usage can run over; only an EGREGIOUS over
    // (>2x the bill, above a high floor) is a forgery. $15 over < max($25, 1.0*$50=$50).
    await bill('50.00')
    await otelSession('sess-a', '65.00')
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.flagged).toBe(0)
  })

  it('does NOT flag a teammate with OTel but NO API bill (org not reconciled — absence ≠ forgery)', async () => {
    // No actual_spend at all for this day (the Anthropic org isn't reconciled), only OTel.
    // api=0 must NOT read as "uncorroborated $X" — caught in sandbox validation.
    await otelSession('sess-noapi', '300.00')
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.flagged).toBe(0)
  })

  it('does NOT flag a still-settling recent day even with a huge over (bill lag)', async () => {
    // The bill for the last few days is still filling; OTel is real-time. Never flag it.
    const recent = new Date(`${WINDOW.endDate}T00:00:00Z`); recent.setUTCDate(recent.getUTCDate() - 1)
    const recentDay = recent.toISOString().slice(0, 10)
    await t.db.insert(schema.actualSpend).values({ teammateId, date: recentDay, tool: 'claude-code', inputTokens: 0n, outputTokens: 0n, costUsd: '50.00', source: 'api' })
    await t.db.insert(schema.attributionRecord).values({
      instanceId, claudeSessionId: 'recent-forge', teammateId, regionId, orgUnitId, tool: 'claude-code',
      model: 'opus', tokenType: 'output', tokens: 1000n, costUsd: '500.00', fidelityTier: 'tier-1',
      costBasis: 'estimated', tsEvent: new Date(`${recentDay}T12:00:00Z`), sourceRunId: randomUUID(),
    })
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.flagged).toBe(0) // within the settled-lag window → not flagged
  })

  it('RE-OPENS an accepted flag when a NEW forgery pushes the over materially past the watermark', async () => {
    await bill('50.00'); await otelSession('sess-1', '450.00'); await otelSession('sess-2', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    await resolveHandler(ev({ id: flag!.id, body: { action: 'accept' } }) as never) // vouch for $450
    // A new forged session lands the same day: over jumps to $850 (> $450 * 1.5).
    await otelSession('sess-3-forge', '400.00')
    await detectOverEmission(t.db, WINDOW)
    const [reopened] = await t.client<{ state: string; over: string }[]>`SELECT state, over_usd::text AS over FROM over_emission WHERE id = ${flag!.id}::uuid`
    expect(reopened!.state).toBe('open') // re-opened
    expect(Number(reopened!.over)).toBeCloseTo(850, 2)
  })

  it('the read endpoint returns the flag with the day sessions (biggest first)', async () => {
    await bill('50.00'); await otelSession('sess-big', '450.00'); await otelSession('sess-small', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const out = (await overGet(ev({}) as never)) as { flags: Array<{ over_usd: string; sessions: Array<{ conversation_id: string; cost_usd: string }> }> }
    expect(out.flags).toHaveLength(1)
    expect(out.flags[0]!.over_usd).toBe('450.00')
    expect(out.flags[0]!.sessions[0]!.conversation_id).toBe('sess-big') // cost desc
  })

  it('quarantining the suspect session excludes it, clears the over, and removes it from needs-tagging', async () => {
    await bill('50.00'); await otelSession('sess-big', '450.00'); await otelSession('sess-small', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    // The dev calls it: the $450 session is the forgery.
    const r = (await resolveHandler(ev({ id: flag!.id, body: { action: 'quarantine', conversation_id: 'sess-big' } }) as never)) as { state: string }
    expect(r.state).toBe('quarantined')
    // session_quarantine written with the api-uncorroborated reason.
    const [sq] = await t.client<{ reason: string }[]>`SELECT reason FROM session_quarantine WHERE teammate_id = ${teammateId}::uuid AND conversation_id = 'sess-big'`
    expect(sq!.reason).toBe('api-uncorroborated')
    // Re-detect: OTel (excl. the forgery) = $50 = API → over clears.
    await detectOverEmission(t.db, WINDOW)
    const [cleared] = await t.client<{ state: string; over: string }[]>`SELECT state, over_usd::text AS over FROM over_emission WHERE id = ${flag!.id}::uuid`
    expect(cleared!.state).toBe('quarantined')
    expect(Number(cleared!.over)).toBe(0)
    // The forged session no longer shows in the dev's needs-tagging.
    const usage = await getMyUsage(t.db, teammateId, new Date(`${DAY}T12:00:00.000Z`))
    // sess-small ($50, untagged) still needs tagging; sess-big is excluded.
    expect(Number(usage.unallocated.untagged_cost_usd)).toBeCloseTo(50, 2)
  })

  it('quarantining a forgery RESURFACES the genuine unaccounted usage it was masking', async () => {
    // API $100; OTel = real $50 + a $450 forgery = $500. Before quarantine, unaccounted is
    // masked to $0 (100 − 500 floored). After quarantining the forgery, the under lane nets
    // against the corroborated OTel ($50) → the genuine $50 of un-enrolled usage resurfaces.
    await bill('100.00')
    await otelSession('sess-real', '50.00')
    await otelSession('sess-forge', '450.00')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const [before] = await t.client<{ cost: string }[]>`SELECT COALESCE(MAX(cost_usd),0)::text AS cost FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date`
    expect(Number(before!.cost)).toBe(0) // masked by the forgery
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    await resolveHandler(ev({ id: flag!.id, body: { action: 'quarantine', conversation_id: 'sess-forge' } }) as never)
    await reconcileUnaccountedUsage(t.db, WINDOW) // re-run the under lane
    const [after] = await t.client<{ cost: string }[]>`SELECT cost_usd::text AS cost FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date`
    expect(Number(after!.cost)).toBeCloseTo(50, 2) // genuine un-enrolled usage now visible + taggable
  })

  it('accept keeps the OTel (dev vouches for it) and resolves the flag', async () => {
    await bill('50.00'); await otelSession('sess-x', '450.00'); await otelSession('sess-y', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    const r = (await resolveHandler(ev({ id: flag!.id, body: { action: 'accept' } }) as never)) as { state: string }
    expect(r.state).toBe('accepted')
    const usage = await getMyUsage(t.db, teammateId, new Date(`${DAY}T12:00:00.000Z`))
    expect(Number(usage.unallocated.untagged_cost_usd)).toBeCloseTo(500, 2) // both sessions still counted
  })
})
