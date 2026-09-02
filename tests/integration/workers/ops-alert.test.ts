// @vitest-environment node
/*
 * runOpsAlert — the ops-alerting evaluator (docs/design/ops-alerting.md
 * A2/A3/A5) against a real testcontainers Postgres (per AGENTS.md — never mock
 * Drizzle). The notify fn, probes, clock and thresholds are injected; the kv
 * state machine, the worker_run/inbox/instance_attestation reads and the A5
 * inbox+audit parity run against the real schema.
 *
 * Covers the design's validation plan: two-run damping for EVERY severity
 * (docs/design/alert-diagnosability.md D3), send-before-persist (ar-M16),
 * delivered-only recovery (ar-M15), reminder cadence, the fleet predicate
 * (skipped-reset, wedged-running, cadence-aware deadline, the ≥threshold
 * critical), the attribution-stall signal on read-path-health-shaped fixtures,
 * disabled-when-env-empty, the probe budget (a hung probe resolves the run
 * inside the deadline) and the not-wired exclusion.
 *
 * Plus the D1/D2 diagnosability contract: every raised severity carries a
 * closed-enum reason, a TIMED-OUT probe and an ERRORED probe are told apart,
 * the probe's correlation id survives into the internal record, and none of it
 * reaches the public ntfy payload (ar-H9).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runOpsAlert, type ConditionState, type OpsAlertOpts } from '../../../server/workers/ops-alert'
import type { OpsNotifyFn, OpsNotifyKind, OpsNotifyResult } from '../../../server/observability/ops-notify'
import {
  OPS_ALERT_PAYLOAD_ALLOWLIST,
  isOpsAlertReason,
  type OpsAlertPayload,
} from '../../../shared/ops-alert/conditions'
import type { ReaderHealth } from '../../../server/azure/reader'
import type { NetCheckReport, NetCheckRecord } from '../../../server/azure/network-check'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let buId: string
let adminId: string

const NOW = new Date('2026-07-15T12:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const URL = 'https://example.invalid/ops-topic'

beforeAll(async () => {
  delete process.env.NUXT_OPS_ALERT_NTFY_URL
  delete process.env.OPS_ALERT_STALL_MINUTES
  delete process.env.OPS_ALERT_FLEET_THRESHOLD
  delete process.env.OPS_ALERT_REMIND_HOURS
  delete process.env.OPS_ALERT_INBOX_AGE_HOURS

  t = await startTestDb()
  const [region] = await t.db.insert(schema.region).values({ code: 'ops', displayName: 'OPS' }).returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ops.svc', code: 'ops-svc', displayName: 'OPS Services', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  buId = bu!.id
  // A platform-admin so the operations-recipient policy (ar-M18) has a member.
  const [admin] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-ops-admin-${randomUUID().slice(0, 8)}`,
      email: `ops.admin.${randomUUID().slice(0, 8)}@example.com`,
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

beforeEach(async () => {
  await t.client`DELETE FROM kv_store WHERE mount = 'ops-alert'`
  await t.client`DELETE FROM inbox_item`
  await t.client`DELETE FROM worker_run`
  await t.client`DELETE FROM attribution_record`
  await t.client`DELETE FROM instance_attestation`
})

// ── Fixture helpers ───────────────────────────────────────────────────────────

function mkNotify() {
  const calls: Array<{ payload: OpsAlertPayload; kind: OpsNotifyKind }> = []
  let scripted: OpsNotifyResult | null = null
  const fn: OpsNotifyFn = async (payload, kind) => {
    // Belt on top of the unit allowlist test: every payload the WORKER emits is
    // shape-checked at the seam (ar-H9).
    for (const key of Object.keys(payload)) {
      expect(OPS_ALERT_PAYLOAD_ALLOWLIST, `non-allowlisted payload key '${key}'`).toContain(key)
    }
    calls.push({ payload, kind })
    return scripted ?? { delivered: true, status: 200, disabled: false }
  }
  return {
    calls,
    fn,
    fail(status: number | null) {
      scripted = { delivered: false, status, disabled: false }
    },
    ok() {
      scripted = null
    },
  }
}

const okReader = async (): Promise<ReaderHealth> => ({ ok: true, kind: 'log-analytics', latencyMs: 1 })
/*
 * The probe ANSWERED unhealthy with a query STATUS — free text, not vocabulary,
 * so it degrades to 'probe-unhealthy' and never travels verbatim.
 */
const failReader = async (): Promise<ReaderHealth> => ({ ok: false, kind: 'log-analytics', latencyMs: 1, error: 'query status=Failure' })
/*
 * The probe ANSWERED unhealthy having CLASSIFIED a caught driver exception —
 * the shape LogAnalyticsReader.healthCheck returns from its catch block. This
 * is the case that must not read as a timeout.
 */
const CLASSIFIED_CORRELATION_ID = '4f2c1b90-8a3d-4e51-9c77-b0e2a1d3f645'
const classifiedFailReader = async (): Promise<ReaderHealth> => ({
  ok: false,
  kind: 'log-analytics',
  latencyMs: 1,
  error: 'driver-unreachable',
  correlationId: CLASSIFIED_CORRELATION_ID,
})

function mkNetRecord(over: Partial<NetCheckRecord>): NetCheckRecord {
  return {
    service: 'svc',
    category: 'azure-monitor',
    host: 'example.host',
    port: 443,
    expectedZone: 'zone',
    expectPrivate: true,
    addresses: [],
    resolvesPrivate: false,
    reachable: null,
    tcpLatencyMs: null,
    verdict: 'ok',
    ...over,
  }
}

function netReport(records: NetCheckRecord[]): NetCheckReport {
  return {
    generatedNote: 'test',
    vnetHint: 'test-vnet',
    records,
    summary: { total: records.length, ok: 0, dnsOnly: 0, zoneNotLinked: 0, unreachable: 0, dnsFail: 0, notWired: 0 },
    itReport: '',
  }
}

const okNetwork = async () => netReport([])

interface RunOver {
  at?: Date
  telemetry?: () => Promise<ReaderHealth>
  network?: () => Promise<NetCheckReport>
  workers?: OpsAlertOpts['workers']
  thresholds?: OpsAlertOpts['thresholds']
  stallLoaders?: OpsAlertOpts['stallLoaders']
  probeTimeoutMs?: number
  telemetryProbeTimeoutMs?: number
  totalDeadlineMs?: number
  notify: OpsNotifyFn
}

