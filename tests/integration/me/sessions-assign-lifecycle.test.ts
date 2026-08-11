// @vitest-environment node
/*
 * Re-tag endpoint as the SECOND project_id writer (D2a):
 *   - reject an ENDED target (can't re-tag spend onto a dead project)
 *   - boundary preservation: re-tagging a conversation that spans an end
 *     boundary moves ONLY the unallocated (spilled) rows; the rows frozen to
 *     the ended project stay on it (else one re-tag flattens D2's split).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import assignHandler from '../../../server/api/v1/me/sessions/[sid]/assign.post'
// §F4: /me/sessions/recent retired; the split cue now rides the Activity list.
import activityHandler from '../../../server/api/v1/me/activity.get'
import type { ActivityListResponse, ActivitySessionRow } from '../../../shared/schemas/activity'

let t: TestDb
let devId: string
let regionId: string
let ouId: string
let endedId: string
let activeId: string
const CONV = '0a111111-2222-4333-8444-555566660001'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'al-r', displayName: 'AL R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'al.svc', code: 'al-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [dev] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-al-dev', email: 'al-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  devId = dev!.id
  const [x] = await t.db
    .insert(schema.project)
    .values({ code: 'AL-X', codeHash: 'h-al-x', displayName: 'X', type: 'billable', regionId, costOwningUnitId: ouId, endDate: new Date('2026-06-01T00:00:00Z') })
    .returning()
  endedId = x!.id
  const [y] = await t.db
    .insert(schema.project)
    .values({ code: 'AL-Y', codeHash: 'h-al-y', displayName: 'Y', type: 'billable', regionId, costOwningUnitId: ouId })
    .returning()
  activeId = y!.id
  // dev is a member of both.
  for (const pid of [endedId, activeId]) {
    await t.client.unsafe(`INSERT INTO project_assignment (project_id, teammate_id, effective) VALUES ('${pid}','${devId}','[2026-01-01,2099-01-01)'::tstzrange)`)
  }

  const inst = randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, session_token_hash, ts_start, region_id, org_unit_id, attestation_state)
    VALUES ('${inst}','oid-al-dev','al-dev@x.test','${devId}','claude-code','tok-${inst}', now(), '${regionId}','${ouId}','unassigned')`)
  const [rc] = await t.db.select({ id: schema.rateCard.id, version: schema.rateCard.version }).from(schema.rateCard).limit(1)
  const base = {
    instanceId: inst, claudeSessionId: CONV, teammateId: devId, regionId, orgUnitId: ouId,
    tool: 'claude-code', model: 'claude-sonnet-4-6', tokenType: 'output' as const, tokens: 1000n,
    costUsd: '5.00', rateCardId: rc!.id, rateCardVersion: rc!.version, fidelityTier: 'tier-2', costBasis: 'telemetry-only',
  }
  // One row frozen to the ENDED project X; one row unallocated (the spill).
  await t.db.insert(schema.attributionRecord).values([
    { ...base, projectId: endedId, costOwningUnitId: ouId, tsEvent: new Date('2026-05-31T23:00:00Z') },
    { ...base, projectId: null, costOwningUnitId: null, tsEvent: new Date('2026-06-01T05:00:00Z') },
  ])
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function ev(opts: { body: unknown; session: Session }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'POST',
    path: '/x',
    context: { params: { sid: CONV } },
    node: {
      req: {
        method: 'POST',
        url: '/x',
        body: opts.body,
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof assignHandler>[0]
}
const devSession = (): Session => ({ teammateId: devId, email: 'al-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'al.svc' })

async function counts() {
  const rows = await t.client<{ on_x: string; on_y: string; unalloc: string }[]>`
    SELECT
      COUNT(*) FILTER (WHERE project_id = ${endedId}::uuid)::text AS on_x,
      COUNT(*) FILTER (WHERE project_id = ${activeId}::uuid)::text AS on_y,
      COUNT(*) FILTER (WHERE project_id IS NULL)::text AS unalloc
    FROM attribution_record WHERE claude_session_id = ${CONV} AND teammate_id = ${devId}::uuid`
  return rows[0]!
}

// activity.get is a GET with no sid param; minimal event wrapper.
function recentEv(session: Session) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: '/x?kind=session',
    context: {},
    node: {
      req: { method: 'GET', url: '/x?kind=session', socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
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
  return e as unknown as Parameters<typeof activityHandler>[0]
}
async function convRow() {
  const out = (await activityHandler(recentEv(devSession()))) as ActivityListResponse
  return out.rows.find((r) => r.kind === 'session' && r.id === CONV) as ActivitySessionRow
}

describe('re-tag boundary guard', () => {
  it('Activity flags partly_ended for the boundary-spanning conversation (pre-re-tag)', async () => {
    const r = await convRow()
    expect(r.partly_ended).toBe(true) // ended-X row + unallocated row
    expect(r.ended_project_code).toBe('AL-X')
  })

  it('rejects re-tagging onto an ended project (409)', async () => {
    await expect(assignHandler(ev({ body: { project_id: endedId }, session: devSession() }))).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  it('moves only the spilled (unallocated) rows to Y; the ended project keeps its frozen row', async () => {
    const out = await assignHandler(ev({ body: { project_id: activeId }, session: devSession() }))
    expect((out as { project_id: string | null }).project_id).toBe(activeId)
    const c = await counts()
    expect(Number(c.on_x)).toBe(1) // frozen pre-end row stays on the ended project
    expect(Number(c.on_y)).toBe(1) // only the spilled row moved to Y
    expect(Number(c.unalloc)).toBe(0)
  })

  it('Activity STILL flags partly_ended after the re-tag (X ended + Y active, no unallocated)', async () => {
    // The conversation now has a row on ended X and a row on active Y, zero
    // unallocated. The old "ended + unallocated" indicator would have gone false
    // here, hiding the split; the corrected "ended + non-ended" must stay true.
    const r = await convRow()
    expect(r.partly_ended).toBe(true)
    expect(r.ended_project_code).toBe('AL-X')
  })
})
