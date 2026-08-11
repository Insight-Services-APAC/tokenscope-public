// @vitest-environment node
/*
 * runHeartbeatCoverage — quarantined-spend detector integration test
 * (MCP client backbone §"Heartbeat-coverage / quarantined spend").
 *
 * Real testcontainers Postgres (per AGENTS.md §"Never mock Drizzle"). The check is
 * pure SQL: per-session [min,max] ts_event vs the instance's authenticated-live
 * window [ts_start, last_bearer_at + grace], with a historical-data guard
 * (last_bearer_at IS NOT NULL).
 *
 * Covers:
 *   1. covered session (heartbeat spans the event window) → NOT quarantined.
 *   2. uncovered session (events past last_bearer_at + grace) → QUARANTINED, and
 *      the audit event is written, with no auto-revoke side effect.
 *   3. historical guard: an instance with last_bearer_at IS NULL → NOT quarantined
 *      (pre-rollout / never-heartbeated spend is never flagged retroactively).
 *   4. grace: a session whose last event lands just inside the grace tail → covered.
 *   5. auto-resolve: a session that was quarantined and is now covered → resolved.
 *   6. the read query (getMyQuarantinedSpend) returns ONLY the caller's open rows.
 *   7. idempotent: a second run does not duplicate the quarantine row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runHeartbeatCoverage } from '../../../server/workers/heartbeat-coverage'
import { getMyQuarantinedSpend } from '../../../server/utils/me-queries'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let buId: string
let rateCardId: string
let rateCardVersion: number

const NOW = new Date('2026-06-07T12:00:00Z')
const GRACE = 35
const HOUR = 60 * 60 * 1000

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms)
}

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db.insert(schema.region).values({ code: 'hb', displayName: 'Heartbeat Region' }).returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'hb.svc', code: 'hb-svc', displayName: 'HB Services', unitType: 'bu', isCostOwningUnit: true })
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

async function createInstance(
  teammateId: string,
  opts: { tsStart: Date; lastBearerAt: Date | null },
): Promise<string> {
  const instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: `oid-${instanceId}`,
    teammateId,
    rawProjectCode: 'HB-PROJ',
    projectCodeHash: `h-${instanceId.slice(0, 8)}`,
    tool: 'claude-code',
    sessionTokenHash: `tok-${instanceId}`,
    tsStart: opts.tsStart,
    lastBearerAt: opts.lastBearerAt,
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
  })
  return instanceId
}

/** Insert one attribution_record event for (instance, conversation) at ts. */
async function addEvent(
  instanceId: string,
  teammateId: string,
  conversationId: string,
  ts: Date,
  costUsd = '1.000000',
  tool = 'claude-code',
): Promise<void> {
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    claudeSessionId: conversationId,
    teammateId,
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
    tool,
    model: 'claude-opus-4-1',
    tokenType: 'output',
    tokens: 1000n,
    costUsd,
    rateCardId,
    rateCardVersion,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: ts,
  })
}

