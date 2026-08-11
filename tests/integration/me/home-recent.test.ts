// @vitest-environment node
/*
 * GET /api/v1/me/home/recent — the My-usage rolling-window "recent spend"
 * snapshot, against real Postgres via the REAL handler (AGENTS.md §"Never mock
 * Drizzle"). Contract under test:
 *   - totals + series come from attribution_aggregate over the window;
 *   - active_days == distinct spend days; cost_per_active_day == total/active;
 *   - by_model is cost-share desc;
 *   - requester-scoped (another teammate's rows never leak);
 *   - the empty case (no spend) → active_days 0, cost_per_active_day null.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { runAggregateRollup } from '../../../server/workers/aggregate-rollup'
import recentHandler from '../../../server/api/v1/me/home/recent.get'
import homeHandler from '../../../server/api/v1/me/home.get'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let devId = ''
let otherId = ''
let emptyId = ''
const INSTANCE = randomUUID()

function ev(session: Session, window = 30) {
  const url = `/x?window=${window}`
  const e = {
    method: 'GET',
    path: url,
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { host: 'localhost:3450', cookie: '' }
        },
      },
      res: {
        _headers: {} as Record<string, unknown>,
        statusCode: 200,
        getHeader() {},
        setHeader() {},
        removeHeader() {},
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof recentHandler>[0]
}

const sess = (teammateId: string): Session =>
  ({
    teammateId,
    email: 'r@recent.test',
    displayName: 'R',
    role: 'developer',
    regionId,
    orgPath: 'recent',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

// Two distinct spend days for devId (today + ~26h ago) so active_days == 2 on
// any calendar date; other teammate + empty teammate isolate scoping/empties.
const now = new Date()
const anchorMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12)

beforeAll(async () => {
  t = await startTestDb()
  // The real handler reaches Postgres via withRequestRls → getDb → DATABASE_URL;
  // point it at this suite's throwaway db (the consumption-hero convention).
  process.env.DATABASE_URL = t.url

  const [region] = await t.db.insert(schema.region).values({ code: 'r-recent', displayName: 'RR' }).returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'r.svc', code: 'r-svc', displayName: 'RSvc', unitType: 'bu' })
    .returning()
  orgUnitId = bu!.id
  const mk = async (oid: string, email: string) => {
    const [tm] = await t.db.insert(schema.teammate).values({ entraOid: oid, email, regionId, orgUnitId }).returning()
    return tm!.id
  }
  devId = await mk('oid-recent-dev', 'recent.dev@example.com')
  otherId = await mk('oid-recent-other', 'recent.other@example.com')
  emptyId = await mk('oid-recent-empty', 'recent.empty@example.com')

  // attribution_record.instance_id has an FK to instance_attestation; the
  // 'attested' state requires a project claim hash (a CLAIM, no project row
  // needed). The read-model scopes on teammate_id, not this row.
  await t.db.insert(schema.instanceAttestation).values({
    instanceId: INSTANCE,
    principalOid: 'oid-recent-dev',
    teammateId: devId,
    projectCodeHash: 'h-recent',
    rawProjectCode: 'RECENT',
    tool: 'claude-code',
    sessionTokenHash: 'tok-recent-' + INSTANCE,
    tsStart: new Date(),
    regionId,
    orgUnitId,
    costOwningUnitId: orgUnitId,
  })

  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)

  const insert = (teammateId: string, over: Record<string, unknown>) =>
    t.db.insert(schema.attributionRecord).values({
      instanceId: INSTANCE,
      claudeSessionId: 'conv-recent-' + String(over.run),
      teammateId,
      regionId,
      orgUnitId,
      tool: 'claude-code',
      model: 'claude-fable-5',
      tokenType: 'input',
      tokens: 100_000n,
      costUsd: '0.300000',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: new Date(anchorMs),
      sourceRunId: String(over.run),
      querySource: 'main',
      ...over,
    } as never)

  // dev: two days, two models → active_days 2, by_model has 2 entries.
  await insert(devId, { run: 'd1', tsEvent: new Date(anchorMs), tokens: 100_000n, costUsd: '0.300000' })
  await insert(devId, {
    run: 'd2',
    tsEvent: new Date(anchorMs - 26 * 3_600_000),
    model: 'claude-haiku-4-5',
    tokens: 40_000n,
    costUsd: '0.100000',
  })
  // another teammate — must never leak into dev's snapshot.
  await insert(otherId, { run: 'o1', tokens: 500_000n, costUsd: '5.000000' })

  /*
   * The COPILOT-ONLY teammate (external review r2): a provider-API day on
   * record and NOT ONE OTel record. `/me/home` must still say they have never
   * emitted — they are the rollout gap, not an onboarded developer.
   */
  await t.db.insert(schema.unaccountedUsage).values({
    teammateId: emptyId,
    regionId,
    orgUnitId,
    day: new Date(anchorMs).toISOString().slice(0, 10),
    tool: 'copilot-cli',
    costUsd: '4.500000',
  })

  await runAggregateRollup(t.db)
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('/api/v1/me/home/recent', () => {
  it('returns windowed totals, active days and per-active-day intensity', async () => {
    const res = await recentHandler(ev(sess(devId), 30))
    expect(res.window_days).toBe(30)
    // 0.30 + 0.10 across two days.
    expect(Number(res.total_cost_usd)).toBeCloseTo(0.4, 2)
    expect(res.total_tokens).toBe(140_000)
    expect(res.active_days).toBe(2)
    expect(res.cost_per_active_day).not.toBeNull()
    expect(Number(res.cost_per_active_day)).toBeCloseTo(0.2, 2)
    expect(res.series.length).toBe(2)
    // cost-share desc → fable first.
    expect(res.by_model[0]!.model).toBe('claude-fable-5')
    expect(res.by_model.length).toBe(2)
  })

  it('is requester-scoped — never sums another teammate’s spend', async () => {
    const res = await recentHandler(ev(sess(devId), 30))
    // otherId spent $5; dev must still read $0.40.
    expect(Number(res.total_cost_usd)).toBeLessThan(1)
  })

  it('honours the 7-day window and defaults are within range', async () => {
    const res = await recentHandler(ev(sess(devId), 7))
    expect(res.window_days).toBe(7)
    // Both dev rows are within ~26h, so they stay in the 7d window.
    expect(res.active_days).toBe(2)
  })

  it('empty teammate: zero totals, no active days, null intensity', async () => {
    const res = await recentHandler(ev(sess(emptyId), 30))
    expect(Number(res.total_cost_usd)).toBe(0)
    expect(res.total_tokens).toBe(0)
    expect(res.active_days).toBe(0)
    expect(res.cost_per_active_day).toBeNull()
    expect(res.series).toEqual([])
    expect(res.by_model).toEqual([])
  })
})

