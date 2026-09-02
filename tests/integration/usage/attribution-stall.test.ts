// @vitest-environment node
/*
 * attributionStall — the §A6.2 USER-facing stall signal (ops-alerting), against
 * a real testcontainers Postgres (per AGENTS.md — never mock Drizzle).
 *
 * The condition is §A2.2's shape, reusing read-path-health's zero-write-streak
 * semantics faithfully: consecutive completed azure-monitor-read runs that all
 * attributed 0 rows, persisting for OPS_ALERT_STALL_MINUTES, WHILE the fleet is
 * still emitting (instance_attestation.last_bearer_at inside the window).
 * These pin:
 *   - zero-write streak spanning the window + recent bearer = stall, `since` =
 *     the streak's oldest run (the exact instant, not "roughly");
 *   - writes present = null; no/stale bearers (idle estate) = null;
 *   - a streak YOUNGER than the window = null (time-integration, not one tick);
 *   - scoped recovery batches and in-flight rows never end a live stall
 *     (read-path-health's two incident clauses, reused);
 *   - an unknown outcome (null rows_affected) breaks the streak — no stall
 *     claim on evidence we did not record;
 *   - the env threshold OPS_ALERT_STALL_MINUTES is honoured, defaulting to 90.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  attributionStall,
  opsAlertStallMinutes,
  OPS_ALERT_STALL_MINUTES_DEFAULT,
} from '../../../server/usage/attribution-stall'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let buId: string
let teammateId: string

const NOW = new Date('2026-06-20T12:00:00Z')
const MIN = 60 * 1000

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.db.insert(schema.region).values({ code: 'stall', displayName: 'Stall' }).returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'stall.svc', code: 'stall-svc', displayName: 'Stall Services', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  buId = bu!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-stall-${randomUUID().slice(0, 8)}`,
      email: `stall.${randomUUID().slice(0, 8)}@example.com`,
      regionId,
      orgUnitId: buId,
      role: 'developer',
      isActive: true,
    })
    .returning({ id: schema.teammate.id })
  teammateId = tm!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

afterEach(async () => {
  await t.client`DELETE FROM worker_run WHERE worker_name = 'azure-monitor-read'`
  await t.client`DELETE FROM instance_attestation`
  delete process.env.OPS_ALERT_STALL_MINUTES
})

async function insertReaderRun(opts: {
  status?: string
  startedAtMs: number
  rowsAffected?: number | null
  scoped?: boolean
}): Promise<void> {
  const started = new Date(opts.startedAtMs).toISOString()
  const result = JSON.stringify({
    sessionsProcessed: 5,
    attributionRowsWritten: opts.rowsAffected ?? 0,
    errors: 0,
    ...(opts.scoped === undefined ? {} : { scoped: opts.scoped }),
  })
  await t.client`
    INSERT INTO worker_run (worker_name, status, started_at, finished_at, rows_affected, result)
    VALUES ('azure-monitor-read', ${opts.status ?? 'success'}, ${started}::timestamptz,
            ${started}::timestamptz, ${opts.rowsAffected ?? null}, ${result}::jsonb)
  `
}

// A fleet instance whose last_bearer_at is the INDEPENDENT "still emitting"
// signal the gate reads (same fixture shape as read-path-health.test.ts).
async function seedFleetEmit(bearerAtMs: number): Promise<void> {
  const instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: `oid-${instanceId}`,
    teammateId,
    projectCodeHash: `h-${instanceId.slice(0, 8)}`,
    rawProjectCode: 'STALL',
    tool: 'claude-code',
    sessionTokenHash: `tok-${instanceId}`,
    tsStart: new Date(bearerAtMs - MIN),
    lastBearerAt: new Date(bearerAtMs),
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
  })
}

/** Zero-write successes at 5/35/65/95/125 min ago — a streak spanning > 90 min. */
async function seedWindowSpanningZeroStreak(): Promise<number> {
  const oldestMs = NOW.getTime() - 125 * MIN
  for (const minsAgo of [5, 35, 65, 95, 125]) {
    await insertReaderRun({ startedAtMs: NOW.getTime() - minsAgo * MIN, rowsAffected: 0 })
  }
  return oldestMs
}

describe('attributionStall — the stall case', () => {
  it('zero-write streak spanning the window + recent bearer = stall since the streak start', async () => {
    await seedFleetEmit(NOW.getTime() - 10 * MIN)
    const oldestMs = await seedWindowSpanningZeroStreak()

    const stall = await attributionStall(t.db, { now: NOW })
    expect(stall).toEqual({ since: new Date(oldestMs).toISOString() })
  })

  it('scoped recovery batches and an in-flight run do NOT end a live stall', async () => {
    // read-path-health's two incident clauses, reused: an operator recovery
    // campaign writes successful row-writing batches (and dispatch inserts the
    // 'running' row with NO result) exactly while the scheduled reader is dead.
    await seedFleetEmit(NOW.getTime() - 10 * MIN)
    const oldestMs = await seedWindowSpanningZeroStreak()
    await insertReaderRun({ startedAtMs: NOW.getTime() - 2 * MIN, rowsAffected: 900, scoped: true })
    await t.client`
      INSERT INTO worker_run (worker_name, status, started_at)
      VALUES ('azure-monitor-read', 'running', ${new Date(NOW.getTime() - 30_000).toISOString()}::timestamptz)
    `

    const stall = await attributionStall(t.db, { now: NOW })
    expect(stall).toEqual({ since: new Date(oldestMs).toISOString() })
  })
})