async function run(over: RunOver) {
  return runOpsAlert(t.db, {
    now: over.at ?? NOW,
    ntfyUrl: URL,
    envTag: 'dev',
    notify: over.notify,
    probes: {
      telemetryRead: over.telemetry ?? okReader,
      network: over.network ?? okNetwork,
    },
    workers: over.workers ?? [],
    thresholds: over.thresholds,
    ...(over.stallLoaders !== undefined ? { stallLoaders: over.stallLoaders } : {}),
    ...(over.probeTimeoutMs !== undefined ? { probeTimeoutMs: over.probeTimeoutMs } : {}),
    ...(over.telemetryProbeTimeoutMs !== undefined
      ? { telemetryProbeTimeoutMs: over.telemetryProbeTimeoutMs }
      : {}),
    ...(over.totalDeadlineMs !== undefined ? { totalDeadlineMs: over.totalDeadlineMs } : {}),
  })
}

/*
 * D3: EVERY severity is two-run damped, so announcing a condition takes two
 * consecutive observations. Runs the ARMING tick at `over.at ?? NOW` and
 * returns the PAGING tick's result, one cadence later. Fixtures are anchored to
 * NOW and only age across the pair, so every condition that fires on the arming
 * tick still fires on the paging one.
 */
const PAGE_TICK_MS = 15 * MIN
function pagedAt(over: RunOver): Date {
  return new Date((over.at ?? NOW).getTime() + PAGE_TICK_MS)
}
async function armAndPage(over: RunOver) {
  await run({ ...over, at: over.at ?? NOW })
  return run({ ...over, at: pagedAt(over) })
}

async function insertRun(worker: string, status: string, startedAtMs: number, rowsAffected: number | null = null): Promise<void> {
  const started = new Date(startedAtMs).toISOString()
  const finished = status === 'running' ? null : started
  await t.client`
    INSERT INTO worker_run (worker_name, status, started_at, finished_at, rows_affected, result)
    VALUES (${worker}, ${status}, ${started}::timestamptz, ${finished}::timestamptz, ${rowsAffected},
            ${status === 'running' ? null : '{"sessionsProcessed":5,"errors":0}'}::jsonb)
  `
}

async function seedFleetEmit(bearerAtMs: number): Promise<void> {
  const instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: `oid-${instanceId}`,
    teammateId: adminId,
    projectCodeHash: `h-${instanceId.slice(0, 8)}`,
    rawProjectCode: 'OPS',
    tool: 'claude-code',
    sessionTokenHash: `tok-${instanceId}`,
    tsStart: new Date(bearerAtMs - MIN),
    lastBearerAt: new Date(bearerAtMs),
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
  })
}

async function kvState(key: string): Promise<ConditionState | null> {
  const rows = await t.client<{ value: string }[]>`
    SELECT value FROM kv_store WHERE mount = 'ops-alert' AND key = ${key}`
  return rows[0] ? (JSON.parse(rows[0].value) as ConditionState) : null
}

async function kvCount(): Promise<number> {
  const rows = await t.client<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM kv_store WHERE mount = 'ops-alert'`
  return Number(rows[0]!.c)
}

async function openOpsItems(key: string): Promise<Array<{ severity: string; body: Record<string, unknown> }>> {
  const rows = await t.client<{ severity: string; body: Record<string, unknown> }[]>`
    SELECT severity, body::jsonb AS body FROM inbox_item
     WHERE category = 'ops-alert' AND related_entity_kind = ${key}
       AND ack_state IN ('unread','read','acknowledged')`
  return [...rows]
}

async function auditCount(eventType: string, condition: string): Promise<number> {
  const rows = await t.client<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM audit_event
     WHERE event_type = ${eventType} AND payload->>'condition' = ${condition}`
  return Number(rows[0]!.c)
}

// ── The scenarios ─────────────────────────────────────────────────────────────

describe('disabled when the channel env is empty (A1)', () => {
  it('does nothing at all — no probes drive state, no notify, no kv', async () => {
    const notify = mkNotify()
    const res = await runOpsAlert(t.db, {
      now: NOW,
      notify: notify.fn,
      probes: { telemetryRead: failReader, network: okNetwork },
      workers: [],
    })
    expect(res.disabled).toBe(true)
    expect(notify.calls.length).toBe(0)
    expect(await kvCount()).toBe(0)
  })
})

describe('CRITICAL is two-run damped too (D3) — telemetry-read', () => {
  it('withholds on the first failing run, pages on the second, with inbox + audit parity, then holds', async () => {
    const notify = mkNotify()
    const before = await auditCount('ops-alert-delivered', 'telemetry-read')

    // Tick 1: the critical is OBSERVED and recorded — and nothing goes out.
    // Reverting D3 (`obs.severity === 'warning' && …`) turns this red: the
    // page lands on the first observation again.
    const res1 = await run({ notify: notify.fn, telemetry: failReader })
    expect(res1.conditions['telemetry-read']).toEqual({ severity: 'critical', reason: 'probe-unhealthy' })
    expect(notify.calls.length).toBe(0)
    expect(res1.sent).toBe(0)
    expect(await kvState('telemetry-read')).toMatchObject({ delivered: false, activeRuns: 1 })

    // Tick 2: same critical, second consecutive run → announced.
    const at2 = new Date(NOW.getTime() + 15 * MIN)
    const res2 = await run({ notify: notify.fn, telemetry: failReader, at: at2 })
    expect(notify.calls.length).toBe(1)
    expect(notify.calls[0]!.kind).toBe('alert')
    expect(notify.calls[0]!.payload).toMatchObject({ severity: 'critical', condition: 'telemetry-read', env: 'dev' })
    expect(res2.sent).toBe(1)

    const state = await kvState('telemetry-read')
    expect(state).toMatchObject({ delivered: true, lastSentAtMs: at2.getTime(), severity: 'critical' })

    // A5 parity: ONE admin inbox item on the condition key, urgent — and it
    // carries the DIAGNOSIS (D2), which the payload above does not.
    const items = await openOpsItems('telemetry-read')
    expect(items.length).toBe(1)
    expect(items[0]!.severity).toBe('urgent')
    expect(items[0]!.body.condition).toBe('telemetry-read')
    expect(items[0]!.body.reason).toBe('probe-unhealthy')
    expect(await auditCount('ops-alert-delivered', 'telemetry-read')).toBe(before + 1)

    // Still failing next tick: no re-page (reminder not due), and the inbox
    // item is UPDATED, never duplicated (ar-M17).
    const res3 = await run({ notify: notify.fn, telemetry: failReader, at: new Date(NOW.getTime() + 30 * MIN) })
    expect(res3.sent).toBe(0)
    expect(notify.calls.length).toBe(1)
    expect((await openOpsItems('telemetry-read')).length).toBe(1)
  })
})

