// @vitest-environment node
/*
 * runReconciliationGap — reconciliation-gap alert producer integration test
 * (ADR-0005 decision 4 — the first-class safety net the P2 detection leans on).
 *
 * Real testcontainers Postgres (per AGENTS.md §"Never mock Drizzle"): the
 * detection is pure SQL (actual_spend vs reconcilable attribution_record) + a
 * dual percentage/dollar threshold.
 *
 * Covers:
 *   1. gap over BOTH bars (pct + $) → ALERTED (attention, routed to the teammate).
 *   2. gap under the pct bar → NO alert.
 *   3. gap over the pct bar but under the $ floor → NO alert (tiny month).
 *   4. telemetry-only / backfill attribution does NOT close the gap (excluded).
 *   5. dedup: a second run does not duplicate the alert.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReconciliationGap } from '../../../server/workers/reconciliation-gap'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let buId: string
let rateCardId: string
let rateCardVersion: number

const NOW = new Date('2026-05-15T12:00:00Z')
const GAP_PCT = 0.2
const GAP_USD = 50

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'rg', displayName: 'Recon-Gap Region' })
    .returning()
  regionId = region!.id

  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'rg.svc',
      code: 'rg-svc',
      displayName: 'RG Services',
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
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function createTeammate(prefix: string): Promise<string> {
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-${prefix}-${randomUUID().slice(0, 8)}`,
      email: `${prefix}.${randomUUID().slice(0, 8)}@example.com`,
      regionId,
      orgUnitId: buId,
    })
    .returning({ id: schema.teammate.id })
  return tm!.id
}

async function addActual(teammateId: string, costUsd: string): Promise<void> {
  await t.db.insert(schema.actualSpend).values({
    teammateId,
    date: '2026-05-10',
    tool: 'claude-code',
    inputTokens: 1000n,
    outputTokens: 1000n,
    costUsd,
    source: 'anthropic-analytics-api',
  })
}

async function addAttribution(
  teammateId: string,
  costUsd: string,
  opts?: { costBasis?: string; fidelityTier?: string; identityState?: string },
): Promise<void> {
  const instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: `oid-${instanceId}`,
    teammateId,
    rawProjectCode: 'RG-PROJ',
    projectCodeHash: `h-${instanceId.slice(0, 8)}`,
    tool: 'claude-code',
    sessionTokenHash: `tok-${instanceId}`,
    tsStart: new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000),
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
  })
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    teammateId,
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
    fidelityTier: opts?.fidelityTier ?? 'tier-1',
    costBasis: opts?.costBasis ?? 'estimated',
    identityState: opts?.identityState,
    tsEvent: new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000),
  })
}

async function openItems(teammateId: string): Promise<number> {
  const rows = await t.client<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM inbox_item
     WHERE recipient_teammate_id = ${teammateId}::uuid
       AND category = 'reconciliation-gap'
  `
  return Number(rows[0]!.c)
}

describe('runReconciliationGap', () => {
  it('alerts when the gap exceeds both the pct and the $ bar', async () => {
    const teammateId = await createTeammate('gap-big')
    await addActual(teammateId, '200.00')
    await addAttribution(teammateId, '100.00') // gap $100 (50%) — both bars exceeded

    const result = await runReconciliationGap(t.db, { now: NOW, gapPct: GAP_PCT, gapUsd: GAP_USD })
    expect(result.gapsAlerted).toBeGreaterThanOrEqual(1)

    const rows = await t.client<
      {
        recipient_teammate_id: string
        category: string
        severity: string
        body: { gap_usd: number; gap_pct: number; anthropic_actual_usd: number }
      }[]
    >`
      SELECT recipient_teammate_id::text AS recipient_teammate_id, category, severity, body::jsonb AS body
        FROM inbox_item
       WHERE recipient_teammate_id = ${teammateId}::uuid AND category = 'reconciliation-gap'
    `
    expect(rows.length).toBe(1)
    const item = rows[0]!
    expect(item.recipient_teammate_id).toBe(teammateId)
    expect(item.severity).toBe('attention')
    expect(item.body.gap_usd).toBeCloseTo(100, 2)
    expect(item.body.gap_pct).toBeCloseTo(0.5, 4)
  })

  it('does NOT alert when the gap is under the pct bar', async () => {
    const teammateId = await createTeammate('gap-small-pct')
    await addActual(teammateId, '1000.00')
    await addAttribution(teammateId, '950.00') // gap $50 = 5% < 20% bar

    await runReconciliationGap(t.db, { now: NOW, gapPct: GAP_PCT, gapUsd: GAP_USD })
    expect(await openItems(teammateId)).toBe(0)
  })

  it('does NOT alert when the gap is over the pct bar but under the $ floor', async () => {
    const teammateId = await createTeammate('gap-tiny-dollars')
    await addActual(teammateId, '40.00')
    await addAttribution(teammateId, '5.00') // gap $35 = 87.5% but < $50 floor

    await runReconciliationGap(t.db, { now: NOW, gapPct: GAP_PCT, gapUsd: GAP_USD })
    expect(await openItems(teammateId)).toBe(0)
  })

  it('does NOT count telemetry-only / backfill attribution toward closing the gap', async () => {
    const teammateId = await createTeammate('gap-backfill')
    await addActual(teammateId, '200.00')
    // All attribution is telemetry-only (e.g. backfilled) → excluded from the
    // reconcilable lane, so the gap is the FULL $200 → alert fires.
    await addAttribution(teammateId, '180.00', { costBasis: 'telemetry-only', fidelityTier: 'tier-2' })

    const result = await runReconciliationGap(t.db, { now: NOW, gapPct: GAP_PCT, gapUsd: GAP_USD })
    expect(result.gapsAlerted).toBeGreaterThanOrEqual(1)
    const rows = await t.client<{ body: { gap_usd: number } }[]>`
      SELECT body::jsonb AS body FROM inbox_item
       WHERE recipient_teammate_id = ${teammateId}::uuid AND category = 'reconciliation-gap'
    `
    expect(rows[0]!.body.gap_usd).toBeCloseTo(200, 2)
  })

  it('does NOT let PROVISIONAL attribution close the gap (excluded from the lane)', async () => {
    // Emit-on-install provisional usage isn't trusted attribution, so it must
    // not reassure the safety net that the spend is accounted for. actual $200,
    // a provisional $190 attribution -> the lane sees $0 -> full $200 gap alerts.
    const teammateId = await createTeammate('gap-provisional')
    await addActual(teammateId, '200.00')
    await addAttribution(teammateId, '190.00', { identityState: 'provisional' })

    const result = await runReconciliationGap(t.db, { now: NOW, gapPct: GAP_PCT, gapUsd: GAP_USD })
    expect(result.gapsAlerted).toBeGreaterThanOrEqual(1)
    const rows = await t.client<{ body: { gap_usd: number } }[]>`
      SELECT body::jsonb AS body FROM inbox_item
       WHERE recipient_teammate_id = ${teammateId}::uuid AND category = 'reconciliation-gap'
    `
    expect(rows[0]!.body.gap_usd).toBeCloseTo(200, 2) // provisional $190 NOT credited
  })

  it('counts CONFIRMED attribution toward the lane (gap closed -> no alert)', async () => {
    // The same shape, but confirmed identity counts -> gap is only $10 (<bars).
    const teammateId = await createTeammate('gap-confirmed')
    await addActual(teammateId, '200.00')
    await addAttribution(teammateId, '190.00', { identityState: 'confirmed' })

    await runReconciliationGap(t.db, { now: NOW, gapPct: GAP_PCT, gapUsd: GAP_USD })
    expect(await openItems(teammateId)).toBe(0)
  })

  it('is idempotent: a second run does not duplicate the alert', async () => {
    const teammateId = await createTeammate('gap-idem')
    await addActual(teammateId, '300.00')
    await addAttribution(teammateId, '100.00')

    const first = await runReconciliationGap(t.db, { now: NOW, gapPct: GAP_PCT, gapUsd: GAP_USD })
    expect(first.gapsAlerted).toBeGreaterThanOrEqual(1)
    expect(await openItems(teammateId)).toBe(1)

    const second = await runReconciliationGap(t.db, { now: NOW, gapPct: GAP_PCT, gapUsd: GAP_USD })
    expect(await openItems(teammateId)).toBe(1)
    expect(second.skippedExisting).toBeGreaterThanOrEqual(1)
  })
})
