// @vitest-environment node
/*
 * runReadPathHealth — the read-path outage alerter (the gap that let the 5.5-day
 * silent OTel-read outage go unnoticed: went-silent only catches WRITE/emit
 * silence, not a dead READER).
 *
 * The pure trigger-decision logic is exhaustively covered in
 * tests/unit/workers/read-path-health-decision.test.ts. THIS file pins the
 * DB-coupled worker behaviour against a real testcontainers Postgres (per
 * AGENTS.md — never mock Drizzle):
 *   - a STALL (last 3 azure-monitor-read runs wrote 0 rows while usage is fresh)
 *     dispatches ONE urgent, admin-routed 'read-path-stale' inbox item;
 *   - it does NOT re-alert on the next tick (idempotency);
 *   - it AUTO-RESOLVES the open alert once the read path recovers;
 *   - a healthy read path (rows landing) never alerts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReadPathHealth } from '../../../server/workers/read-path-health'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let buId: string
let adminId: string

const NOW = new Date('2026-06-20T12:00:00Z')
const MIN = 60 * 1000

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.db.insert(schema.region).values({ code: 'rph', displayName: 'RPH' }).returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'rph.svc', code: 'rph-svc', displayName: 'RPH Services', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  buId = bu!.id
  // A platform-admin so the admin-routed alert has a recipient (dispatchInbox →
  // resolveAdmins(null) → cross-region roles).
  const [admin] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-rph-admin-${randomUUID().slice(0, 8)}`,
      email: `admin.${randomUUID().slice(0, 8)}@example.com`,
      regionId,
      orgUnitId: buId,
      role: 'platform-admin',
      isActive: true,
    })
    .returning({ id: schema.teammate.id })
  adminId = admin!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

// Reset the worker_run ledger + the single emitting instance/usage row between
// scenarios so each test controls the full read-path state.
async function resetLedger(): Promise<void> {
  await t.client`DELETE FROM worker_run WHERE worker_name = 'azure-monitor-read'`
  await t.client`DELETE FROM attribution_record`
  await t.client`DELETE FROM instance_attestation`
  await t.client`DELETE FROM inbox_item WHERE category = 'read-path-stale'`
}

async function insertReaderRun(opts: {
  status?: string
  startedAtMs: number
  rowsAffected?: number | null
  sessionsProcessed?: number
  errors?: number
}): Promise<void> {
  const started = new Date(opts.startedAtMs).toISOString()
  const result = JSON.stringify({
    sessionsProcessed: opts.sessionsProcessed ?? 5,
    attributionRowsWritten: opts.rowsAffected ?? 0,
    errors: opts.errors ?? 0,
  })
  await t.client`
    INSERT INTO worker_run (worker_name, status, started_at, finished_at, rows_affected, result)
    VALUES ('azure-monitor-read', ${opts.status ?? 'success'}, ${started}::timestamptz,
            ${started}::timestamptz, ${opts.rowsAffected ?? null}, ${result}::jsonb)
  `
}

// Seed a fleet instance whose last_bearer_at (the INDEPENDENT emit-auth signal
// the STALL gate reads — see FLEET_EMITTING_FRESH_MS) is `bearerAtMs`. This is
// what "fleet still emitting" is measured on, NOT reader-written attribution.
async function seedFleetEmit(bearerAtMs: number): Promise<void> {
  const instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: `oid-${instanceId}`,
    teammateId: adminId,
    projectCodeHash: `h-${instanceId.slice(0, 8)}`,
    rawProjectCode: 'RPH',
    tool: 'claude-code',
    sessionTokenHash: `tok-${instanceId}`,
    tsStart: new Date(bearerAtMs - MIN),
    lastBearerAt: new Date(bearerAtMs),
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
  })
}

async function openAlerts(): Promise<number> {
  const rows = await t.client<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM inbox_item
     WHERE category = 'read-path-stale' AND ack_state IN ('unread','read','acknowledged')`
  return Number(rows[0]!.c)
}

describe('runReadPathHealth — STALL (reader dead, fleet still emitting)', () => {
  it('dispatches ONE urgent admin alert; then is idempotent; then auto-resolves on recovery', async () => {
    await resetLedger()
    await seedFleetEmit(NOW.getTime() - 5 * MIN) // fleet still minting bearers

    // Last 3 azure-monitor-read runs all wrote 0 rows (scanned sessions, wrote nothing).
    await insertReaderRun({ startedAtMs: NOW.getTime() - 2 * MIN, rowsAffected: 0 })
    await insertReaderRun({ startedAtMs: NOW.getTime() - 17 * MIN, rowsAffected: 0 })
    await insertReaderRun({ startedAtMs: NOW.getTime() - 32 * MIN, rowsAffected: 0 })

    const first = await runReadPathHealth(t.db, { now: NOW })
    expect(first.reason).toBe('stall')
    expect(first.alertsDispatched).toBe(1)

    const rows = await t.client<{ recipient_teammate_id: string; severity: string; body: { reason: string; worker: string } }[]>`
      SELECT recipient_teammate_id::text AS recipient_teammate_id, severity, body::jsonb AS body
        FROM inbox_item WHERE category = 'read-path-stale'`
    expect(rows.length).toBe(1)
    expect(rows[0]!.recipient_teammate_id).toBe(adminId)
    expect(rows[0]!.severity).toBe('urgent')
    expect(rows[0]!.body.reason).toBe('stall')
    expect(rows[0]!.body.worker).toBe('azure-monitor-read')

    // Idempotency: the next tick (still stalled) does NOT raise a second alert.
    const second = await runReadPathHealth(t.db, { now: NOW })
    expect(second.alertsDispatched).toBe(0)
    expect(second.skippedExisting).toBe(1)
    expect(await openAlerts()).toBe(1)

    // Recovery: a fresh run writes rows → healthy → the open alert auto-resolves.
    await insertReaderRun({ startedAtMs: NOW.getTime() - 1 * MIN, rowsAffected: 42 })
    const third = await runReadPathHealth(t.db, { now: NOW })
    expect(third.reason).toBeNull()
    expect(third.autoResolved).toBe(1)
    expect(await openAlerts()).toBe(0)
  })

  it('HIGH regression: a SUSTAINED zero-write outage stays alerted and does NOT auto-resolve', async () => {
    // The exact false-recovery bug: the whole ledger is zero-write successes and
    // the OLDEST run is >2h old (so reader-written usage would have aged out under
    // the old ts_event gate). But the fleet is STILL minting bearers, so the
    // bearer-based gate keeps STALL armed — no auto-resolve until rows land.
    await resetLedger()
    await seedFleetEmit(NOW.getTime() - 10 * MIN) // fleet still emitting, mid-outage

    await insertReaderRun({ startedAtMs: NOW.getTime() - 5 * MIN, rowsAffected: 0 })
    await insertReaderRun({ startedAtMs: NOW.getTime() - 20 * MIN, rowsAffected: 0 })
    await insertReaderRun({ startedAtMs: NOW.getTime() - 35 * MIN, rowsAffected: 0 })
    await insertReaderRun({ startedAtMs: NOW.getTime() - 3 * 60 * MIN, rowsAffected: 0 }) // 3h into the outage

    const first = await runReadPathHealth(t.db, { now: NOW })
    expect(first.reason).toBe('stall')
    expect(first.alertsDispatched).toBe(1)
    expect(await openAlerts()).toBe(1)

    // A later tick, STILL mid-outage (fleet still emitting, still all-zero) — the
    // open alert MUST persist. It must NOT auto-resolve while the reader is dead.
    const second = await runReadPathHealth(t.db, { now: NOW })
    expect(second.reason).toBe('stall')
    expect(second.autoResolved).toBe(0)
    expect(second.skippedExisting).toBe(1)
    expect(await openAlerts()).toBe(1)
  })
})

describe('runReadPathHealth — ALL-FAULT', () => {
  it('alerts when the latest run errored on every session it processed', async () => {
    await resetLedger()
    await insertReaderRun({ startedAtMs: NOW.getTime() - 2 * MIN, rowsAffected: 0, sessionsProcessed: 4, errors: 4 })

    const res = await runReadPathHealth(t.db, { now: NOW })
    expect(res.reason).toBe('all-fault')
    expect(res.alertsDispatched).toBe(1)
    expect(await openAlerts()).toBe(1)
  })
})

describe('runReadPathHealth — NO-SUCCESS', () => {
  it('alerts when every recent run failed (no success within 30 min)', async () => {
    await resetLedger()
    await insertReaderRun({ status: 'failure', startedAtMs: NOW.getTime() - 2 * MIN, rowsAffected: null })
    await insertReaderRun({ status: 'failure', startedAtMs: NOW.getTime() - 17 * MIN, rowsAffected: null })

    const res = await runReadPathHealth(t.db, { now: NOW })
    expect(res.reason).toBe('no-success')
    expect(res.alertsDispatched).toBe(1)
  })
})

describe('runReadPathHealth — healthy', () => {
  it('never alerts, and resolves nothing, when the read path is landing rows', async () => {
    await resetLedger()
    await seedFleetEmit(NOW.getTime() - 5 * MIN)
    await insertReaderRun({ startedAtMs: NOW.getTime() - 2 * MIN, rowsAffected: 11 })
    await insertReaderRun({ startedAtMs: NOW.getTime() - 17 * MIN, rowsAffected: 9 })

    const res = await runReadPathHealth(t.db, { now: NOW })
    expect(res.reason).toBeNull()
    expect(res.alertsDispatched).toBe(0)
    expect(res.autoResolved).toBe(0)
    expect(await openAlerts()).toBe(0)
  })
})