describe('send-then-persist (ar-M16)', () => {
  it('a failed POST leaves NO last-sent marker — the next run retries; inbox/audit are independent', async () => {
    const notify = mkNotify()
    notify.fail(500)
    const failedBefore = await auditCount('ops-alert-failed', 'telemetry-read')

    // Arming tick (D3): damped, so there is no send to fail yet.
    await run({ notify: notify.fn, telemetry: failReader })
    expect(notify.calls.length).toBe(0)

    const at2 = new Date(NOW.getTime() + 15 * MIN)
    const res = await run({ notify: notify.fn, telemetry: failReader, at: at2 })
    expect(res.sendFailures).toBe(1)
    expect(notify.calls.length).toBe(1)

    // The ntfy attempt preceded the kv write, and the 2xx never came: the
    // persisted state must carry NO delivery marker.
    const state = await kvState('telemetry-read')
    expect(state).toMatchObject({ delivered: false, lastSentAtMs: null })
    expect(await auditCount('ops-alert-failed', 'telemetry-read')).toBe(failedBefore + 1)
    // Inbox parity is independent of delivery success (A3/A5).
    expect((await openOpsItems('telemetry-read')).length).toBe(1)

    // Channel restored → the very next run retries and delivers. Damping never
    // re-arms an undelivered condition at the SAME severity (ar-M16).
    notify.ok()
    const at3 = new Date(NOW.getTime() + 30 * MIN)
    const res2 = await run({ notify: notify.fn, telemetry: failReader, at: at3 })
    expect(res2.sent).toBe(1)
    expect(notify.calls.length).toBe(2)
    expect(await kvState('telemetry-read')).toMatchObject({ delivered: true, lastSentAtMs: at3.getTime() })
    expect((await openOpsItems('telemetry-read')).length).toBe(1)
  })
})

describe('recovery is DELIVERED-only (ar-M15)', () => {
  it('a never-announced flap clears silently — no recovery notice, key dropped', async () => {
    const notify = mkNotify()
    // A per-worker warning, armed once then cleared before it was ever
    // announced. (It used to be the inbox-aging condition, which this change
    // retires — the behaviour under test is the state machine's, not that
    // condition's.)
    const flapper = { name: 'ft-flap', recommendedCron: '*/15 * * * *' }
    await insertRun('ft-flap', 'failure', NOW.getTime() - 10 * MIN)
    await insertRun('ft-flap', 'failure', NOW.getTime() - 25 * MIN)
    await run({ notify: notify.fn, workers: [flapper] }) // damped, persisted, nothing sent
    expect(await kvCount()).toBe(1)

    await t.client`DELETE FROM worker_run WHERE worker_name = 'ft-flap'`
    const res = await run({ notify: notify.fn, workers: [flapper], at: new Date(NOW.getTime() + 15 * MIN) })
    expect(res.statesDeleted).toBe(1)
    expect(res.recoveries).toBe(0)
    expect(notify.calls.length).toBe(0)
    expect(await kvCount()).toBe(0)
  })

  it('a delivered condition recovers only after ONE FULL clear run, resolving its inbox item', async () => {
    const notify = mkNotify()
    await armAndPage({ notify: notify.fn, telemetry: failReader }) // delivered at NOW+15
    expect(notify.calls.length).toBe(1)
    const recoveredBefore = await auditCount('ops-alert-recovered', 'telemetry-read')

    // First clear run: only marks — no recovery yet. Recovery is UNCHANGED by
    // D3; it always needed a full clear run.
    const clear1 = await run({ notify: notify.fn, at: new Date(NOW.getTime() + 30 * MIN) })
    expect(clear1.recoveries).toBe(0)
    expect(notify.calls.length).toBe(1)
    expect(await kvState('telemetry-read')).toMatchObject({ clearRuns: 1 })

    // Second consecutive clear run: RECOVERED, key deleted, inbox resolved.
    const clear2 = await run({ notify: notify.fn, at: new Date(NOW.getTime() + 45 * MIN) })
    expect(clear2.recoveries).toBe(1)
    expect(notify.calls.length).toBe(2)
    expect(notify.calls[1]!.kind).toBe('recovered')
    expect(notify.calls[1]!.payload).toMatchObject({ severity: 'info', condition: 'telemetry-read' })
    expect(await kvState('telemetry-read')).toBeNull()
    expect((await openOpsItems('telemetry-read')).length).toBe(0)
    expect(await auditCount('ops-alert-recovered', 'telemetry-read')).toBe(recoveredBefore + 1)
  })

  it('a failed RECOVERED post keeps the key retryable (same ar-M16 shape as alerts)', async () => {
    const notify = mkNotify()
    await armAndPage({ notify: notify.fn, telemetry: failReader }) // delivered at NOW+15
    await run({ notify: notify.fn, at: new Date(NOW.getTime() + 30 * MIN) }) // clear run 1

    notify.fail(null)
    const failedAttempt = await run({ notify: notify.fn, at: new Date(NOW.getTime() + 45 * MIN) })
    expect(failedAttempt.recoveries).toBe(0)
    expect(failedAttempt.sendFailures).toBe(1)
    expect(await kvState('telemetry-read')).not.toBeNull()

    notify.ok()
    const retried = await run({ notify: notify.fn, at: new Date(NOW.getTime() + 60 * MIN) })
    expect(retried.recoveries).toBe(1)
    expect(await kvState('telemetry-read')).toBeNull()
  })
})

