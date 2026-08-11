// @vitest-environment node
/*
 * T8 (developer-pages W0c) — the session-economics bounded ledger read
 * (server/usage/session-economics.ts) against a real Postgres.
 *
 * Pins, per D10:
 *   - seeded conversations → sessions / median / p90 / top-3 share correct,
 *     grouped on the shared conversation key (claude_session_id, with the
 *     legacy instance_id fallback arm);
 *   - provider-day fill rows in the same window do NOT enter (arm discipline:
 *     the ledger IS arm 1 — a provider-recorded day is not a conversation);
 *   - the window bounds BOTH sides on ts_event;
 *   - teammate-scoped: another teammate's conversations never leak;
 *   - `arm: 'otel'` is disclosed on the result;
 *   - vocabulary discipline (T9's module half): the Claude shape carries NO
 *     LOC figures — no fake symmetry with the Copilot engagement column.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { sessionEconomics } from '../../../server/usage/session-economics'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let teammateId = ''
let otherId = ''
let instanceId = ''
let legacyInstanceId = ''

/** June 2026, whole-month half-open window. */
const WINDOW = { startIso: '2026-06-01T00:00:00.000Z', endIso: '2026-07-01T00:00:00.000Z' }
const IN_WINDOW = new Date('2026-06-15T12:00:00.000Z')

