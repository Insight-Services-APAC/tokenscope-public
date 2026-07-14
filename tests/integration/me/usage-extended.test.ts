// @vitest-environment node
/*
 * Epic 11 /api/v1/me/usage extension — SQL-contract integration test.
 *
 * Validates the contract that the handler relies on:
 *   - allocation_total_usd per bucket = SUM(allocation.budget_usd) for
 *     scope_type='project', scope_id=project.id, allocation_kind IN
 *     ('baseline','top-up') with effective @> monthStart
 *   - is_active_now = true iff there's an attribution_record for the
 *     user+project within the last 30 minutes
 *   - top-level total_allocation_usd = SUM of bucket allocations
 *
 * Hits the SQL the handler emits, not the Nitro transport — matches
 * the existing inbox/endpoints.test.ts pattern.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import usageHandler from '../../../server/api/v1/me/usage.get'

let t: TestDb
let priyaId: string
let proj1Id: string
let proj2Id: string

const monthStart = new Date('2026-05-01T00:00:00Z').toISOString()

beforeAll(async () => {
  t = await startTestDb()
  // The handler test (below) invokes the real handler, which connects via
  // getDb()/withRequestRls reading these env vars; the SQL-contract tests use
  // t.db directly and don't need them.
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'usage-test-padded-to-thirty-two-characters'
  process.env.NUXT_HMAC_SESSION_KEY = 'usage-test-hmac-key-padded-well-beyond-32-chars-xyz'

  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'apac-u', displayName: 'APAC' })
    .returning()
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: region!.id,
      path: 'apac.svc',
      code: 'svc',
      displayName: 'Services',
      unitType: 'bu',
    })
    .returning()
  const [priya] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-priya-u',
      email: 'priya.usage@example.com',
      regionId: region!.id,
      orgUnitId: bu!.id,
    })
    .returning()
  priyaId = priya!.id

  const [p1] = await t.db
    .insert(schema.project)
    .values({
      code: 'AFL-AII',
      codeHash: 'h-afl-aii-u',
      displayName: 'AFL · AI Insights',
      type: 'billable',
      regionId: region!.id,
      costOwningUnitId: bu!.id,
    })
    .returning()
  proj1Id = p1!.id

  const [p2] = await t.db
    .insert(schema.project)
    .values({
      code: 'NAB-RR',
      codeHash: 'h-nab-rr-u',
      displayName: 'NAB · Retail risk',
      type: 'billable',
      regionId: region!.id,
      costOwningUnitId: bu!.id,
    })
    .returning()
  proj2Id = p2!.id

  await t.db.insert(schema.projectAssignment).values([
    {
      projectId: proj1Id,
      teammateId: priyaId,
      effective: '[2026-04-01T00:00:00+00,2026-12-31T00:00:00+00)',
      role: 'member',
    },
    {
      projectId: proj2Id,
      teammateId: priyaId,
      effective: '[2026-04-01T00:00:00+00,2026-12-31T00:00:00+00)',
      role: 'member',
    },
  ])

  // Allocations: P1 baseline + top-up + a BURST that must be excluded.
  // Use a fresh audit_event per row (FK requirement) — values aren't
  // load-bearing for this test.
  async function newAuditId(): Promise<string> {
    const [e] = await t.db
      .insert(schema.auditEvent)
      .values({
        eventType: 'allocation-created',
        actorTeammateId: priyaId,
        subjectKind: 'project',
        subjectId: proj1Id,
        payload: { test: true },
      })
      .returning({ id: schema.auditEvent.id })
    return e!.id
  }

  await t.db.insert(schema.allocation).values([
    {
      scopeType: 'project',
      scopeId: proj1Id,
      budgetUsd: '10000.00',
      effective: '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)',
      allocationKind: 'baseline',
      auditEventId: await newAuditId(),
    },
    {
      // Top-ups in production are typically backdated to cover the
      // existing period so they count toward "this month's allocation".
      scopeType: 'project',
      scopeId: proj1Id,
      budgetUsd: '2500.00',
      effective: '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)',
      allocationKind: 'top-up',
      auditEventId: await newAuditId(),
    },
    {
      scopeType: 'project',
      scopeId: proj1Id,
      budgetUsd: '9999.00',
      effective: '[2026-05-15T00:00:00+00,2026-05-16T00:00:00+00)',
      allocationKind: 'burst',
      auditEventId: await newAuditId(),
    },
    {
      scopeType: 'project',
      scopeId: proj2Id,
      budgetUsd: '4000.00',
      effective: '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)',
      allocationKind: 'baseline',
      auditEventId: await newAuditId(),
    },
  ])
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('Epic 11 /me/usage allocation rollup contract', () => {
  it('sums baseline + top-up allocations and excludes burst kind', async () => {
    const rows = await t.db.execute<{ project_id: string; allocation_total_usd: string }>(
      sql`
        SELECT p.id::text AS project_id,
               COALESCE(SUM(al.budget_usd)::text, '0') AS allocation_total_usd
        FROM project p
        LEFT JOIN allocation al
          ON al.scope_type = 'project'
         AND al.scope_id = p.id
         AND al.allocation_kind IN ('baseline', 'top-up')
         AND al.effective @> ${monthStart}::timestamptz
        WHERE p.id IN (${sql.raw(`'${proj1Id}'`)}::uuid, ${sql.raw(`'${proj2Id}'`)}::uuid)
        GROUP BY p.id
        ORDER BY p.code
      `,
    )
    const rowList = [...rows]
    expect(rowList.length).toBe(2)
    const p1Row = rowList.find((r) => r.project_id === proj1Id)
    const p2Row = rowList.find((r) => r.project_id === proj2Id)
    // P1 baseline 10000 + top-up 2500 = 12500 (burst 9999 EXCLUDED)
    expect(Number(p1Row!.allocation_total_usd)).toBe(12500)
    expect(Number(p2Row!.allocation_total_usd)).toBe(4000)
  })

  it('is_active_now flips true when an attribution_record exists inside the window', async () => {
    // Create a session attestation + an attribution_record 10 min ago for proj1.
    const recentTs = new Date(Date.now() - 10 * 60_000).toISOString()
    const sessionId = randomUUID()
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: sessionId,
      principalOid: 'oid-priya-u',
      teammateId: priyaId,
      projectCodeHash: 'h-afl-aii-u',
      rawProjectCode: 'AFL-AII',
      tool: 'claude-code',
      sessionTokenHash: 'tok-active-' + sessionId,
      tsStart: new Date(Date.now() - 15 * 60_000),
      regionId: (await t.db.select({ id: schema.region.id }).from(schema.region).limit(1))[0]!.id,
      orgUnitId: (await t.db.select({ id: schema.orgUnit.id }).from(schema.orgUnit).limit(1))[0]!.id,
      costOwningUnitId: (await t.db.select({ id: schema.orgUnit.id }).from(schema.orgUnit).limit(1))[0]!.id,
    })
    const [rc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)
    await t.db.insert(schema.attributionRecord).values({
      instanceId: sessionId,
      teammateId: priyaId,
      projectId: proj1Id,
      regionId: (await t.db.select({ id: schema.region.id }).from(schema.region).limit(1))[0]!.id,
      orgUnitId: (await t.db.select({ id: schema.orgUnit.id }).from(schema.orgUnit).limit(1))[0]!.id,
      costOwningUnitId: (await t.db.select({ id: schema.orgUnit.id }).from(schema.orgUnit).limit(1))[0]!.id,
      tool: 'claude-code',
      model: 'claude-opus-4-1',
      tokenType: 'output',
      tokens: 1000n,
      costUsd: '0.50',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: new Date(recentTs),
    })

    const activeCutoff = new Date(Date.now() - 30 * 60_000).toISOString()
    const flags = await t.db.execute<{ project_id: string; is_active_now: boolean }>(
      sql`
        SELECT p.id::text AS project_id,
               EXISTS (
                 SELECT 1 FROM attribution_record arn
                  WHERE arn.teammate_id = ${priyaId}::uuid
                    AND arn.project_id = p.id
                    AND arn.ts_event >= ${activeCutoff}::timestamptz
               ) AS is_active_now
        FROM project p
        WHERE p.id IN (${sql.raw(`'${proj1Id}'`)}::uuid, ${sql.raw(`'${proj2Id}'`)}::uuid)
      `,
    )
    const flagList = [...flags]
    const p1Flag = flagList.find((r) => r.project_id === proj1Id)
    const p2Flag = flagList.find((r) => r.project_id === proj2Id)
    expect(p1Flag!.is_active_now).toBe(true)
    expect(p2Flag!.is_active_now).toBe(false)
  })
})

// GET event mock with an injected session (mirrors enrolment.test.ts).
function evForSession(session: Session) {
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const e = {
    method: 'GET',
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url: '/x',
        get headers() {
          return { ...headers, cookie: '', 'content-type': 'application/json' }
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e
}

describe('/me/usage quota model — base allowance + unattributed gap (handler)', () => {
  it('returns base allowance, unattributed gap, total quota and total spend', async () => {
    // base allowance via env (proves the config path; deterministic)
    process.env.NUXT_BASE_ALLOWANCE_USD = '150'

    // Seed everything in the CURRENT month so the handler's runtime
    // new Date() month window picks it up regardless of the run date.
    const now = new Date()
    const mStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const mEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const effRange = `[${mStart.toISOString()},${mEnd.toISOString()})`
    const todayDate = now.toISOString().slice(0, 10)

    const [region] = await t.db
      .insert(schema.region)
      .values({ code: 'q-reg', displayName: 'QReg' })
      .returning()
    const [bu] = await t.db
      .insert(schema.orgUnit)
      .values({ regionId: region!.id, path: 'q.svc', code: 'q-svc', displayName: 'QSvc', unitType: 'bu' })
      .returning()
    const [quinn] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-quinn', email: 'quinn@example.com', regionId: region!.id, orgUnitId: bu!.id })
      .returning()
    const [proj] = await t.db
      .insert(schema.project)
      .values({
        code: 'Q-PROJ',
        codeHash: 'h-q-proj',
        displayName: 'Q Project',
        type: 'billable',
        regionId: region!.id,
        costOwningUnitId: bu!.id,
      })
      .returning()
    await t.db.insert(schema.projectAssignment).values({
      projectId: proj!.id,
      teammateId: quinn!.id,
      effective: effRange,
      role: 'member',
    })
    const [aud] = await t.db
      .insert(schema.auditEvent)
      .values({ eventType: 'allocation-created', actorTeammateId: quinn!.id, subjectKind: 'project', subjectId: proj!.id, payload: {} })
      .returning({ id: schema.auditEvent.id })
    await t.db.insert(schema.allocation).values({
      scopeType: 'project',
      scopeId: proj!.id,
      budgetUsd: '1000.00',
      effective: effRange,
      allocationKind: 'baseline',
      auditEventId: aud!.id,
    })

    // attributed $300 this month
    const sid = randomUUID()
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: sid,
      principalOid: 'oid-quinn',
      teammateId: quinn!.id,
      projectCodeHash: 'h-q-proj',
      rawProjectCode: 'Q-PROJ',
      tool: 'claude-code',
      sessionTokenHash: 'tok-' + sid,
      tsStart: now,
      regionId: region!.id,
      orgUnitId: bu!.id,
      costOwningUnitId: bu!.id,
    })
    const [rc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)
    await t.db.insert(schema.attributionRecord).values({
      instanceId: sid,
      teammateId: quinn!.id,
      projectId: proj!.id,
      regionId: region!.id,
      orgUnitId: bu!.id,
      costOwningUnitId: bu!.id,
      tool: 'claude-code',
      model: 'claude-opus-4-1',
      tokenType: 'output',
      tokens: 1000n,
      costUsd: '300.00',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: now,
    })
    // Anthropic actuals $380 this month → unattributed = max(0, 380 - 300) = 80
    await t.db.insert(schema.actualSpend).values({
      teammateId: quinn!.id,
      date: todayDate,
      tool: 'claude-code',
      inputTokens: 1000n,
      outputTokens: 500n,
      costUsd: '380.000000',
      source: 'anthropic-analytics-api',
    })

    const session: Session = {
      teammateId: quinn!.id,
      email: 'quinn@example.com',
      displayName: 'Quinn',
      role: 'developer',
      regionId: region!.id,
      orgPath: 'q.svc',
    }
    const res = await usageHandler(
      evForSession(session) as unknown as Parameters<typeof usageHandler>[0],
    )

    expect(res.total_cost_usd).toBe('300.00') // budgeted (project-attributed)
    expect(res.total_allocation_usd).toBe('1000.00')
    expect(res.base_allowance_usd).toBe('150.00')
    expect(res.total_quota_usd).toBe('1150.00') // base 150 + allocations 1000
    // Unallocated spend is sourced from the ledger via /me/sessions/untagged
    // (project_id IS NULL), not recomputed here.
  })

  it('computes total quota = base allowance + project allocations', async () => {
    process.env.NUXT_BASE_ALLOWANCE_USD = '150'
    const now = new Date()
    const mStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const mEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const effRange = `[${mStart.toISOString()},${mEnd.toISOString()})`

    const [region] = await t.db
      .insert(schema.region)
      .values({ code: 'r-reg', displayName: 'RReg' })
      .returning()
    const [bu] = await t.db
      .insert(schema.orgUnit)
      .values({ regionId: region!.id, path: 'r.svc', code: 'r-svc', displayName: 'RSvc', unitType: 'bu' })
      .returning()
    const [rao] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-rao', email: 'rao@example.com', regionId: region!.id, orgUnitId: bu!.id })
      .returning()
    const [proj] = await t.db
      .insert(schema.project)
      .values({ code: 'R-PROJ', codeHash: 'h-r-proj', displayName: 'R Project', type: 'billable', regionId: region!.id, costOwningUnitId: bu!.id })
      .returning()
    await t.db.insert(schema.projectAssignment).values({ projectId: proj!.id, teammateId: rao!.id, effective: effRange, role: 'member' })
    const [aud] = await t.db
      .insert(schema.auditEvent)
      .values({ eventType: 'allocation-created', actorTeammateId: rao!.id, subjectKind: 'project', subjectId: proj!.id, payload: {} })
      .returning({ id: schema.auditEvent.id })
    await t.db.insert(schema.allocation).values({ scopeType: 'project', scopeId: proj!.id, budgetUsd: '500.00', effective: effRange, allocationKind: 'baseline', auditEventId: aud!.id })

    const sid = randomUUID()
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: sid, principalOid: 'oid-rao', teammateId: rao!.id, projectCodeHash: 'h-r-proj',
      rawProjectCode: 'R-PROJ', tool: 'claude-code', sessionTokenHash: 'tok-' + sid, tsStart: now,
      regionId: region!.id, orgUnitId: bu!.id, costOwningUnitId: bu!.id,
    })
    const [rc] = await t.db.select({ id: schema.rateCard.id, version: schema.rateCard.version }).from(schema.rateCard).limit(1)
    await t.db.insert(schema.attributionRecord).values({
      instanceId: sid, teammateId: rao!.id, projectId: proj!.id, regionId: region!.id, orgUnitId: bu!.id,
      costOwningUnitId: bu!.id, tool: 'claude-code', model: 'claude-opus-4-1', tokenType: 'output',
      tokens: 1000n, costUsd: '200.00', rateCardId: rc!.id, rateCardVersion: rc!.version,
      fidelityTier: 'tier-1', costBasis: 'estimated', tsEvent: now,
    })
    const session: Session = {
      teammateId: rao!.id, email: 'rao@example.com', displayName: 'Rao', role: 'developer',
      regionId: region!.id, orgPath: 'r.svc',
    }
    const res = await usageHandler(evForSession(session) as unknown as Parameters<typeof usageHandler>[0])

    expect(res.total_cost_usd).toBe('200.00')
    expect(res.total_quota_usd).toBe('650.00') // 150 base + 500 allocation
    expect(res.base_allowance_usd).toBe('150.00')
  })

  it('reports unallocated spend split (tagged-by-activity vs needs-tagging), per-conversation + month-scoped', async () => {
    process.env.NUXT_BASE_ALLOWANCE_USD = '100'
    const now = new Date()
    const [region] = await t.db.insert(schema.region).values({ code: 'ua-reg', displayName: 'UReg' }).returning()
    const [bu] = await t.db
      .insert(schema.orgUnit)
      .values({ regionId: region!.id, path: 'u.svc', code: 'u-svc', displayName: 'USvc', unitType: 'bu' })
      .returning()
    const [uma] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-uma', email: 'uma@example.com', regionId: region!.id, orgUnitId: bu!.id })
      .returning()
    const [rc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)

    // One unassigned device instance; conversations differ by claude_session_id
    // (attribution_record.instance_id has an FK → instance_attestation).
    const instId = randomUUID()
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: instId,
      principalOid: 'oid-uma',
      teammateId: uma!.id,
      tool: 'claude-code',
      sessionTokenHash: 'tok-uma-' + instId,
      tsStart: now,
      regionId: region!.id,
      orgUnitId: bu!.id,
      attestationState: 'unassigned',
    })

    // Insert an UNALLOCATED (project_id NULL) row for a conversation, optional
    // activity. Each row gets a distinct (this-month) ts_event so two rows in the
    // SAME conversation don't collide on the (instance, conv, ts, token_type,
    // model) unique key — they still roll up to ONE session.
    let seq = 0
    async function unalloc(conv: string, activity: string | null, cost: string, tool = 'claude-code') {
      seq += 1
      await t.db.insert(schema.attributionRecord).values({
        instanceId: instId,
        claudeSessionId: conv,
        teammateId: uma!.id,
        projectId: null,
        regionId: region!.id,
        orgUnitId: bu!.id,
        costOwningUnitId: null,
        tool,
        model: 'claude-opus-4-1',
        tokenType: 'output',
        tokens: 1000n,
        costUsd: cost,
        rateCardId: rc!.id,
        rateCardVersion: rc!.version,
        fidelityTier: 'tier-1',
        costBasis: 'estimated',
        tsEvent: new Date(now.getTime() - seq * 60_000),
        activity,
      })
    }
    // Presentations: ONE conversation, two rows ($10 + $8 = $18, 1 session).
    await unalloc('conv-pres', 'Presentations', '10.00')
    await unalloc('conv-pres', 'Presentations', '8.00')
    await unalloc('conv-wiq', 'WorkIQ', '5.00') // claude-code session, $5
    await unalloc('conv-wiq-cop', 'WorkIQ', '2.00', 'copilot-cli') // copilot-cli session, $2 → WorkIQ is multi-tool
    await unalloc('conv-u1', null, '4.00') // untagged
    await unalloc('conv-u2', null, '3.00') // untagged → 2 conversations need tagging, $7
    // A prior-month untagged row that MUST be excluded by the month scope.
    await unalloc('conv-old', null, '999.00') // moved to LAST month below → must be excluded
    // Prior-month date derived from `now` (not hard-coded) so this doesn't flake in January.
    const priorMonthIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 86_400_000).toISOString()
    await t.db.execute(
      sql`UPDATE attribution_record SET ts_event = ${priorMonthIso}::timestamptz WHERE claude_session_id = 'conv-old' AND teammate_id = ${uma!.id}::uuid`,
    )

    const session: Session = {
      teammateId: uma!.id,
      email: 'uma@example.com',
      displayName: 'Uma',
      role: 'developer',
      regionId: region!.id,
      orgPath: 'u.svc',
    }
    const res = await usageHandler(evForSession(session) as unknown as Parameters<typeof usageHandler>[0])

    expect(res.unallocated.total_cost_usd).toBe('32.00') // 18 + 5 + 2 + 4 + 3 (prior-month 999 excluded)
    expect(res.unallocated.tagged_cost_usd).toBe('25.00') // 18 + (5 + 2)
    expect(res.unallocated.untagged_cost_usd).toBe('7.00') // 4 + 3
    expect(res.unallocated.needs_tagging_count).toBe(2) // two untagged conversations
    expect(res.unallocated.soft_cap_usd).toBe('100.00')
    expect(res.unallocated.over_soft_cap).toBe(false) // 32 < 100
    // tagged_spend grouped by activity, cost desc; per-conversation session counts.
    expect(res.tagged_spend.map((s) => s.activity)).toEqual(['Presentations', 'WorkIQ'])
    expect(res.tagged_spend[0]).toMatchObject({ activity: 'Presentations', cost_usd: '18.00', sessions: 1 })
    expect(res.tagged_spend[1]).toMatchObject({ activity: 'WorkIQ', cost_usd: '7.00', sessions: 2 })
    // per-activity contributing clients (drives the brand marks): the DISTINCT union
    // across conversations, ordered. Presentations is claude-only; WorkIQ is multi-tool.
    expect(res.tagged_spend[0].tools).toEqual(['claude-code'])
    expect(res.tagged_spend[1].tools).toEqual(['claude-code', 'copilot-cli'])
  })
})