describe('reminder cadence (A3)', () => {
  it('reminds every remindHours while unresolved, updating the inbox item in place', async () => {
    const notify = mkNotify()
    const deliveredAt = new Date(NOW.getTime() + 15 * MIN)
    await armAndPage({ notify: notify.fn, telemetry: failReader }) // delivered at NOW+15
    const remindedBefore = await auditCount('ops-alert-reminded', 'telemetry-read')

    const early = await run({ notify: notify.fn, telemetry: failReader, at: new Date(deliveredAt.getTime() + 3 * HOUR) })
    expect(early.reminders).toBe(0)
    expect(notify.calls.length).toBe(1)

    const dueAt = new Date(deliveredAt.getTime() + 7 * HOUR)
    const due = await run({ notify: notify.fn, telemetry: failReader, at: dueAt })
    expect(due.reminders).toBe(1)
    expect(notify.calls.length).toBe(2)
    expect(notify.calls[1]!.kind).toBe('reminder')
    expect(await kvState('telemetry-read')).toMatchObject({ lastSentAtMs: dueAt.getTime() })
    expect(await auditCount('ops-alert-reminded', 'telemetry-read')).toBe(remindedBefore + 1)

    // Reminders UPDATE the one open item, never duplicate (ar-M17).
    const items = await openOpsItems('telemetry-read')
    expect(items.length).toBe(1)
    expect(items[0]!.body.last_reminded_at).toBe(dueAt.toISOString())

    const soonAfter = await run({ notify: notify.fn, telemetry: failReader, at: new Date(dueAt.getTime() + 15 * MIN) })
    expect(soonAfter.reminders).toBe(0)
    expect(notify.calls.length).toBe(2)
  })
})

describe('the fleet predicate (A2.3)', () => {
  const alpha = { name: 'ft-alpha', recommendedCron: '*/15 * * * *' }

  it('SKIPPED resets the failure streak — disable/re-enable must not resurrect old failures (ar-M12)', async () => {
    const notify = mkNotify()
    await insertRun('ft-alpha', 'failure', NOW.getTime() - 10 * MIN)
    await insertRun('ft-alpha', 'skipped', NOW.getTime() - 25 * MIN)
    await insertRun('ft-alpha', 'failure', NOW.getTime() - 40 * MIN)
    await insertRun('ft-alpha', 'failure', NOW.getTime() - 55 * MIN)

    const res = await run({ notify: notify.fn, workers: [alpha] })
    expect(res.conditions['worker:ft-alpha']).toBeUndefined()
    expect(notify.calls.length).toBe(0)
    expect(await kvCount()).toBe(0)
  })

  it('two consecutive failures + missed deadline = warning, two-run damped', async () => {
    const notify = mkNotify()
    await insertRun('ft-alpha', 'failure', NOW.getTime() - 10 * MIN)
    await insertRun('ft-alpha', 'failure', NOW.getTime() - 25 * MIN)

    const res1 = await run({ notify: notify.fn, workers: [alpha] })
    expect(res1.conditions['worker:ft-alpha']).toEqual({ severity: 'warning', reason: 'worker-failing', count: 2 })
    expect(notify.calls.length).toBe(0)

    const res2 = await run({ notify: notify.fn, workers: [alpha], at: new Date(NOW.getTime() + 15 * MIN) })
    /*
     * ANNOUNCED, NOT PUSHED (owner ruling 2026-08-30). A per-worker failure is
     * the DETAIL behind the critical worker-fleet page; pushing both meant one
     * systemic outage paged N+1 times and reminded N+1 times every six hours.
     *
     * The state machine is untouched — still damped for two runs, still
     * persisted, still an inbox item. Only the push is gone, and the audit says
     * 'suppressed' so the trail cannot be read as a page that went out.
     */
    expect(res2.sent).toBe(0)
    expect(res2.suppressed).toBe(1)
    expect(notify.calls.length, 'a warning must never reach the channel').toBe(0)
    expect(await kvState('worker:ft-alpha')).toMatchObject({ delivered: true })
    expect(await auditCount('ops-alert-suppressed', 'worker:ft-alpha')).toBe(1)
    expect(await auditCount('ops-alert-delivered', 'worker:ft-alpha')).toBe(0)
  })

  it('an overdue RUNNING row counts as a failure; a fresh one is no evidence (ar-M12)', async () => {
    const notify = mkNotify()
    // Wedged: running for longer than 2× the dispatch budget (400 s).
    await insertRun('ft-wedge', 'running', NOW.getTime() - 10 * MIN)
    await insertRun('ft-wedge', 'failure', NOW.getTime() - 30 * MIN)
    // Fresh: running for 1 min — skipped over, leaving a single failure.
    await insertRun('ft-fresh', 'running', NOW.getTime() - MIN)
    await insertRun('ft-fresh', 'failure', NOW.getTime() - 20 * MIN)

    const res = await run({
      notify: notify.fn,
      workers: [
        { name: 'ft-wedge', recommendedCron: '*/15 * * * *' },
        { name: 'ft-fresh', recommendedCron: '*/15 * * * *' },
      ],
    })
    expect(res.conditions['worker:ft-wedge']).toMatchObject({ severity: 'warning', reason: 'worker-failing' })
    expect(res.conditions['worker:ft-fresh']).toBeUndefined()
  })

  it('the cadence-aware deadline (3× interval) suppresses while a success is inside it (ar-M13)', async () => {
    const notify = mkNotify()
    const slow = { name: 'ft-slow', recommendedCron: '0 */6 * * *' } // deadline 18h
    await insertRun('ft-slow', 'failure', NOW.getTime() - 10 * MIN)
    await insertRun('ft-slow', 'failure', NOW.getTime() - 25 * MIN)
    await insertRun('ft-slow', 'success', NOW.getTime() - 2 * HOUR)

    const withinDeadline = await run({ notify: notify.fn, workers: [slow] })
    expect(withinDeadline.conditions['worker:ft-slow']).toBeUndefined()

    // Push the success outside the 18 h deadline → now failing.
    await t.client`DELETE FROM worker_run WHERE worker_name = 'ft-slow' AND status = 'success'`
    await insertRun('ft-slow', 'success', NOW.getTime() - 20 * HOUR)
    const missedDeadline = await run({ notify: notify.fn, workers: [slow] })
    expect(missedDeadline.conditions['worker:ft-slow']).toMatchObject({ severity: 'warning', reason: 'worker-failing' })
  })

  it('≥ fleetThreshold independently-failing workers = worker-fleet CRITICAL, announced on the second run', async () => {
    const notify = mkNotify()
    const fleet = ['ft-a', 'ft-b', 'ft-c', 'ft-d'].map((name) => ({ name, recommendedCron: '*/15 * * * *' }))
    for (const w of fleet) {
      await insertRun(w.name, 'failure', NOW.getTime() - 10 * MIN)
      await insertRun(w.name, 'failure', NOW.getTime() - 25 * MIN)
    }
    const over = { notify: notify.fn, workers: fleet, thresholds: { fleetThreshold: 4 } }

    // The aggregate's count is HOW MANY workers are failing; each per-worker
    // key's count is that worker's own streak — different measurements, and so
    // different reasons.
    const res1 = await run(over)
    expect(res1.conditions['worker-fleet']).toEqual({ severity: 'critical', reason: 'workers-failing', count: 4 })
    expect(res1.conditions['worker:ft-a']).toEqual({ severity: 'warning', reason: 'worker-failing', count: 2 })
    expect(notify.calls.length).toBe(0) // D3: the critical is damped too

    /*
     * Tick 2: the critical announces and the four per-worker warnings do NOT.
     *
     * This is the whole point of the severity rule. Before it, one systemic
     * outage sent FIVE pushes on this tick and five reminders every six hours
     * after it — the aggregate plus its own symptoms. Now the phone gets the
     * one page that says "the fleet is failing", and the four names behind it
     * are on the workers card and in the inbox.
     */
    const res2 = await run({ ...over, at: pagedAt(over) })
    expect(res2.sent, 'exactly one push for one systemic failure').toBe(1)
    expect(res2.suppressed, 'the four per-worker warnings, announced not pushed').toBe(4)
    expect(notify.calls.length).toBe(1)
    expect(notify.calls[0]!.payload).toMatchObject({ severity: 'critical', condition: 'worker-fleet', count: 4 })
  })
})

