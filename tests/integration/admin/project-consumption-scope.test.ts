// @vitest-environment node
/*
 * API-1 (robustness-review-2026-06-09) — GET /projects/{id}/consumption must be
 * region-bounded for the region `admin` role (the same requireRegionScope
 * pattern the admin/* endpoints apply). Before the fix the scope predicate let
 * ANY admin read ANY project's consumption cross-region.
 *
 * Coverage:
 *   - region-B admin reading a region-A project → 403;
 *   - same-region admin / global-finops → real numbers;
 *   - manager keeps the org-subtree clamp (in-subtree numbers, out-of-subtree
 *     zeros — no region 403 for managers);
 *   - unknown project id → 404; malformed id → 400.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import consumptionHandler from '../../../server/api/v1/projects/[id]/consumption.get'

let t: TestDb
let regionAId: string
let regionBId: string
let alphaOuId: string
let projAId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'consumption-test-padded-to-thirty-two-chars'
  process.env.NUXT_HMAC_SESSION_KEY = 'consumption-test-hmac-key-padded-well-beyond-32'

  const [rA, rB] = await t.db
    .insert(schema.region)
    .values([
      { code: 'pc1', displayName: 'PC One' },
      { code: 'pc2', displayName: 'PC Two' },
    ])
    .returning()
  regionAId = rA!.id
  regionBId = rB!.id

  const [alpha] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionAId, path: 'pc1.alpha', code: 'pc-alpha', displayName: 'Alpha', unitType: 'practice', isCostOwningUnit: true })
    .returning()
  alphaOuId = alpha!.id
  await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionBId, path: 'pc2.gamma', code: 'pc-gamma', displayName: 'Gamma', unitType: 'practice', isCostOwningUnit: true })

  const [p] = await t.db
    .insert(schema.project)
    .values({ code: 'PC-A', codeHash: 'h-pc-a', displayName: 'PC A', type: 'billable', regionId: regionAId, costOwningUnitId: alphaOuId })
    .returning({ id: schema.project.id })
  projAId = p!.id

  // One attributed record on the region-A project so scoped reads see > $0.
  const [dev] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'pc-oid-1', email: 'pc-dev@example.com', displayName: 'PC Dev', regionId: regionAId, orgUnitId: alphaOuId })
    .returning()
  const [rc] = await t.db.select({ id: schema.rateCard.id, version: schema.rateCard.version }).from(schema.rateCard).limit(1)
  const sid = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId: sid, principalOid: 'pc-oid-att', teammateId: dev!.id, projectCodeHash: 'h-pc-a', rawProjectCode: 'PC-A',
    tool: 'claude-code', sessionTokenHash: 'tok-' + sid, tsStart: new Date(), regionId: regionAId, orgUnitId: alphaOuId, costOwningUnitId: alphaOuId,
  })
  await t.db.insert(schema.attributionRecord).values({
    instanceId: sid, teammateId: dev!.id, projectId: projAId, regionId: regionAId, orgUnitId: alphaOuId, costOwningUnitId: alphaOuId,
    tool: 'claude-code', model: 'claude-opus-4-1', tokenType: 'output', tokens: BigInt(1000), costUsd: '42.000000',
    rateCardId: rc!.id, rateCardVersion: rc!.version, fidelityTier: 'tier-1', costBasis: 'estimated', tsEvent: new Date(),
  })
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function sessionFor(role: string, regionId: string, orgPath: string): Session {
  return {
    teammateId: randomUUID(),
    email: `${role}@example.com`,
    displayName: role,
    role,
    regionId,
    orgPath,
  } as Session
}

function ev(projectId: string, session: Session) {
  const e = {
    method: 'GET',
    path: '/x',
    context: { params: { id: projectId } },
    node: {
      req: { method: 'GET', url: '/x', headers: { host: 'localhost:3450' } },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e
}

type ConsumptionOut = { project_id: string; total_cost_usd: string; total_tokens: number }

async function read(projectId: string, session: Session): Promise<ConsumptionOut> {
  return consumptionHandler(ev(projectId, session) as never) as Promise<ConsumptionOut>
}

describe('API-1 — project consumption is region-scoped for admins', () => {
  it('a region-B admin reading a region-A project → 403', async () => {
    await expect(read(projAId, sessionFor('admin', regionBId, 'pc2.gamma'))).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('a SAME-region admin reads real numbers', async () => {
    const out = await read(projAId, sessionFor('admin', regionAId, 'pc1.alpha'))
    expect(out.total_cost_usd).toBe('42.00')
    expect(out.total_tokens).toBe(1000)
  })

  it('global-finops is region-unbounded', async () => {
    const out = await read(projAId, sessionFor('global-finops', regionBId, 'pc2.gamma'))
    expect(out.total_cost_usd).toBe('42.00')
  })

  it('a manager IN the org subtree reads real numbers (no region 403 for managers)', async () => {
    const out = await read(projAId, sessionFor('manager', regionAId, 'pc1.alpha'))
    expect(out.total_cost_usd).toBe('42.00')
  })

  it("a manager OUTSIDE the org subtree gets zeros (the existing clamp), never another org's sum", async () => {
    const out = await read(projAId, sessionFor('manager', regionBId, 'pc2.gamma'))
    expect(out.total_cost_usd).toBe('0.00')
    expect(out.total_tokens).toBe(0)
  })

  it('unknown project id → 404; malformed id → 400', async () => {
    await expect(read(randomUUID(), sessionFor('admin', regionAId, 'pc1.alpha'))).rejects.toMatchObject({
      statusCode: 404,
    })
    await expect(read('nope', sessionFor('admin', regionAId, 'pc1.alpha'))).rejects.toMatchObject({
      statusCode: 400,
    })
  })
})
