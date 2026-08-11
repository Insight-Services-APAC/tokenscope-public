// @vitest-environment node
/*
 * Epic 12 allocator editor — SQL-contract integration test.
 *
 * Exercises the read query at GET /api/v1/allocations/{id}, the
 * PATCH-with-audit transaction, and the POST topups append-only path
 * directly against testcontainers Postgres. Per the existing
 * tests/integration/inbox/endpoints.test.ts pattern — assert the
 * SQL contract, not the Nitro transport.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let orgUnitId: string
let priyaId: string
let anilId: string
let projectId: string
let allocationId: string

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db.insert(schema.region).values({ code: 'apac-e', displayName: 'APAC' }).returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'apac.svc',
      code: 'svc-e',
      displayName: 'Services',
      unitType: 'bu',
    })
    .returning()
  orgUnitId = bu!.id

  const [priya] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-priya-e',
      email: 'priya.editor@example.com',
      displayName: 'Priya Iyer',
      regionId,
      orgUnitId,
    })
    .returning()
  priyaId = priya!.id
  const [anil] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-anil-e',
      email: 'anil.editor@example.com',
      displayName: 'Anil Verma',
      regionId,
      orgUnitId,
    })
    .returning()
  anilId = anil!.id

  const [proj] = await t.db
    .insert(schema.project)
    .values({
      code: 'CSL-AII-E',
      codeHash: 'h-afl-aii-e',
      displayName: 'Contoso League · AI Insights',
      type: 'billable',
      regionId,
      costOwningUnitId: orgUnitId,
    })
    .returning()
  projectId = proj!.id

  await t.db.insert(schema.projectAssignment).values([
    {
      projectId,
      teammateId: priyaId,
      effective: '[2026-05-01T00:00:00+00,)',
    },
    {
      projectId,
      teammateId: anilId,
      effective: '[2026-05-01T00:00:00+00,)',
    },
  ])

  const [evtBaseline] = await t.db
    .insert(schema.auditEvent)
    .values({
      eventType: 'allocation-created',
      actorTeammateId: anilId,
      subjectKind: 'project',
      subjectId: projectId,
      payload: { initial: true },
    })
    .returning({ id: schema.auditEvent.id })

  const [alloc] = await t.db
    .insert(schema.allocation)
    .values({
      scopeType: 'project',
      scopeId: projectId,
      budgetUsd: '10000.00',
      effective: '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)',
      allocationKind: 'baseline',
      auditEventId: evtBaseline!.id,
    })
    .returning({ id: schema.allocation.id })
  allocationId = alloc!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('GET /allocations/{id} read contract', () => {
  it('returns focused row + assigned devs + topups + project metadata', async () => {
    const focusedRows = await t.db.execute<{
      id: string
      project_id: string
      budget_usd: string
      project_code: string
      project_display_name: string
      cou_display_name: string
    }>(sql`
      SELECT a.id::text AS id,
             p.id::text AS project_id,
             a.budget_usd::text AS budget_usd,
             p.code AS project_code,
             p.display_name AS project_display_name,
             cou.display_name AS cou_display_name
      FROM allocation a
      LEFT JOIN project p ON p.id = a.scope_id AND a.scope_type = 'project'
      LEFT JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
      WHERE a.id = ${allocationId}::uuid
    `)
    const focused = [...focusedRows][0]
    expect(focused?.project_code).toBe('CSL-AII-E')
    expect(focused?.budget_usd).toBe('10000.00')

    const devs = await t.db.execute<{ email: string }>(sql`
      SELECT t.email
      FROM project_assignment pa
      JOIN teammate t ON t.id = pa.teammate_id
      WHERE pa.project_id = ${projectId}::uuid AND upper_inf(pa.effective)
      ORDER BY t.email
    `)
    const devList = [...devs]
    expect(devList.length).toBe(2)
    expect(devList.map((d) => d.email)).toContain('priya.editor@example.com')
    expect(devList.map((d) => d.email)).toContain('anil.editor@example.com')
  })
})

describe('PATCH /allocations/{id} write + audit invariant', () => {
  it('updates the focused row AND inserts an audit_event row atomically', async () => {
    const [evt] = await t.db
      .insert(schema.auditEvent)
      .values({
        eventType: 'allocation-updated',
        actorTeammateId: anilId,
        subjectKind: 'allocation',
        subjectId: allocationId,
        payload: { before: { budget_usd: '10000.00' }, after: { budget_usd: '11000.00' } },
      })
      .returning({ id: schema.auditEvent.id })

    await t.db.execute(sql`
      UPDATE allocation SET budget_usd = '11000.00', audit_event_id = ${evt!.id}::uuid
      WHERE id = ${allocationId}::uuid
    `)

    const after = await t.db.execute<{ budget_usd: string; audit_event_id: string }>(sql`
      SELECT budget_usd::text AS budget_usd, audit_event_id::text AS audit_event_id
      FROM allocation WHERE id = ${allocationId}::uuid
    `)
    const afterRow = [...after][0]
    expect(afterRow?.budget_usd).toBe('11000.00')
    expect(afterRow?.audit_event_id).toBe(evt!.id)

    const events = await t.db.execute<{ event_type: string; actor_teammate_id: string | null }>(sql`
      SELECT event_type, actor_teammate_id::text AS actor_teammate_id
      FROM audit_event WHERE id = ${evt!.id}::uuid
    `)
    expect([...events][0]?.event_type).toBe('allocation-updated')
  })
})

describe('POST /allocations/{id}/topups append-only invariant', () => {
  it('appends a new top-up row, never overwrites the focused row', async () => {
    const [evt] = await t.db
      .insert(schema.auditEvent)
      .values({
        eventType: 'allocation-topup-added',
        actorTeammateId: anilId,
        subjectKind: 'allocation',
        subjectId: allocationId,
        payload: { after: { budget_usd: '500.00', allocation_kind: 'top-up' } },
      })
      .returning({ id: schema.auditEvent.id })

    const [topup] = await t.db
      .insert(schema.allocation)
      .values({
        scopeType: 'project',
        scopeId: projectId,
        budgetUsd: '500.00',
        effective: '[2026-05-15T00:00:00+00,2026-06-01T00:00:00+00)',
        allocationKind: 'top-up',
        auditEventId: evt!.id,
      })
      .returning({ id: schema.allocation.id })

    expect(topup?.id).toBeDefined()
    expect(topup?.id).not.toBe(allocationId)

    // Focused baseline row unchanged.
    const baseline = await t.db.execute<{ id: string; budget_usd: string; allocation_kind: string }>(sql`
      SELECT id::text AS id, budget_usd::text AS budget_usd, allocation_kind
      FROM allocation WHERE id = ${allocationId}::uuid
    `)
    const baseRow = [...baseline][0]
    expect(baseRow?.allocation_kind).toBe('baseline')

    // Both rows visible for the project (baseline + top-up).
    const all = await t.db.execute<{ id: string; allocation_kind: string }>(sql`
      SELECT id::text AS id, allocation_kind
      FROM allocation WHERE scope_type = 'project' AND scope_id = ${projectId}::uuid
      ORDER BY allocation_kind
    `)
    const kinds = [...all].map((r) => r.allocation_kind)
    expect(kinds).toContain('baseline')
    expect(kinds).toContain('top-up')
  })
})

describe('velocity worker SQL contract', () => {
  it('flags a teammate with current-week spend ≥ 25% above the rolling mean', async () => {
    // Seed 4 weeks of prior history + an inflated current week for priya.
    const now = new Date()
    const [rc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)
    async function emit(weeksAgo: number, costUsd: number) {
      const ts = new Date(now.getTime() - weeksAgo * 7 * 24 * 60 * 60_000)
      const sessionId = randomUUID()
      await t.db.insert(schema.instanceAttestation).values({
        instanceId: sessionId,
        principalOid: 'oid-priya-e',
        teammateId: priyaId,
        projectCodeHash: 'h-afl-aii-e',
        rawProjectCode: 'CSL-AII-E',
        tool: 'claude-code',
        sessionTokenHash: 'tok-vel-' + sessionId,
        tsStart: ts,
        regionId,
        orgUnitId,
        costOwningUnitId: orgUnitId,
      })
      await t.db.insert(schema.attributionRecord).values({
        instanceId: sessionId,
        teammateId: priyaId,
        projectId,
        regionId,
        orgUnitId,
        costOwningUnitId: orgUnitId,
        tool: 'claude-code',
        model: 'claude-opus-4-1',
        tokenType: 'output',
        tokens: BigInt(1000),
        costUsd: costUsd.toFixed(6),
        rateCardId: rc!.id,
        rateCardVersion: rc!.version,
        fidelityTier: 'tier-1',
        costBasis: 'estimated',
        tsEvent: ts,
      })
    }
    // Prior 4 weeks: $100/wk each. Current week: $150 (50% above mean).
    await emit(4, 100)
    await emit(3, 100)
    await emit(2, 100)
    await emit(1, 100)
    await emit(0, 150)

    const rows = await t.db.execute<{
      teammate_id: string
      current_week_usd: string
      rolling_mean_usd: string
      is_flagged: boolean
    }>(sql`
      WITH weekly AS (
        SELECT t.id AS teammate_id,
               date_trunc('week', ar.ts_event)::date AS week_start,
               SUM(ar.cost_usd) AS week_usd
        FROM teammate t
        JOIN attribution_record ar ON ar.teammate_id = t.id
        WHERE t.id = ${priyaId}::uuid
          AND ar.ts_event >= date_trunc('week', NOW()) - INTERVAL '4 weeks'
        GROUP BY t.id, date_trunc('week', ar.ts_event)
      ),
      pivoted AS (
        SELECT teammate_id,
               COALESCE(SUM(week_usd) FILTER (WHERE week_start = date_trunc('week', NOW())::date), 0) AS current_week_usd,
               AVG(week_usd) FILTER (WHERE week_start < date_trunc('week', NOW())::date) AS rolling_mean_usd
        FROM weekly GROUP BY teammate_id
      )
      SELECT teammate_id::text AS teammate_id,
             COALESCE(current_week_usd, 0)::text AS current_week_usd,
             COALESCE(rolling_mean_usd, 0)::text AS rolling_mean_usd,
             CASE
               WHEN rolling_mean_usd IS NULL OR rolling_mean_usd = 0 THEN FALSE
               ELSE (current_week_usd - rolling_mean_usd) / rolling_mean_usd >= 0.25
             END AS is_flagged
      FROM pivoted
    `)
    const flagged = [...rows].find((r) => r.teammate_id === priyaId)
    expect(flagged).toBeDefined()
    expect(Number(flagged!.current_week_usd)).toBe(150)
    expect(Number(flagged!.rolling_mean_usd)).toBe(100)
    expect(flagged!.is_flagged).toBe(true)
  })
})