describe('attribution stall (A2.2)', () => {
  async function seedZeroWriteStreak(): Promise<void> {
    for (const agoMin of [5, 35, 65, 95]) {
      await t.client`
        INSERT INTO worker_run (worker_name, status, started_at, finished_at, rows_affected, result)
        VALUES ('azure-monitor-read', 'success',
                ${new Date(NOW.getTime() - agoMin * MIN).toISOString()}::timestamptz,
                ${new Date(NOW.getTime() - agoMin * MIN).toISOString()}::timestamptz,
                0, '{"sessionsProcessed":5,"attributionRowsWritten":0,"errors":0}'::jsonb)
      `
    }
  }

  it('joiner writing nothing for the stall window WHILE the fleet emits = critical page', async () => {
    const notify = mkNotify()
    await seedFleetEmit(NOW.getTime() - 10 * MIN)
    await seedZeroWriteStreak()

    const res = await armAndPage({ notify: notify.fn })
    expect(res.conditions['attribution-stall']).toEqual({
      severity: 'critical',
      reason: 'zero-write-streak',
      count: 4,
    })
    expect(notify.calls.length).toBe(1)
    expect(notify.calls[0]!.payload).toMatchObject({ severity: 'critical', condition: 'attribution-stall' })
  })

  it('an IDLE estate is silent — same zero-writes, no recent bearer mint', async () => {
    const notify = mkNotify()
    await seedFleetEmit(NOW.getTime() - 3 * HOUR)
    await seedZeroWriteStreak()

    const res = await run({ notify: notify.fn })
    expect(res.conditions['attribution-stall']).toBeUndefined()
    expect(notify.calls.length).toBe(0)
  })
})

describe('probe budget (ar-H6)', () => {
  const hang = () => new Promise<never>(() => {})

  it('hung probes resolve the run inside the deadline and read as RED, reason probe-timeout', async () => {
    const notify = mkNotify()
    const started = Date.now()
    const res = await run({
      notify: notify.fn,
      telemetry: hang as () => Promise<ReaderHealth>,
      network: hang as () => Promise<NetCheckReport>,
      probeTimeoutMs: 150,
      telemetryProbeTimeoutMs: 150,
      totalDeadlineMs: 1_500,
    })
    // The run resolved well inside the budget despite two never-settling probes.
    expect(Date.now() - started).toBeLessThan(5_000)
    // A probe that cannot answer inside its budget IS the outage class (ar-H1):
    // both probe conditions read critical — and both say WHY.
    expect(res.conditions['telemetry-read']).toEqual({ severity: 'critical', reason: 'probe-timeout' })
    expect(res.conditions['probe-network']).toEqual({ severity: 'critical', reason: 'probe-timeout' })
    expect(notify.calls.length).toBe(0) // D3: damped on first observation
  })

  it('the telemetry probe has its OWN budget — the shared per-probe one does not bound it (D4)', async () => {
    const notify = mkNotify()
    // The shared budget (ntfy send + per-host TCP dial) is 60 ms; the telemetry
    // probe's own is 400 ms. A reader that answers at ~200 ms is HEALTHY — it
    // would have been a false page under the shared bound, which is exactly
    // the 5 293 ms-vs-5 000 ms incident in miniature.
    const slowButHealthy = async (): Promise<ReaderHealth> => {
      await new Promise((r) => setTimeout(r, 200))
      return { ok: true, kind: 'log-analytics', latencyMs: 200 }
    }
    const res = await run({
      notify: notify.fn,
      telemetry: slowButHealthy,
      probeTimeoutMs: 60,
      telemetryProbeTimeoutMs: 400,
      totalDeadlineMs: 5_000,
    })
    expect(res.conditions['telemetry-read']).toBeUndefined()
    expect(notify.calls.length).toBe(0)
  })
})

