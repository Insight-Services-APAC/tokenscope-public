// @vitest-environment node
/*
 * GET /api/v1/me/activity/{activity} — the tag/activity drill-down, against
 * real Postgres via the REAL handler (AGENTS.md §"Never mock Drizzle").
 * Contract: teammate + activity + window scoped totals, model mix (cost desc),
 * token lanes, the session list (cost desc), requester scoping, and the empty
 * (untagged label) case.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import activityHandler from '../../../server/api/v1/me/activity/[activity].get'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let devId = ''
let otherId = ''
const INSTANCE = randomUUID()
const now = new Date()
const anchorMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12)

function ev(session: Session, activity: string, window = 30) {
  const url = `/x?window=${window}`
  const e = {
    method: 'GET',
    path: url,
    context: { params: { activity } },
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
  return e as unknown as Parameters<typeof activityHandler>[0]
}

const sess = (teammateId: string): Session =>
  ({
    teammateId,
    email: 'a@act.test',
    displayName: 'A',
    role: 'developer',
    regionId,
    orgPath: 'act',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [region] = await t.db.insert(schema.region).values({ code: 'r-act', displayName: 'RA' }).returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'a.svc', code: 'a-svc', displayName: 'ASvc', unitType: 'bu' })
    .returning()
  orgUnitId = bu!.id
  const mk = async (oid: string, email: string) => {
    const [tm] = await t.db.insert(schema.teammate).values({ entraOid: oid, email, regionId, orgUnitId }).returning()
    return tm!.id
  }
  devId = await mk('oid-act-dev', 'act.dev@example.com')
  otherId = await mk('oid-act-other', 'act.other@example.com')

  await t.db.insert(schema.instanceAttestation).values({
    instanceId: INSTANCE,
    principalOid: 'oid-act-dev',
    teammateId: devId,
    projectCodeHash: 'h-act',
    rawProjectCode: 'ACT',
    tool: 'claude-code',
    sessionTokenHash: 'tok-act-' + INSTANCE,
    tsStart: new Date(),
    regionId,
    orgUnitId,
    costOwningUnitId: orgUnitId,
  })

  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)

  const insert = (teammateId: string, conv: string, over: Record<string, unknown>) =>
    t.db.insert(schema.attributionRecord).values({
      instanceId: INSTANCE,
      claudeSessionId: conv,
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
      sourceRunId: conv,
      querySource: 'main',
      activity: 'research',
      ...over,
    } as never)

  // research: conv r1 (fable input+output), conv r2 (haiku input); feature-dev: f1.
  await insert(devId, 'conv-r1', { sourceRunId: 'r1a', tokens: 100_000n, costUsd: '0.300000' })
  await insert(devId, 'conv-r1', { sourceRunId: 'r1b', tokenType: 'output', tokens: 10_000n, costUsd: '0.150000' })
  await insert(devId, 'conv-r2', { sourceRunId: 'r2a', model: 'claude-haiku-4-5', tokens: 50_000n, costUsd: '0.100000' })
  await insert(devId, 'conv-f1', { sourceRunId: 'f1a', activity: 'feature-dev', tokens: 20_000n, costUsd: '0.050000' })
  // another teammate's research — must never leak.
  await insert(otherId, 'conv-o1', { sourceRunId: 'o1a', tokens: 500_000n, costUsd: '5.000000' })
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('/api/v1/me/activity/{activity}', () => {
  it('breaks an activity down by model, lane and session (cost desc)', async () => {
    const res = await activityHandler(ev(sess(devId), 'research', 30))
    expect(res.activity).toBe('research')
    expect(Number(res.total_cost_usd)).toBeCloseTo(0.55, 2)
    expect(res.total_tokens).toBe(160_000)
    // model mix, cost desc: fable (0.45) then haiku (0.10)
    expect(res.by_model.map((m) => m.model)).toEqual(['claude-fable-5', 'claude-haiku-4-5'])
    // token lanes: input (0.40) + output (0.15)
    const lanes = Object.fromEntries(res.by_token_type.map((l) => [l.token_type, Number(l.cost_usd)]))
    expect(lanes.input).toBeCloseTo(0.4, 2)
    expect(lanes.output).toBeCloseTo(0.15, 2)
    // two sessions, cost desc (r1 0.45 before r2 0.10)
    expect(res.session_count).toBe(2)
    expect(res.sessions[0]!.session_id).toBe('conv-r1')
    expect(Number(res.sessions[0]!.cost_usd)).toBeCloseTo(0.45, 2)
    expect(res.sessions[1]!.session_id).toBe('conv-r2')
  })

  it('is requester-scoped — another teammate’s spend on the same tag never leaks', async () => {
    const res = await activityHandler(ev(sess(devId), 'research', 30))
    expect(Number(res.total_cost_usd)).toBeLessThan(1) // not 5.55
  })

  it('scopes to the requested activity only', async () => {
    const res = await activityHandler(ev(sess(devId), 'feature-dev', 30))
    expect(Number(res.total_cost_usd)).toBeCloseTo(0.05, 2)
    expect(res.session_count).toBe(1)
  })

  it('an unused label returns an empty breakdown, not an error', async () => {
    const res = await activityHandler(ev(sess(devId), 'never-used', 30))
    expect(Number(res.total_cost_usd)).toBe(0)
    expect(res.session_count).toBe(0)
    expect(res.by_model).toEqual([])
    expect(res.sessions).toEqual([])
  })
})
