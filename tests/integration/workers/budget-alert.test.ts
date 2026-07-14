// @vitest-environment node
/*
 * runBudgetAlert — over-budget producer integration test.
 *
 * Why this exists: see server/workers/budget-alert.ts header comment.
 * Validates the producer's contract end-to-end against a real testcontainers
 * Postgres so we exercise the same SQL shape the homepage uses.
 *
 * Pattern matches tests/integration/inbox/endpoints.test.ts: one
 * `startTestDb` shared across tests in the file, each case using a fresh
 * project code to isolate state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runBudgetAlert } from '../../../server/workers/budget-alert'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let buId: string
let priyaId: string
let lenaId: string
let rateCardId: string
let rateCardVersion: number

// Fixed "now" so every test runs against a known month-start window. May
// 2026 is consistent with the rest of the test corpus.
const NOW = new Date('2026-05-15T12:00:00Z')
const MONTH_START_ISO = '2026-05-01T00:00:00.000Z'

async function newAuditId(): Promise<string> {
  const [e] = await t.db
    .insert(schema.auditEvent)
    .values({
      eventType: 'allocation-created',
      actorTeammateId: priyaId,
      subjectKind: 'project',
      payload: { test: true },
    })
    .returning({ id: schema.auditEvent.id })
  return e!.id
}

async function createProject(code: string): Promise<string> {
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
  return p!.id
}

async function createBaselineAllocation(projectId: string, budgetUsd: string): Promise<void> {
  await t.db.insert(schema.allocation).values({
    scopeType: 'project',
    scopeId: projectId,
    budgetUsd,
    effective: '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)',
    allocationKind: 'baseline',
    auditEventId: await newAuditId(),
  })
}

async function recordSpend(
  projectId: string,
  costUsd: string,
  tsEvent: Date,
  teammateId: string = priyaId,
  identityState?: string,
): Promise<void> {
  const sessionId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId: sessionId,
    principalOid: `oid-${sessionId}`,
    teammateId,
    projectCodeHash: `h-spend-${sessionId.slice(0, 8)}`,
    rawProjectCode: 'SPEND',
    tool: 'claude-code',
    sessionTokenHash: `tok-${sessionId}`,
    tsStart: tsEvent,
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
  })
  await t.db.insert(schema.attributionRecord).values({
    instanceId: sessionId,
    teammateId,
    projectId,
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
    tool: 'claude-code',
    model: 'claude-opus-4-1',
    tokenType: 'output',
    tokens: 1000n,
    costUsd,
    rateCardId,
    rateCardVersion,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    identityState,
    tsEvent,
  })
}

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'apac-ba', displayName: 'APAC' })
    .returning()
  regionId = region!.id

  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'apac.svc',
      code: 'svc',
      displayName: 'Services',
      unitType: 'bu',
    })
    .returning()
  buId = bu!.id

  const [priya] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-priya-ba',
      email: 'priya.ba@example.com',
      regionId,
      orgUnitId: buId,
    })
    .returning()
  priyaId = priya!.id

  // Second teammate in the same org_unit. Under the post-convergence
  // routing rule (resolveOverBudgetRecipients), over-budget items go
  // to ACTUAL contributors first — teammates with at least one
  // attribution_record on the project this month. So lena receives an
  // alert ONLY when the test inserts a spend row attributed to her.
  // The "happy path" test below does exactly that (priya + lena both
  // record spend → both receive the alert).
  const [lena] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-lena-ba',
      email: 'lena.ba@example.com',
      regionId,
      orgUnitId: buId,
    })
    .returning()
  lenaId = lena!.id

  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)
  rateCardId = rc!.id
  rateCardVersion = rc!.version
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('runBudgetAlert', () => {
  it('dispatches an over-budget item with the drawer body shape when spend > cap', async () => {
    const projectId = await createProject('BA-OVER')
    await createBaselineAllocation(projectId, '100.00')
    // Two records summing to $150 (over $100 cap by $50). One from
    // priya, one from lena — both are contributors, so the dispatcher
    // emits the alert to both (the same fan-out shape as the seed:
    // multiple devs on the same overage).
    await recordSpend(projectId, '60.00', new Date('2026-05-10T10:00:00Z'), priyaId)
    await recordSpend(projectId, '90.00', new Date('2026-05-12T10:00:00Z'), lenaId)

    const result = await runBudgetAlert(t.db, { now: NOW })
    expect(result.alertsDispatched).toBeGreaterThanOrEqual(1)

    const rows = await t.client<
      {
        recipient_teammate_id: string
        category: string
        subject: string
        body: {
          project: string
          usedUsd: number
          capUsd: number
          overBy: number
          otelPct: number
          anthroPct: number
        }
      }[]
    >`
      SELECT recipient_teammate_id::text AS recipient_teammate_id,
             category, subject, body::jsonb AS body
        FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid
         AND category = 'over-budget'
         AND created_at >= ${MONTH_START_ISO}::timestamptz
    `
    // Dispatcher routes to ACTUAL contributors — both priya and lena
    // emitted attribution_record above, so both receive the alert.
    expect(rows.length).toBe(2)
    const sample = rows[0]!
    expect(sample.category).toBe('over-budget')
    expect(sample.subject).toContain('BA-OVER')
    expect(sample.subject).toContain('$50')
    expect(sample.body.project).toBe('BA-OVER')
    expect(sample.body.usedUsd).toBe(150)
    expect(sample.body.capUsd).toBe(100)
    expect(sample.body.overBy).toBe(50)
    // otelPct = 1.0 today (see budget-alert.ts header — all attribution_record
    // rows are OTel-attributed). anthroPct = 0.
    expect(sample.body.otelPct).toBe(1)
    expect(sample.body.anthroPct).toBe(0)
  })

  it('routes to budget-RESPONSIBLE parties (PM + CC owner) even with $0 contribution', async () => {
    // Honourable-links routing (mig 0048): the project's currently-
    // effective PM and the lead CC's active owner can ACT on the alert,
    // so they receive it regardless of their own spend.
    const projectId = await createProject('BA-RESP')
    await createBaselineAllocation(projectId, '100.00')
    const [pm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-pm-ba', email: 'pm.ba@example.com', regionId, orgUnitId: buId })
      .returning()
    const [owner] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-owner-ba', email: 'owner.ba@example.com', regionId, orgUnitId: buId })
      .returning()
    await t.db.insert(schema.projectAssignment).values({
      projectId,
      teammateId: pm!.id,
      effective: '[2026-04-01T00:00:00+00,)',
      role: 'manager',
    })
    await t.db.insert(schema.couOwner).values({ orgUnitId: buId, teammateId: owner!.id })
    // Only priya spends; the PM and owner contribute $0.
    await recordSpend(projectId, '150.00', new Date('2026-05-10T10:00:00Z'), priyaId)

    await runBudgetAlert(t.db, { now: NOW })

    const rows = await t.client<{ recipient_teammate_id: string }[]>`
      SELECT recipient_teammate_id::text AS recipient_teammate_id
        FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid AND category = 'over-budget'
    `
    const recipients = rows.map((r) => r.recipient_teammate_id)
    expect(recipients).toContain(pm!.id) // $0-spend PM: budget is their job
    expect(recipients).toContain(owner!.id) // $0-spend CC owner: their P&L
    expect(recipients).toContain(priyaId) // contributor, for awareness
    // Revoke the ownership so later fixtures stay clean.
    await t.client`
      UPDATE cou_owner SET revoked_at = now(), revoked_by = ${owner!.id}::uuid
      WHERE teammate_id = ${owner!.id}::uuid AND revoked_at IS NULL
    `
  })

  it('skips projects whose spend is under cap', async () => {
    const projectId = await createProject('BA-UNDER')
    await createBaselineAllocation(projectId, '100.00')
    await recordSpend(projectId, '50.00', new Date('2026-05-10T10:00:00Z'))

    const before = Number(
      (
        await t.client<{ c: string }[]>`
          SELECT COUNT(*)::text AS c FROM inbox_item
           WHERE related_entity_id = ${projectId}::uuid
        `
      )[0]!.c,
    )

    const result = await runBudgetAlert(t.db, { now: NOW })

    const after = Number(
      (
        await t.client<{ c: string }[]>`
          SELECT COUNT(*)::text AS c FROM inbox_item
           WHERE related_entity_id = ${projectId}::uuid
        `
      )[0]!.c,
    )
    expect(after).toBe(before)
    // result.alertsDispatched might be >0 for OTHER over-budget projects
    // in this DB; assert only that THIS project produced nothing.
    expect(result).toBeDefined()
  })

  it('is idempotent: a second run does not duplicate the alert', async () => {
    const projectId = await createProject('BA-IDEM')
    await createBaselineAllocation(projectId, '50.00')
    await recordSpend(projectId, '80.00', new Date('2026-05-10T10:00:00Z'))

    const first = await runBudgetAlert(t.db, { now: NOW })
    const firstRows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid AND category = 'over-budget'
    `
    const firstCount = Number(firstRows[0]!.c)
    expect(firstCount).toBeGreaterThanOrEqual(1)

    const second = await runBudgetAlert(t.db, { now: NOW })
    const secondRows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid AND category = 'over-budget'
    `
    const secondCount = Number(secondRows[0]!.c)
    expect(secondCount).toBe(firstCount)
    // skippedExisting on the second run must include this project.
    expect(second.skippedExisting).toBeGreaterThanOrEqual(1)
    // Silence unused-warning on `first` while still asserting it ran.
    expect(first.projectsScanned).toBeGreaterThanOrEqual(1)
  })

  it('skips projects with no allocation (cap = 0 means no over-budget concept)', async () => {
    const projectId = await createProject('BA-NOALLOC')
    // NO allocation row — just spend.
    await recordSpend(projectId, '500.00', new Date('2026-05-10T10:00:00Z'))

    await runBudgetAlert(t.db, { now: NOW })

    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid
         AND category = 'over-budget'
    `
    expect(Number(rows[0]!.c)).toBe(0)
  })

  it('excludes PROVISIONAL spend from the cap (provisional-only over cap -> no page)', async () => {
    // Emit-on-install provisional usage must never drive a budget page. The
    // project is $150 of provisional spend over a $100 cap, but provisional is
    // excluded from used_usd -> used=$0 -> no over-budget item.
    const projectId = await createProject('BA-PROV')
    await createBaselineAllocation(projectId, '100.00')
    await recordSpend(projectId, '150.00', new Date('2026-05-10T10:00:00Z'), priyaId, 'provisional')

    await runBudgetAlert(t.db, { now: NOW })

    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid AND category = 'over-budget'
    `
    expect(Number(rows[0]!.c)).toBe(0)
  })

  it('counts CONFIRMED spend toward the cap (alert fires)', async () => {
    // The same overage but confirmed identity counts -> the page fires. (NULL
    // legacy spend is already covered by the happy-path test above.)
    const projectId = await createProject('BA-CONF')
    await createBaselineAllocation(projectId, '100.00')
    await recordSpend(projectId, '150.00', new Date('2026-05-10T10:00:00Z'), priyaId, 'confirmed')

    await runBudgetAlert(t.db, { now: NOW })

    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid AND category = 'over-budget'
    `
    expect(Number(rows[0]!.c)).toBeGreaterThanOrEqual(1)
  })

  it('excludes burst-kind allocations from the cap', async () => {
    // Setup: baseline = $100, burst = $500 in same month. usedUsd = $150.
    // Burst-included cap would be $600 → no alert. Correct (burst-excluded)
    // cap is $100 → alert fires for $50 over. This is the same rule the
    // homepage uses (usage.get.ts), so this test guards the parity contract.
    const projectId = await createProject('BA-BURST')
    await createBaselineAllocation(projectId, '100.00')
    await t.db.insert(schema.allocation).values({
      scopeType: 'project',
      scopeId: projectId,
      budgetUsd: '500.00',
      effective: '[2026-05-10T00:00:00+00,2026-05-20T00:00:00+00)',
      allocationKind: 'burst',
      auditEventId: await newAuditId(),
    })
    await recordSpend(projectId, '150.00', new Date('2026-05-12T10:00:00Z'))

    await runBudgetAlert(t.db, { now: NOW })

    const rows = await t.client<{ subject: string; body: { capUsd: number } }[]>`
      SELECT subject, body::jsonb AS body FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid
         AND category = 'over-budget'
    `
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0]!.body.capUsd).toBe(100)
  })
})