describe('a timed-out probe and an errored probe are DIFFERENT faults (D1)', () => {
  const hang = () => new Promise<never>(() => {})

  it('records probe-timeout vs the classified reason — the assertion whose absence cost four hours', async () => {
    // Same condition key, same severity, same count: under the old code these
    // two runs were byte-identical, and telling them apart needed a KQL console.
    // A blown budget is OUR bound (fix: D4); driver-unreachable is Log
    // Analytics (fix: the network path). Collapse the two branches of
    // probeFailureReason into one and this test goes red.
    const timedOut = await run({
      notify: mkNotify().fn,
      telemetry: hang as () => Promise<ReaderHealth>,
      probeTimeoutMs: 5_000,
      telemetryProbeTimeoutMs: 100,
      totalDeadlineMs: 2_000,
    })
    expect(timedOut.conditions['telemetry-read']).toEqual({ severity: 'critical', reason: 'probe-timeout' })

    await t.client`DELETE FROM kv_store WHERE mount = 'ops-alert'`
    const errored = await run({ notify: mkNotify().fn, telemetry: classifiedFailReader })
    expect(errored.conditions['telemetry-read']).toEqual({
      severity: 'critical',
      reason: 'driver-unreachable',
      correlationId: CLASSIFIED_CORRELATION_ID,
    })

    expect(errored.conditions['telemetry-read']!.reason).not.toBe(timedOut.conditions['telemetry-read']!.reason)
    // The timeout carries NO correlation id: nothing was classified, so there
    // is no server log line to point at. Inventing one would be a false lead.
    expect(timedOut.conditions['telemetry-read']!.correlationId).toBeUndefined()
  })

  it('a probe that THROWS is neither a timeout nor a classified fault', async () => {
    const res = await run({
      notify: mkNotify().fn,
      telemetry: async () => {
        throw new Error('reader blew up')
      },
    })
    expect(res.conditions['telemetry-read']).toEqual({ severity: 'critical', reason: 'probe-threw' })
  })

  it('a non-vocabulary status string never travels as a reason — it degrades to probe-unhealthy', async () => {
    const res = await run({
      notify: mkNotify().fn,
      telemetry: async () => ({ ok: false, kind: 'local', latencyMs: 1, error: 'HTTP 404' }),
    })
    expect(res.conditions['telemetry-read']).toEqual({ severity: 'critical', reason: 'probe-unhealthy' })
    expect(JSON.stringify(res.conditions)).not.toContain('HTTP 404')
  })

  it('a later reason WITHOUT a correlation id clears the previous one — never pairs a new reason with a stale id (D2)', async () => {
    // `body || patch::jsonb` is a SHALLOW merge. If the patch omits
    // correlation_id when the new diagnosis has none, the id from the earlier
    // classified fault survives and is rendered beside the new reason, sending
    // the operator to an unrelated log line — the exact class this change exists
    // to remove.
    await armAndPage({ telemetry: classifiedFailReader })
    const first = await openOpsItems('telemetry-read')
    expect(first[0]!.body.reason).toBe('driver-unreachable')
    expect(first[0]!.body.correlation_id).toBe(CLASSIFIED_CORRELATION_ID)

    // Same open episode, next evaluation: a timeout, which carries no id.
    await armAndPage({
      telemetry: (() => new Promise<never>(() => {})) as () => Promise<ReaderHealth>,
      telemetryProbeTimeoutMs: 100,
      totalDeadlineMs: 2_000,
    })
    const second = await openOpsItems('telemetry-read')
    expect(second.length).toBe(1)
    expect(second[0]!.body.reason).toBe('probe-timeout')
    expect(second[0]!.body.correlation_id).toBeNull()
  })

  it('the classified reason and correlation id reach the inbox body, and NEITHER reaches ntfy (D2)', async () => {
    const notify = mkNotify()
    await armAndPage({ notify: notify.fn, telemetry: classifiedFailReader })
    expect(notify.calls.length).toBe(1)

    // The INTERNAL record answers "why".
    const items = await openOpsItems('telemetry-read')
    expect(items.length).toBe(1)
    expect(items[0]!.body.reason).toBe('driver-unreachable')
    expect(items[0]!.body.correlation_id).toBe(CLASSIFIED_CORRELATION_ID)

    // The PUBLIC one does not (ar-H9). mkNotify already fails on any
    // non-allowlisted key; this pins the two fields by name.
    const payload = notify.calls[0]!.payload as Record<string, unknown>
    expect('reason' in payload).toBe(false)
    expect('correlationId' in payload).toBe(false)
    expect(JSON.stringify(payload)).not.toContain('driver-unreachable')
    expect(JSON.stringify(payload)).not.toContain(CLASSIFIED_CORRELATION_ID)
  })
})

describe('network probe classification (A2.1)', () => {
  it("deliberately-unwired services never page (the 'not-wired' exclusion, PR #280)", async () => {
    const notify = mkNotify()
    const res = await run({
      notify: notify.fn,
      network: async () => netReport([mkNetRecord({ service: 'redis', verdict: 'not-wired' })]),
    })
    expect(res.conditions['probe-network']).toBeUndefined()
    expect(notify.calls.length).toBe(0)
  })

  it('an expectPrivate failure pages critical with the failing-record count; public references do not', async () => {
    const notify = mkNotify()
    const over = {
      notify: notify.fn,
      network: async () =>
        netReport([
          mkNetRecord({ verdict: 'dns-public-zone-not-linked' }),
          mkNetRecord({ service: 'api.loganalytics.io', expectPrivate: false, verdict: 'unreachable' }),
        ]),
    }
    // The sweep ANSWERED — the hosts are failing, not the probe. That is a
    // different fault (and a different fix) from a sweep that timed out.
    const res = await armAndPage(over)
    expect(res.conditions['probe-network']).toEqual({ severity: 'critical', reason: 'hosts-failing', count: 1 })
    expect(notify.calls.length).toBe(1)
  })
})