/** One ledger event on a conversation. Legacy rows pass conv=null (instance-keyed). */
async function otelEvent(
  tmId: string,
  conv: string | null,
  costUsd: string,
  opts: { tsEvent?: Date; onInstance?: string } = {},
): Promise<void> {
  await t.db.insert(schema.attributionRecord).values({
    instanceId: opts.onInstance ?? instanceId,
    claudeSessionId: conv,
    teammateId: tmId,
    regionId,
    orgUnitId,
    tool: 'claude-code',
    model: 'claude-sonnet-4-5',
    tokenType: 'output',
    tokens: 1000n,
    costUsd,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: opts.tsEvent ?? IN_WINDOW,
    sourceRunId: randomUUID(),
  })
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'se', displayName: 'SE' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'se', code: 'se-bu', displayName: 'SE', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-se', email: 'se@x.test', regionId, orgUnitId })
    .returning()
  teammateId = tm!.id
  const [other] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-se-other', email: 'se-other@x.test', regionId, orgUnitId })
    .returning()
  otherId = other!.id
  instanceId = randomUUID()
  legacyInstanceId = randomUUID()
  for (const [iid, oid] of [
    [instanceId, 'oid-se'],
    [legacyInstanceId, 'oid-se'],
  ] as const) {
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: iid,
      principalOid: oid,
      teammateId,
      projectCodeHash: 'h-se',
      rawProjectCode: 'SE',
      tool: 'claude-code',
      tsStart: new Date('2026-06-01T00:00:00.000Z'),
      regionId,
      orgUnitId,
    })
  }
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM attribution_record WHERE teammate_id IN (${teammateId}::uuid, ${otherId}::uuid)`
  await t.client`DELETE FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM reconciliation_record WHERE teammate_id = ${teammateId}::uuid`
})

describe('sessionEconomics — T8', () => {
  it('computes sessions / median / p90 / top-3 share over per-conversation totals', async () => {
    // Five conversations totalling 10, 20, 30, 40, 100 — conv-a summed from
    // two rows so the per-conversation GROUP BY is exercised.
    await otelEvent(teammateId, 'conv-a', '6.00')
    await otelEvent(teammateId, 'conv-a', '4.00')
    await otelEvent(teammateId, 'conv-b', '20.00')
    await otelEvent(teammateId, 'conv-c', '30.00')
    await otelEvent(teammateId, 'conv-d', '40.00')
    await otelEvent(teammateId, 'conv-e', '100.00')

    const out = await sessionEconomics(t.db, teammateId, WINDOW)
    expect(out.sessions).toBe(5)
    expect(out.medianUsd).toBeCloseTo(30, 6)
    // percentile_cont(0.9) over [10,20,30,40,100]: 40 + 0.6 × 60 = 76.
    expect(out.p90Usd).toBeCloseTo(76, 6)
    // top-3 = 100 + 40 + 30 = 170 of 200 → 85%.
    expect(out.topShare).toEqual({ n: 3, pct: 85 })
    expect(out.arm).toBe('otel')
  })

  it('groups legacy rows (claude_session_id NULL) by instance — the COALESCE arm', async () => {
    await otelEvent(teammateId, 'conv-x', '10.00')
    // Two legacy rows on ONE instance = ONE conversation.
    await otelEvent(teammateId, null, '5.00', { onInstance: legacyInstanceId })
    await otelEvent(teammateId, null, '15.00', { onInstance: legacyInstanceId })

    const out = await sessionEconomics(t.db, teammateId, WINDOW)
    expect(out.sessions).toBe(2)
    expect(out.medianUsd).toBeCloseTo(15, 6) // [10, 20]
  })

  it('provider-day fill rows in the same window do NOT enter (arm discipline)', async () => {
    await otelEvent(teammateId, 'conv-only', '10.00')
    const before = await sessionEconomics(t.db, teammateId, WINDOW)

    // A provider-recorded fill row AND its Copilot ledger row, same window —
    // neither is a conversation and neither may move a single figure.
    await t.db.insert(schema.unaccountedUsage).values({
      teammateId,
      regionId,
      orgUnitId,
      day: '2026-06-15',
      tool: 'copilot-cli',
      costUsd: '500.000000',
      tokens: 0n,
      source: 'api-reconciled',
    })
    await t.db.insert(schema.reconciliationRecord).values({
      teammateId,
      provider: 'github',
      enterpriseRef: 'ent-se',
      periodDate: '2026-06-15',
      category: 'copilot_interactive',
      scope: 'teammate',
      regionId,
      orgUnitId,
      actualUsd: '500.00',
      otelAttributedUsd: '0',
      deltaUsd: '500.00',
      spendClass: 'indicative',
      indicativeReason: 'copilot-pre-billing',
      disposition: 'untagged',
      status: 'proposed',
    })

    const after = await sessionEconomics(t.db, teammateId, WINDOW)
    expect(after).toEqual(before)
    expect(after.sessions).toBe(1)
    expect(after.medianUsd).toBeCloseTo(10, 6)
  })

  it('bounds the window on BOTH sides of ts_event', async () => {
    await otelEvent(teammateId, 'conv-before', '100.00', {
      tsEvent: new Date('2026-05-31T23:59:59.000Z'),
    })
    await otelEvent(teammateId, 'conv-at-end', '100.00', {
      tsEvent: new Date('2026-07-01T00:00:00.000Z'), // exclusive upper bound
    })
    await otelEvent(teammateId, 'conv-in', '7.00')

    const out = await sessionEconomics(t.db, teammateId, WINDOW)
    expect(out.sessions).toBe(1)
    expect(out.medianUsd).toBeCloseTo(7, 6)
    expect(out.topShare.pct).toBe(100)
  })

  it('is teammate-scoped and returns the empty shape (not zeros-as-data) when there are no conversations', async () => {
    await otelEvent(otherId, 'conv-other', '50.00')
    const out = await sessionEconomics(t.db, teammateId, WINDOW)
    expect(out).toEqual({
      sessions: 0,
      medianUsd: null,
      p90Usd: null,
      topShare: { n: 3, pct: null },
      arm: 'otel',
    })
  })

  it('T9 (module half): the Claude vocabulary carries NO LOC figures — no fake symmetry', async () => {
    await otelEvent(teammateId, 'conv-v', '1.00')
    const out = await sessionEconomics(t.db, teammateId, WINDOW)
    expect(Object.keys(out)).toEqual(['sessions', 'medianUsd', 'p90Usd', 'topShare', 'arm'])
    for (const k of Object.keys(out)) {
      expect(k.toLowerCase()).not.toContain('loc')
    }
  })
})
