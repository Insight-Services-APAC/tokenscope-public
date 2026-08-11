// @vitest-environment node
/*
 * Producer-vs-read-API parity test.
 *
 * Wave 2a (MVP-Final convergence) closes a credibility-destroying bug
 * class: pre-convergence, the inbox claimed `usedUsd = 12710` for a
 * project while the homepage SQL aggregation said `cost_usd = 0.09`. The
 * inbox was hand-coded in drizzle/seed.ts; the homepage read live SQL.
 *
 * This file pins the contract that closes that bug: the SAME inputs (one
 * teammate, one project, one allocation, N attribution_record rows)
 * routed through the BUDGET-ALERT producer MUST equal the SAME inputs
 * routed through the homepage SQL (server/api/v1/me/home.get.ts).
 *
 * If a future change drifts the producer SQL away from the read-API SQL,
 * this test fails — the only way to make it pass again is to re-converge
 * the two surfaces.
 *
 * Sync-conflict is intentionally NOT covered: it has no read-API "live"
 * surface to compare against (the homepage doesn't render unresolved
 * sync conflicts inline).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { runBudgetAlert } from '../../../server/workers/budget-alert'
import { runVelocityWatch } from '../../../server/workers/velocity-watch'

let t: TestDb
let regionId: string
let buId: string
let rateCardId: string
let rateCardVersion: number

// Fixed clock so the SQL window math is reproducible. A mid-week
// Wednesday in May 2026 — current ISO week starts Mon 11 May.
const NOW = new Date('2026-05-13T12:00:00Z')
const MONTH_START_ISO = '2026-05-01T00:00:00.000Z'

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'parity', displayName: 'Parity Region' })
    .returning()
  regionId = region!.id

  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'parity.svc',
      code: 'parity-svc',
      displayName: 'Parity Services',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  buId = bu!.id

  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)
  rateCardId = rc!.id
  rateCardVersion = rc!.version
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

async function createTeammate(suffix: string): Promise<string> {
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-parity-${suffix}`,
      email: `${suffix}@parity.test`,
      displayName: `Parity ${suffix}`,
      regionId,
      orgUnitId: buId,
    })
    .returning()
  return tm!.id
}

async function newAuditId(actorId: string): Promise<string> {
  const [e] = await t.db
    .insert(schema.auditEvent)
    .values({
      eventType: 'allocation-created',
      actorTeammateId: actorId,
      subjectKind: 'project',
      payload: { test: true },
    })
    .returning({ id: schema.auditEvent.id })
  return e!.id
}

async function createProjectWithAllocation(
  code: string,
  budgetUsd: string,
  ownerId: string,
): Promise<string> {
  const [p] = await t.db
    .insert(schema.project)
    .values({
      code,
      codeHash: `h-${code.toLowerCase()}`,
      displayName: `Project ${code}`,
      type: 'billable',
      regionId,
      costOwningUnitId: buId,
    })
    .returning({ id: schema.project.id })
  await t.db.insert(schema.allocation).values({
    scopeType: 'project',
    scopeId: p!.id,
    budgetUsd,
    effective: '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)',
    allocationKind: 'baseline',
    auditEventId: await newAuditId(ownerId),
  })
  return p!.id
}

async function assignTeammate(projectId: string, teammateId: string): Promise<void> {
  await t.db.insert(schema.projectAssignment).values({
    projectId,
    teammateId,
    effective: '[2026-03-01T00:00:00+00,)',
    source: 'parity-test',
  })
}

async function emit(
  teammateId: string,
  projectId: string,
  costUsd: number,
  when: Date,
): Promise<void> {
  const sid = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId: sid,
    principalOid: `oid-${teammateId}`,
    teammateId,
    projectCodeHash: `h-${sid.slice(0, 8)}`,
    rawProjectCode: 'PARITY',
    tool: 'claude-code',
    sessionTokenHash: `tok-${sid}`,
    tsStart: when,
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
  })
  await t.db.insert(schema.attributionRecord).values({
    instanceId: sid,
    teammateId,
    projectId,
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
    tool: 'claude-code',
    model: 'claude-opus-4-1',
    tokenType: 'output',
    tokens: 1_000n,
    costUsd: costUsd.toFixed(6),
    rateCardId,
    rateCardVersion,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: when,
  })
}

/**
 * Mirrors the per-project SUM(cost_usd) shape from
 * server/api/v1/me/home.get.ts, scoped to a single (teammate, project).
 * The read API JOINs project_assignment first; for a single-teammate +
 * single-project fixture that's a SUM. We replicate the JOIN shape so
 * the test asserts shape-equivalence, not just numeric equivalence.
 */
async function readApiUsedUsdForProject(
  teammateId: string,
  projectId: string,
): Promise<number> {
  const rows = await t.db.execute<{ cost_usd: string }>(
    sql`
      SELECT COALESCE(SUM(ar.cost_usd), 0)::text AS cost_usd
        FROM project p
        JOIN project_assignment pa ON pa.project_id = p.id
        LEFT JOIN attribution_record ar
          ON ar.project_id = p.id
         AND ar.teammate_id = ${teammateId}::uuid
         AND ar.ts_event >= ${MONTH_START_ISO}::timestamptz
       WHERE pa.teammate_id = ${teammateId}::uuid
         AND lower(pa.effective) <= ${MONTH_START_ISO}::timestamptz
         AND p.id = ${projectId}::uuid
       GROUP BY p.id
    `,
  )
  return rows.length > 0 ? Number(rows[0]!.cost_usd) : 0
}