describe('post-notify write ordering: saveState before best-effort audit/inbox', () => {
  async function installAuditReject(): Promise<void> {
    await t.client`
      CREATE OR REPLACE FUNCTION ops_test_audit_reject() RETURNS trigger AS $fn$
      BEGIN RAISE EXCEPTION 'audit rejected (test fixture)'; END $fn$ LANGUAGE plpgsql`
    await t.client`
      CREATE TRIGGER ops_test_audit_reject BEFORE INSERT ON audit_event
      FOR EACH ROW WHEN (NEW.event_type LIKE 'ops-alert-%')
      EXECUTE FUNCTION ops_test_audit_reject()`
  }
  async function removeAuditReject(): Promise<void> {
    await t.client`DROP TRIGGER IF EXISTS ops_test_audit_reject ON audit_event`
    await t.client`DROP FUNCTION IF EXISTS ops_test_audit_reject()`
  }

  it('an audit failure never costs the delivered marker: one page, no duplicate next tick, other keys still evaluated', async () => {
    const notify = mkNotify()
    const deliveredBefore = await auditCount('ops-alert-delivered', 'telemetry-read')

    // Tick 1 arms telemetry only (D3 damping) — nothing sends, nothing audits.
    await run({ notify: notify.fn, telemetry: failReader })
    expect(notify.calls.length).toBe(0)

    // Arms the OTHER key: a per-worker warning. (Was inbox-aging, retired.)
    await insertRun('ft-other', 'failure', NOW.getTime() - 10 * MIN)
    await insertRun('ft-other', 'failure', NOW.getTime() - 25 * MIN)
    const other = { name: 'ft-other', recommendedCron: '*/15 * * * *' }
    await installAuditReject()
    const at2 = new Date(NOW.getTime() + 15 * MIN)
    try {
      const res = await run({ notify: notify.fn, telemetry: failReader, at: at2, workers: [other] })
      expect(res.sent).toBe(1)
      expect(notify.calls.length).toBe(1)
      expect(notify.calls[0]!.payload.condition).toBe('telemetry-read')
      // The state-machine-critical write survived the audit rejection.
      expect(await kvState('telemetry-read')).toMatchObject({ delivered: true, lastSentAtMs: at2.getTime() })
      expect(await auditCount('ops-alert-delivered', 'telemetry-read')).toBe(deliveredBefore)
      // The loop continued past the failing key: the worker warning was damped-persisted.
      expect(await kvState('worker:ft-other')).toMatchObject({ delivered: false, activeRuns: 1 })

      // Next tick: NO duplicate telemetry page, and the warning announces
      // without pushing — so the channel sees nothing new at all.
      const res2 = await run({
        notify: notify.fn,
        telemetry: failReader,
        at: new Date(NOW.getTime() + 30 * MIN),
        workers: [other],
      })
      expect(res2.sent).toBe(0)
      expect(res2.suppressed).toBe(1)
      expect(notify.calls.length).toBe(1)
    } finally {
      await removeAuditReject()
    }
  })

  it('a failed inbox-resolve on recovery keeps the state row: recovery re-sends next tick and the resolve retries', async () => {
    const notify = mkNotify()
    await armAndPage({ notify: notify.fn, telemetry: failReader }) // delivered at NOW+15
    await run({ notify: notify.fn, at: new Date(NOW.getTime() + 30 * MIN) }) // clear run 1
    await t.client`
      CREATE OR REPLACE FUNCTION ops_test_resolve_reject() RETURNS trigger AS $fn$
      BEGIN RAISE EXCEPTION 'resolve rejected (test fixture)'; END $fn$ LANGUAGE plpgsql`
    await t.client`
      CREATE TRIGGER ops_test_resolve_reject BEFORE UPDATE ON inbox_item
      FOR EACH ROW WHEN (NEW.ack_state = 'resolved' AND NEW.category = 'ops-alert')
      EXECUTE FUNCTION ops_test_resolve_reject()`
    try {
      const res = await run({ notify: notify.fn, at: new Date(NOW.getTime() + 45 * MIN) })
      // The RECOVERED notice went out, the resolve threw — the key must survive
      // so the resolve can retry (duplicate recovery notice over a permanently
      // stranded open inbox row).
      expect(notify.calls.length).toBe(2)
      expect(notify.calls[1]!.kind).toBe('recovered')
      expect(res.keyErrors).toBe(1)
      expect(res.statesDeleted).toBe(0)
      expect(await kvState('telemetry-read')).not.toBeNull()
      expect((await openOpsItems('telemetry-read')).length).toBe(1)
    } finally {
      await t.client`DROP TRIGGER IF EXISTS ops_test_resolve_reject ON inbox_item`
      await t.client`DROP FUNCTION IF EXISTS ops_test_resolve_reject()`
    }

    const retried = await run({ notify: notify.fn, at: new Date(NOW.getTime() + 60 * MIN) })
    expect(retried.recoveries).toBe(1)
    expect(notify.calls.length).toBe(3)
    expect(notify.calls[2]!.kind).toBe('recovered')
    expect(await kvState('telemetry-read')).toBeNull()
    expect((await openOpsItems('telemetry-read')).length).toBe(0)
  })
})

describe('persisted kv rows are validated before entering the state machine (ar-H9)', () => {
  it('a hostile key and a malformed state never reach ntfy; the rows are removed; the run completes', async () => {
    const notify = mkNotify()
    const hostileKey = 'https://evil.example/leak#topic'
    // A well-FORMED state under a hostile key: without the key guard it would
    // ride the recovery path straight into the public payload.
    const wellFormed = JSON.stringify({
      severity: 'critical',
      activeRuns: 3,
      delivered: true,
      lastSentAtMs: NOW.getTime() - 8 * HOUR,
      clearRuns: 1,
    })
    await t.client`
      INSERT INTO kv_store (mount, key, value, expires_at, updated_at)
      VALUES ('ops-alert', ${hostileKey}, ${wellFormed}, NULL, now())`
    await t.client`
      INSERT INTO kv_store (mount, key, value, expires_at, updated_at)
      VALUES ('ops-alert', 'telemetry-read', '{"severity":"bogus"}', NULL, now())`

    const res = await run({ notify: notify.fn })
    expect(notify.calls.length).toBe(0)
    expect(await kvCount()).toBe(0)
    expect(res.keyErrors).toBe(0)
  })
})

