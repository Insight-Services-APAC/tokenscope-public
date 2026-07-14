// @vitest-environment node
/*
 * runWentSilent — RE-ANCHORED on the bearer-auth-failed signal (ADR-0005 d4).
 *
 * The detector now alerts on a LIVE instance whose emit credential is being
 * rejected at /bearer (an open `bearer-auth-failed` instance_attestation_health
 * row) — the real disaster — not on telemetry absence (which is indistinguishable
 * from idle). Covers: flag-on-failure, lifecycle exclusions, per-episode dedup
 * (resolve doesn't re-arm), and auto-resolve on recovery.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runWentSilent } from '../../../server/workers/went-silent'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let buId: string

const NOW = new Date('2026-05-15T12:00:00Z')

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.db.insert(schema.region).values({ code: 'ws', displayName: 'WS' }).returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ws.svc', code: 'ws-svc', displayName: 'WS Services', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  buId = bu!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function createTeammate(prefix: string, revokedAt?: Date): Promise<string> {
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-${prefix}-${randomUUID().slice(0, 8)}`,
      email: `${prefix}.${randomUUID().slice(0, 8)}@example.com`,
      regionId,
      orgUnitId: buId,
      revokedAt: revokedAt ?? null,
    })
    .returning({ id: schema.teammate.id })
  return tm!.id
}

async function createInstance(teammateId: string, opts?: { enrolDaysAgo?: number; endedAt?: Date }): Promise<string> {
  const instanceId = randomUUID()
  const tsStart = new Date(NOW.getTime() - (opts?.enrolDaysAgo ?? 2) * 24 * 60 * 60 * 1000)
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: `oid-${instanceId}`,
    teammateId,
    rawProjectCode: 'WS-PROJ',
    projectCodeHash: `h-${instanceId.slice(0, 8)}`,
    tool: 'claude-code',
    sessionTokenHash: `tok-${instanceId}`,
    tsStart,
    tsActualEnd: opts?.endedAt ?? null,
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
  })
  return instanceId
}

async function failBearer(instanceId: string, detectedAt: Date, resolvedAt?: Date): Promise<void> {
  await t.db.insert(schema.instanceAttestationHealth).values({
    instanceId,
    status: 'bearer-auth-failed',
    detectedAt,
    resolvedAt: resolvedAt ?? null,
    payload: { detectedBy: 'test' },
  })
}

function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000)
}

async function itemsForInstance(instanceId: string, openOnly = false): Promise<number> {
  const rows = await t.client<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM inbox_item
     WHERE related_entity_kind = 'instance' AND related_entity_id = ${instanceId}::uuid
       AND category = 'went-silent'
       ${openOnly ? t.client`AND ack_state IN ('unread','read','acknowledged')` : t.client``}
  `
  return Number(rows[0]!.c)
}

describe('runWentSilent — bearer-auth-failed', () => {
  it('alerts the owning teammate for a live instance with an open bearer-auth-failed signal', async () => {
    const teammateId = await createTeammate('failing')
    const instanceId = await createInstance(teammateId)
    await failBearer(instanceId, hoursAgo(2))

    const res = await runWentSilent(t.db, { now: NOW })
    expect(res.alertsDispatched).toBeGreaterThanOrEqual(1)

    const rows = await t.client<{ recipient_teammate_id: string; severity: string; body: { reason: string; hint: string } }[]>`
      SELECT recipient_teammate_id::text AS recipient_teammate_id, severity, body::jsonb AS body
        FROM inbox_item
       WHERE related_entity_id = ${instanceId}::uuid AND category = 'went-silent'`
    expect(rows.length).toBe(1)
    expect(rows[0]!.recipient_teammate_id).toBe(teammateId)
    expect(rows[0]!.severity).toBe('attention')
    expect(rows[0]!.body.reason).toBe('bearer-auth-failed')
    expect(rows[0]!.body.hint).toContain('tokenscope-setup')
  })

  it('does NOT alert when the credential is healthy (no open bearer-auth-failed row)', async () => {
    const teammateId = await createTeammate('healthy')
    const instanceId = await createInstance(teammateId)
    // A RESOLVED failure (credential recovered) must not alert.
    await failBearer(instanceId, hoursAgo(5), hoursAgo(4))

    await runWentSilent(t.db, { now: NOW })
    expect(await itemsForInstance(instanceId)).toBe(0)
  })

  it('does NOT alert an ENDED instance, or one whose teammate was E2-revoked', async () => {
    const ended = await createInstance(await createTeammate('ended'), { endedAt: hoursAgo(1) })
    await failBearer(ended, hoursAgo(2))

    const revTeammate = await createTeammate('revoked')
    const revInstance = await createInstance(revTeammate, { enrolDaysAgo: 5 })
    await t.client`UPDATE teammate SET revoked_at = ${hoursAgo(72).toISOString()}::timestamptz WHERE id = ${revTeammate}::uuid`
    await failBearer(revInstance, hoursAgo(2))

    await runWentSilent(t.db, { now: NOW })
    expect(await itemsForInstance(ended)).toBe(0)
    expect(await itemsForInstance(revInstance)).toBe(0)
  })

  it('per-episode dedup: resolving does NOT re-arm while the credential is still failing', async () => {
    const teammateId = await createTeammate('renag')
    const instanceId = await createInstance(teammateId)
    await failBearer(instanceId, hoursAgo(3))

    await runWentSilent(t.db, { now: NOW })
    expect(await itemsForInstance(instanceId, true)).toBe(1)
    await t.client`UPDATE inbox_item SET ack_state='resolved' WHERE related_entity_id = ${instanceId}::uuid AND category='went-silent'`

    const second = await runWentSilent(t.db, { now: NOW })
    expect(second.alertsDispatched).toBe(0)
    expect(second.skippedExisting).toBeGreaterThanOrEqual(1)
    expect(await itemsForInstance(instanceId)).toBe(1) // still just the resolved one
  })

  it('auto-resolves an open alert when the credential recovers (incl. a stale telemetry-absence alert)', async () => {
    const teammateId = await createTeammate('recovered')
    const instanceId = await createInstance(teammateId)
    // An OPEN went-silent alert exists, but the instance has NO open bearer
    // failure (recovered, or a leftover from the retired heuristic).
    await t.db.insert(schema.inboxItem).values({
      recipientTeammateId: teammateId, category: 'went-silent', severity: 'attention',
      subject: 'stale', body: {}, relatedEntityKind: 'instance', relatedEntityId: instanceId,
    })
    const res = await runWentSilent(t.db, { now: NOW })
    expect(res.autoResolved).toBeGreaterThanOrEqual(1)
    expect(await itemsForInstance(instanceId, true)).toBe(0)
  })
})