async function quarantineRows(conversationId: string, openOnly = false): Promise<number> {
  const rows = await t.client<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM session_quarantine
     WHERE conversation_id = ${conversationId}
       ${openOnly ? t.client`AND resolved_at IS NULL` : t.client``}
  `
  return Number(rows[0]!.c)
}

describe('runHeartbeatCoverage', () => {
  it('does NOT quarantine a session whose heartbeat spans its event window', async () => {
    const teammateId = await createTeammate('covered')
    // Instance enrolled 3h ago, last heartbeat 30min ago. Session events between.
    const instanceId = await createInstance(teammateId, { tsStart: ago(3 * HOUR), lastBearerAt: ago(30 * 60_000) })
    const conv = `conv-covered-${randomUUID()}`
    await addEvent(instanceId, teammateId, conv, ago(2 * HOUR))
    await addEvent(instanceId, teammateId, conv, ago(1 * HOUR))

    const res = await runHeartbeatCoverage(t.db, { now: NOW, graceMinutes: GRACE })
    expect(res.sessionsScanned).toBeGreaterThanOrEqual(1)
    expect(await quarantineRows(conv)).toBe(0)
  })

  it('QUARANTINES a session whose events fall outside the heartbeat window + audits, no auto-revoke', async () => {
    const teammateId = await createTeammate('spoofed')
    // Heartbeat is OLD (3h ago); the session has events 30min ago — well past
    // last_bearer_at + 35min grace. This is the cross-instance-spoof shape.
    const instanceId = await createInstance(teammateId, { tsStart: ago(5 * HOUR), lastBearerAt: ago(3 * HOUR) })
    const conv = `conv-spoof-${randomUUID()}`
    await addEvent(instanceId, teammateId, conv, ago(40 * 60_000))
    await addEvent(instanceId, teammateId, conv, ago(30 * 60_000), '2.500000')

    const res = await runHeartbeatCoverage(t.db, { now: NOW, graceMinutes: GRACE })
    expect(res.quarantined).toBeGreaterThanOrEqual(1)
    expect(await quarantineRows(conv, true)).toBe(1)

    // Row carries the why (window + spend).
    const rows = await t.client<{ reason: string; cost_usd: string; instance_id: string }[]>`
      SELECT reason, cost_usd::text AS cost_usd, instance_id::text AS instance_id
        FROM session_quarantine WHERE conversation_id = ${conv}`
    expect(rows[0]!.reason).toBe('no-covering-heartbeat')
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(3.5, 4)
    expect(rows[0]!.instance_id).toBe(instanceId)

    // Audit event written — informational detection, not enforcement.
    const audit = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM audit_event
       WHERE event_type = 'spend-quarantined' AND subject_id = ${teammateId}::uuid`
    expect(Number(audit[0]!.c)).toBeGreaterThanOrEqual(1)

    // NO auto-revoke: the instance is untouched (ts_actual_end still NULL).
    const inst = await t.client<{ ts_actual_end: string | null }[]>`
      SELECT ts_actual_end FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
    expect(inst[0]!.ts_actual_end).toBeNull()
  })

  it('NEVER resolves a dev-confirmed FORGERY row (shared unique key, different lane)', async () => {
    // session_quarantine has ONE unique key (conversation_id, instance_id) shared
    // between this worker's informational 'no-covering-heartbeat' rows and the
    // dev-confirmed 'api-uncorroborated' forgery rows written by
    // /me/over-emission/resolve — the rows that keep forged spend OUT of
    // v_complete_usage. Before the reason guard, one COVERED tick silently
    // resolved the forgery, re-admitting that spend to every §A surface (and,
    // since budget-alert/velocity-watch now read the view, to a PM's page).
    const teammateId = await createTeammate('forgery-victim')
    const instanceId = await createInstance(teammateId, { tsStart: ago(3 * HOUR), lastBearerAt: ago(60_000) })
    const conv = `conv-forgery-${randomUUID()}`
    // A session that IS covered (events well inside the heartbeat window).
    await addEvent(instanceId, teammateId, conv, ago(30 * 60_000))

    // The dev confirmed this conversation is a forgery.
    await t.client.unsafe(`
      INSERT INTO session_quarantine
        (conversation_id, instance_id, teammate_id, region_id, org_unit_id,
         session_ts_start, session_ts_end, instance_ts_start, last_bearer_at,
         cost_usd, tokens, reason, detected_at, updated_at, resolved_at)
      VALUES
        ('${conv}', '${instanceId}', '${teammateId}', '${regionId}', '${buId}',
         NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes',
         NOW() - INTERVAL '3 hours', NOW(),
         99.000000, 0, 'api-uncorroborated', NOW(), NOW(), NULL)
    `)

    await runHeartbeatCoverage(t.db, { now: NOW, graceMinutes: GRACE })

    const rows = await t.client<{ reason: string; resolved_at: string | null; cost_usd: string }[]>`
      SELECT reason, resolved_at, cost_usd::text AS cost_usd
        FROM session_quarantine WHERE conversation_id = ${conv}`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reason).toBe('api-uncorroborated') // lane untouched
    expect(rows[0]!.resolved_at).toBeNull() // STILL open — the forgery stands
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(99, 4) // cost not overwritten
  })

  it('NEVER quarantines a copilot-cli session, even in the exact spoof shape', async () => {
    // copilot-cli mints /bearer reactively (~hourly), so last_bearer_at lags a
    // long session and the Claude-tuned grace would false-quarantine it. This
    // worker is claude-only; Copilot spoof-defense is §A reconciliation. The
    // fixture is byte-for-byte the QUARANTINES case above but tool='copilot-cli'.
    const teammateId = await createTeammate('copilot-dev')
    const instanceId = await createInstance(teammateId, { tsStart: ago(5 * HOUR), lastBearerAt: ago(3 * HOUR) })
    const conv = `conv-copilot-${randomUUID()}`
    await addEvent(instanceId, teammateId, conv, ago(40 * 60_000), '1.000000', 'copilot-cli')
    await addEvent(instanceId, teammateId, conv, ago(30 * 60_000), '2.500000', 'copilot-cli')

    await runHeartbeatCoverage(t.db, { now: NOW, graceMinutes: GRACE })
    // Assert on THIS conversation (the run-global count is polluted by sibling
    // tests' claude rows in the shared lookback window). A claude row in this
    // exact shape WOULD be quarantined (the test above proves it); the only
    // difference here is tool='copilot-cli', so a 0 is the tool filter working.
    expect(await quarantineRows(conv, false)).toBe(0)
  })

  it('historical guard: an instance with last_bearer_at IS NULL is never quarantined', async () => {
    const teammateId = await createTeammate('historical')
    // Pre-rollout instance: never minted a /bearer → last_bearer_at NULL. Its
    // spend must NOT be flagged retroactively even though there's no heartbeat.
    const instanceId = await createInstance(teammateId, { tsStart: ago(10 * HOUR), lastBearerAt: null })
    const conv = `conv-hist-${randomUUID()}`
    await addEvent(instanceId, teammateId, conv, ago(2 * HOUR))

    await runHeartbeatCoverage(t.db, { now: NOW, graceMinutes: GRACE })
    expect(await quarantineRows(conv)).toBe(0)
  })

  it('grace: a session whose last event is within the grace tail of the heartbeat is covered', async () => {
    const teammateId = await createTeammate('grace')
    // Last heartbeat 1h ago; the session's last event is 40min ago — that's 20min
    // AFTER the heartbeat, INSIDE the 35min grace. Must be covered (normal refresh
    // cadence, not a spoof).
    const instanceId = await createInstance(teammateId, { tsStart: ago(3 * HOUR), lastBearerAt: ago(1 * HOUR) })
    const conv = `conv-grace-${randomUUID()}`
    await addEvent(instanceId, teammateId, conv, ago(50 * 60_000))
    await addEvent(instanceId, teammateId, conv, ago(40 * 60_000))

    await runHeartbeatCoverage(t.db, { now: NOW, graceMinutes: GRACE })
    expect(await quarantineRows(conv)).toBe(0)
  })

  it('auto-resolves a quarantined session once a later heartbeat covers it', async () => {
    const teammateId = await createTeammate('resolve')
    const instanceId = await createInstance(teammateId, { tsStart: ago(5 * HOUR), lastBearerAt: ago(3 * HOUR) })
    const conv = `conv-resolve-${randomUUID()}`
    await addEvent(instanceId, teammateId, conv, ago(40 * 60_000))

    // First run: uncovered → quarantined.
    await runHeartbeatCoverage(t.db, { now: NOW, graceMinutes: GRACE })
    expect(await quarantineRows(conv, true)).toBe(1)

    // The owner's client mints a fresh /bearer → last_bearer_at advances to now,
    // which now spans the session window.
    await t.client`UPDATE instance_attestation SET last_bearer_at = ${NOW.toISOString()}::timestamptz WHERE instance_id = ${instanceId}::uuid`

    const res = await runHeartbeatCoverage(t.db, { now: NOW, graceMinutes: GRACE })
    expect(res.resolved).toBeGreaterThanOrEqual(1)
    expect(await quarantineRows(conv, true)).toBe(0) // no open rows
    expect(await quarantineRows(conv)).toBe(1) // cleared, not deleted (audit trail)
  })

  it('is idempotent: a second run does not duplicate the quarantine row', async () => {
    const teammateId = await createTeammate('idem')
    const instanceId = await createInstance(teammateId, { tsStart: ago(5 * HOUR), lastBearerAt: ago(3 * HOUR) })
    const conv = `conv-idem-${randomUUID()}`
    await addEvent(instanceId, teammateId, conv, ago(30 * 60_000))

    await runHeartbeatCoverage(t.db, { now: NOW, graceMinutes: GRACE })
    await runHeartbeatCoverage(t.db, { now: NOW, graceMinutes: GRACE })
    expect(await quarantineRows(conv)).toBe(1)
  })
})

describe('getMyQuarantinedSpend — teammate-scoped read', () => {
  it('returns ONLY the caller`s own open quarantined sessions', async () => {
    const me = await createTeammate('reader-me')
    const other = await createTeammate('reader-other')

    const myInst = await createInstance(me, { tsStart: ago(5 * HOUR), lastBearerAt: ago(3 * HOUR) })
    const otherInst = await createInstance(other, { tsStart: ago(5 * HOUR), lastBearerAt: ago(3 * HOUR) })
    const myConv = `conv-me-${randomUUID()}`
    const otherConv = `conv-other-${randomUUID()}`
    await addEvent(myInst, me, myConv, ago(30 * 60_000), '4.000000')
    await addEvent(otherInst, other, otherConv, ago(30 * 60_000), '9.000000')

    await runHeartbeatCoverage(t.db, { now: NOW, graceMinutes: GRACE })

    const mine = await getMyQuarantinedSpend(t.db, me)
    const ids = mine.map((s) => s.session_id)
    expect(ids).toContain(myConv)
    expect(ids).not.toContain(otherConv)
    const myRow = mine.find((s) => s.session_id === myConv)!
    expect(myRow.instance_id).toBe(myInst)
    expect(myRow.cost_usd).toBe('4.00')
    expect(myRow.reason).toBe('no-covering-heartbeat')

    // The other teammate sees only theirs.
    const theirs = await getMyQuarantinedSpend(t.db, other)
    expect(theirs.map((s) => s.session_id)).toEqual(expect.arrayContaining([otherConv]))
    expect(theirs.map((s) => s.session_id)).not.toContain(myConv)
  })
})