describe('every raised severity carries a reason (D1)', () => {
  it('EVERY condition the evaluator can raise, in one run, names why — none is bare', async () => {
    const notify = mkNotify()
    // Arm all four raisable lanes at once (channel-test is the A7 deploy-time
    // ping and is never raised by this worker — asserted below; inbox-aging was
    // retired with this change).
    const fleet = ['d1-a', 'd1-b', 'd1-c', 'd1-d'].map((name) => ({ name, recommendedCron: '*/15 * * * *' }))
    for (const w of fleet) {
      await insertRun(w.name, 'failure', NOW.getTime() - 10 * MIN)
      await insertRun(w.name, 'failure', NOW.getTime() - 25 * MIN)
    }
    await seedFleetEmit(NOW.getTime() - 10 * MIN)
    for (const agoMin of [5, 35, 65, 95]) {
      await t.client`
        INSERT INTO worker_run (worker_name, status, started_at, finished_at, rows_affected, result)
        VALUES ('azure-monitor-read', 'success',
                ${new Date(NOW.getTime() - agoMin * MIN).toISOString()}::timestamptz,
                ${new Date(NOW.getTime() - agoMin * MIN).toISOString()}::timestamptz,
                0, '{"sessionsProcessed":5,"attributionRowsWritten":0,"errors":0}'::jsonb)
      `
    }
    const res = await run({
      notify: notify.fn,
      telemetry: classifiedFailReader,
      network: async () => netReport([mkNetRecord({ verdict: 'unreachable' })]),
      workers: fleet,
      thresholds: { fleetThreshold: 4 },
    })

    // Every one of the raisable condition SHAPES fired…
    expect(Object.keys(res.conditions).sort()).toEqual(
      [
        'attribution-stall',
        'probe-network',
        'telemetry-read',
        'worker-fleet',
        ...fleet.map((w) => `worker:${w.name}`),
      ].sort(),
    )
    // …and not one recorded a severity without a reason from the closed
    // vocabulary. Drop `reason:` from ANY observations.set call site and this
    // goes red — and in server/ and shared/ it does not even compile.
    for (const [key, observed] of Object.entries(res.conditions)) {
      expect(observed.severity, key).toBeDefined()
      expect(
        isOpsAlertReason(observed.reason),
        `condition '${key}' recorded reason ${JSON.stringify(observed.reason)}`,
      ).toBe(true)
    }
    // The per-condition mapping the design's table specifies.
    expect(res.conditions['telemetry-read']!.reason).toBe('driver-unreachable')
    expect(res.conditions['probe-network']!.reason).toBe('hosts-failing')
    expect(res.conditions['attribution-stall']!.reason).toBe('zero-write-streak')
    expect(res.conditions['worker-fleet']!.reason).toBe('workers-failing')
    expect(res.conditions['worker:d1-a']!.reason).toBe('worker-failing')
    // channel-test is the deploy-time ping, not an evaluator verdict — but its
    // reason is still in the vocabulary, so the A7 sender can name itself.
    expect(res.conditions['channel-test']).toBeUndefined()
    expect(isOpsAlertReason('manual-test')).toBe(true)
  })
})

describe('per-tick notify budget (MAX_NOTIFY_PER_TICK)', () => {
  it('a burst of WARNINGS never consumes the push budget, so it cannot defer a critical', async () => {
    /*
     * What the budget is now for. It caps PUSHES per tick, and warnings do not
     * push — so eleven failing workers cost nothing and the one real critical
     * still goes out on the same tick.
     *
     * The previous version of this case sent 10 and deferred 2 from a mixed
     * pile of warnings and one critical. That was the defect in miniature: a
     * burst of per-worker warnings could exhaust the tick's budget and defer
     * the genuine critical, which is the opposite of what a budget is for.
     */
    const notify = mkNotify()
    const fleet = Array.from({ length: 11 }, (_, i) => ({
      name: `bud-${String(i).padStart(2, '0')}`,
      recommendedCron: '*/15 * * * *',
    }))
    for (const w of fleet) {
      await insertRun(w.name, 'failure', NOW.getTime() - 10 * MIN)
      await insertRun(w.name, 'failure', NOW.getTime() - 25 * MIN)
    }

    // Tick 1: 11 per-worker warnings + the telemetry critical, all two-run
    // damped (D3) — nothing sends.
    const over = {
      notify: notify.fn,
      workers: fleet,
      telemetry: failReader,
      thresholds: { fleetThreshold: 99 },
    }
    const res1 = await run(over)
    expect(res1.sent).toBe(0)
    expect(notify.calls.length).toBe(0)

    // Tick 2: all twelve are due. One pushes; eleven are announced silently.
    const res2 = await run({ ...over, at: new Date(NOW.getTime() + 15 * MIN) })
    expect(res2.sent, 'the critical went out').toBe(1)
    expect(res2.suppressed, 'the eleven warnings were announced, not pushed').toBe(11)
    expect(res2.notifyDeferred, 'nothing was deferred — warnings cost no budget').toBe(0)
    expect(notify.calls.length).toBe(1)
    expect(notify.calls[0]!.payload.condition).toBe('telemetry-read')
    expect(await kvState('telemetry-read')).toMatchObject({ delivered: true })
  })
})

describe('an indeterminate lane freezes its keys (A3)', () => {
  it('a stall-lane failure leaves the active attribution-stall key untouched: no reminder, no recovery, no persist', async () => {
    const notify = mkNotify()
    await seedFleetEmit(NOW.getTime() - 10 * MIN)
    for (const agoMin of [5, 35, 65, 95]) {
      await t.client`
        INSERT INTO worker_run (worker_name, status, started_at, finished_at, rows_affected, result)
        VALUES ('azure-monitor-read', 'success',
                ${new Date(NOW.getTime() - agoMin * MIN).toISOString()}::timestamptz,
                ${new Date(NOW.getTime() - agoMin * MIN).toISOString()}::timestamptz,
                0, '{"sessionsProcessed":5,"attributionRowsWritten":0,"errors":0}'::jsonb)
      `
    }

    // Ticks 1-2: a real stall — armed, then delivered critical (D3), state persisted.
    const res1 = await armAndPage({ notify: notify.fn })
    expect(res1.sent).toBe(1)
    const stateAfterDelivery = await kvState('attribution-stall')
    expect(stateAfterDelivery).toMatchObject({ delivered: true })

    // A later tick, 7 h after delivery: the reminder would be due AND a clear
    // reading would start recovery — but the lane cannot produce a verdict, so
    // the key must neither age nor clear.
    const res2 = await run({
      notify: notify.fn,
      at: new Date(NOW.getTime() + 15 * MIN + 7 * HOUR),
      stallLoaders: {
        readerRuns: async () => {
          throw new Error('injected stall-lane failure')
        },
      },
    })
    expect(res2.indeterminate).toContain('stall')
    expect(res2.sent).toBe(0)
    expect(res2.reminders).toBe(0)
    expect(res2.recoveries).toBe(0)
    expect(res2.statesPersisted).toBe(0)
    expect(res2.statesDeleted).toBe(0)
    expect(notify.calls.length).toBe(1)
    expect(await kvState('attribution-stall')).toEqual(stateAfterDelivery)
  })
})