describe('producer/read-API parity', () => {
  it('budget-alert: inbox body.usedUsd matches the homepage SQL for the same project', async () => {
    // Single teammate so the per-project SUM from the producer is the
    // SAME shape as the per-teammate-per-project SUM from the read API.
    const teammateId = await createTeammate('budget-parity')
    const projectId = await createProjectWithAllocation(
      'PARITY-BUDGET',
      '100.00',
      teammateId,
    )
    await assignTeammate(projectId, teammateId)
    // Total spend $150 (over $100 cap by $50).
    await emit(teammateId, projectId, 60, new Date('2026-05-05T10:00:00Z'))
    await emit(teammateId, projectId, 47.25, new Date('2026-05-09T10:00:00Z'))
    await emit(teammateId, projectId, 42.75, new Date('2026-05-12T10:00:00Z'))

    const result = await runBudgetAlert(t.db, { now: NOW })
    expect(result.alertsDispatched).toBeGreaterThanOrEqual(1)

    const inbox = await t.client<
      { body: { usedUsd: number; capUsd: number; project: string } }[]
    >`
      SELECT body::jsonb AS body FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid
         AND category = 'over-budget'
       LIMIT 1
    `
    expect(inbox.length).toBe(1)
    const inboxUsed = inbox[0]!.body.usedUsd
    const readApiUsed = await readApiUsedUsdForProject(teammateId, projectId)

    // Parity contract: inbox claim about project X = read-API claim about
    // project X. If these drift, ONE of them is wrong — the inbox lies.
    // Tolerance is $0.01 to absorb numeric rounding in SUM(numeric)
    // through the json round-trip.
    expect(Math.abs(inboxUsed - readApiUsed)).toBeLessThanOrEqual(0.01)
    expect(inboxUsed).toBe(150)
    expect(readApiUsed).toBe(150)
  })

  it('velocity-watch: inbox body.currentUsd matches the SUM of the current ISO week', async () => {
    // velocity-watch's drawer body promises `currentUsd` — the teammate's
    // spend in the CURRENT ISO week. The parity claim: that number must
    // equal the SUM(cost_usd) for ts_event in [currentWeekStart,
    // currentWeekStart + 7d). If they drift, the sparkline last-bar lies.
    const teammateId = await createTeammate('velocity-parity')
    const projectId = await createProjectWithAllocation(
      'PARITY-VELOCITY',
      '10000.00',
      teammateId,
    )
    await assignTeammate(projectId, teammateId)

    // NOW = Wed 13-May-2026 → current ISO week starts Mon 11-May.
    const currentWeekStart = isoWeekStartUtc(NOW)
    // 4 prior weeks @ $100 each + current week @ $145 (split across
    // 3 events to exercise the SUM path).
    for (let i = 4; i >= 1; i--) {
      const midWeek = addDaysUtc(addWeeksUtc(currentWeekStart, -i), 2)
      await emit(teammateId, projectId, 100, midWeek)
    }
    await emit(teammateId, projectId, 50, addDaysUtc(currentWeekStart, 0))
    await emit(teammateId, projectId, 45, addDaysUtc(currentWeekStart, 1))
    await emit(teammateId, projectId, 50, addDaysUtc(currentWeekStart, 2))

    const result = await runVelocityWatch(t.db, { now: NOW })
    expect(result.alertsDispatched).toBeGreaterThanOrEqual(1)

    const inbox = await t.client<
      { body: { currentUsd: number; meanUsd: number; weeklySeries: number[] } }[]
    >`
      SELECT body::jsonb AS body FROM inbox_item
       WHERE recipient_teammate_id = ${teammateId}::uuid
         AND category = 'velocity-warning'
       LIMIT 1
    `
    expect(inbox.length).toBe(1)
    const inboxCurrent = inbox[0]!.body.currentUsd

    // Read the current-week SUM directly — same date-range filter the
    // producer uses (date_trunc('week') in Postgres is ISO-week aligned).
    const weekStartIso = currentWeekStart.toISOString()
    const nextWeekIso = addWeeksUtc(currentWeekStart, 1).toISOString()
    const rows = await t.db.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM attribution_record
       WHERE teammate_id = ${teammateId}::uuid
         AND ts_event >= ${weekStartIso}::timestamptz
         AND ts_event <  ${nextWeekIso}::timestamptz
    `)
    const directCurrent = Number(rows[0]!.total)

    expect(Math.abs(inboxCurrent - directCurrent)).toBeLessThanOrEqual(0.01)
    expect(inboxCurrent).toBe(145)
    expect(directCurrent).toBe(145)
  })
})

// Helpers mirroring server/workers/velocity-watch.ts so the test doesn't
// reach into the worker's private internals.
function isoWeekStartUtc(d: Date): Date {
  const day = d.getUTCDay()
  const offset = (day + 6) % 7
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset),
  )
}

function addWeeksUtc(d: Date, weeks: number): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 7 * weeks),
  )
}

function addDaysUtc(d: Date, days: number): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, 12, 0, 0, 0),
  )
}