/*
 * `has_ever_emitted` — the onboarding CTA's operand (external review r2 + owner
 * ruling). It asks ONE thing: has this teammate ever emitted OTel? The lane is
 * `attribution_record`, whose only writer is the Azure-Monitor reader.
 *
 * RED ON REVERT: source it from anything that counts API-reported records —
 * `v_complete_usage`, the Activity union, a spend total — and the Copilot-only
 * case below goes red, because that teammate has money on record and has
 * emitted nothing.
 */
describe('/api/v1/me/home — has_ever_emitted is an OTel-lane fact', () => {
  it('true for a teammate with OTel records', async () => {
    const res = await homeHandler(ev(sess(devId)) as never)
    expect((res as { has_ever_emitted: boolean }).has_ever_emitted).toBe(true)
  })

  it('FALSE for a teammate whose only record is a provider-reported day', async () => {
    const res = await homeHandler(ev(sess(emptyId)) as never)
    expect((res as { has_ever_emitted: boolean }).has_ever_emitted).toBe(false)
    // …and the provider day really is on record, or the case proves nothing.
    const [row] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM unaccounted_usage WHERE teammate_id = ${emptyId}::uuid`
    expect(Number(row!.n)).toBeGreaterThan(0)
  })

  it('is teammate-scoped — another teammate emitting does not answer for you', async () => {
    const other = await homeHandler(ev(sess(otherId)) as never)
    expect((other as { has_ever_emitted: boolean }).has_ever_emitted).toBe(true)
    const none = await homeHandler(ev(sess(emptyId)) as never)
    expect((none as { has_ever_emitted: boolean }).has_ever_emitted).toBe(false)
  })
})