describe('attributionStall — healthy / unprovable cases are null', () => {
  it('writes present (the newest run landed rows) = null', async () => {
    await seedFleetEmit(NOW.getTime() - 10 * MIN)
    await seedWindowSpanningZeroStreak()
    await insertReaderRun({ startedAtMs: NOW.getTime() - 1 * MIN, rowsAffected: 42 })

    expect(await attributionStall(t.db, { now: NOW })).toBeNull()
  })

  it('no bearers at all (idle estate) = null, even over a perfect zero streak', async () => {
    await seedWindowSpanningZeroStreak()
    expect(await attributionStall(t.db, { now: NOW })).toBeNull()
  })

  it('a bearer OLDER than the window = null (nothing recent to land)', async () => {
    await seedFleetEmit(NOW.getTime() - 91 * MIN)
    await seedWindowSpanningZeroStreak()
    expect(await attributionStall(t.db, { now: NOW })).toBeNull()
  })

  it('a streak YOUNGER than the window = null — §A2.2 is time-integrated, not one tick', async () => {
    await seedFleetEmit(NOW.getTime() - 10 * MIN)
    // Rows landed 95 min ago; zero-writes only since (5/35/65 min ago = 65-min streak).
    await insertReaderRun({ startedAtMs: NOW.getTime() - 95 * MIN, rowsAffected: 42 })
    for (const minsAgo of [5, 35, 65]) {
      await insertReaderRun({ startedAtMs: NOW.getTime() - minsAgo * MIN, rowsAffected: 0 })
    }
    expect(await attributionStall(t.db, { now: NOW })).toBeNull()
  })

  it('an unknown outcome (null rows_affected) breaks the streak = null', async () => {
    await seedFleetEmit(NOW.getTime() - 10 * MIN)
    await seedWindowSpanningZeroStreak()
    // A completed failure with no recorded outcome, newer than the streak.
    await insertReaderRun({ status: 'failure', startedAtMs: NOW.getTime() - 1 * MIN, rowsAffected: null })

    expect(await attributionStall(t.db, { now: NOW })).toBeNull()
  })

  it('a streak with NO successful run = null (hard failure is the fleet condition, not a stall)', async () => {
    await seedFleetEmit(NOW.getTime() - 10 * MIN)
    for (const minsAgo of [5, 35, 65, 95, 125]) {
      await insertReaderRun({ status: 'failure', startedAtMs: NOW.getTime() - minsAgo * MIN, rowsAffected: 0 })
    }
    expect(await attributionStall(t.db, { now: NOW })).toBeNull()
  })

  it('an empty ledger = null', async () => {
    await seedFleetEmit(NOW.getTime() - 10 * MIN)
    expect(await attributionStall(t.db, { now: NOW })).toBeNull()
  })
})

describe('OPS_ALERT_STALL_MINUTES — the one shared threshold', () => {
  it('defaults to 90; env overrides at call time; junk falls back', () => {
    expect(OPS_ALERT_STALL_MINUTES_DEFAULT).toBe(90)
    expect(opsAlertStallMinutes()).toBe(90)
    process.env.OPS_ALERT_STALL_MINUTES = '30'
    expect(opsAlertStallMinutes()).toBe(30)
    process.env.OPS_ALERT_STALL_MINUTES = 'not-a-number'
    expect(opsAlertStallMinutes()).toBe(90)
    process.env.OPS_ALERT_STALL_MINUTES = '0'
    expect(opsAlertStallMinutes()).toBe(90)
  })

  it('a tighter env threshold turns a 65-min streak into a stall', async () => {
    await seedFleetEmit(NOW.getTime() - 10 * MIN)
    const oldestMs = NOW.getTime() - 65 * MIN
    for (const minsAgo of [5, 35, 65]) {
      await insertReaderRun({ startedAtMs: NOW.getTime() - minsAgo * MIN, rowsAffected: 0 })
    }

    expect(await attributionStall(t.db, { now: NOW })).toBeNull() // 90-min default: too young
    process.env.OPS_ALERT_STALL_MINUTES = '60'
    expect(await attributionStall(t.db, { now: NOW })).toEqual({
      since: new Date(oldestMs).toISOString(),
    })
  })
})
