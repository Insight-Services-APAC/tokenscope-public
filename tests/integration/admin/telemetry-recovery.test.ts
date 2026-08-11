// @vitest-environment node
/*
 * The widened-read recovery lever (mig 0093): admin enqueues → the
 * telemetry-recovery worker drains it in resumable slices.
 *
 * WHAT MUST NOT REGRESS, in order of consequence:
 *   1. the widened window actually REACHES the reader. A recovery that silently
 *      applies 7 days while reporting success is the exact failure this feature
 *      exists to remove, and it is invisible from row counts alone.
 *   2. deepRescan is always paired with it. Without it the per-instance watermark
 *      bounds the widened read to almost nothing while every progress field reads
 *      green.
 *   3. the drain RESUMES rather than restarting or stalling — a 90-day read
 *      cannot be served inside the ~120s worker gateway, so resumability is the
 *      whole reason this is a queue.
 *   4. RBAC + same-origin + audit on the enqueue.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import type { TelemetryReader, UsageRecord } from '../../../server/azure/reader'
import { runTelemetryRecovery, RECOVERY_CHUNK_INSTANCES } from '../../../server/workers/telemetry-recovery'
import recoveryPost from '../../../server/api/v1/admin/diagnostics/telemetry-recovery.post'
import recoveryGet from '../../../server/api/v1/admin/diagnostics/telemetry-recovery.get'

let t: TestDb
let regionId: string
let ouId: string
let finopsId: string
let adminId: string
let devId: string

function ev(opts: { method: string; body?: unknown; session: Session; query?: Record<string, string>; origin?: string }) {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
  // Origin is baked in at construction: the headers getter below returns a fresh
  // object per read, so mutating a returned copy would silently do nothing and the
  // CSRF test would pass vacuously against a same-origin request.
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: opts.origin ?? 'http://localhost:3450',
  }
  const e = {
    method: opts.method,
    path: `/x${qs}`,
    context: { params: {} },
    node: {
      req: {
        method: opts.method,
        url: `/x${qs}`,
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() { return { ...headers, 'content-type': 'application/json' } },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof recoveryPost>[0]
}

const finops = (): Session => ({ teammateId: finopsId, email: 'tr-fin@x.test', displayName: 'Fin', role: 'global-finops', regionId, orgPath: 'tr.svc' })
const admin = (): Session => ({ teammateId: adminId, email: 'tr-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'tr.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'tr-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'tr.svc' })

/**
 * Records what the worker asked for. `appliedLookbackDays` mirrors the real
 * reader's contract (the window it ACTUALLY applies), so the test can distinguish
 * "asked for 60" from "applied 60" — which is precisely the distinction a silent
 * narrowing destroys.
 */
class SpyReader implements TelemetryReader {
  calls: Array<{ instanceId: string; since: Date | undefined }> = []
  constructor(readonly appliedLookbackDays: number) {}
  async getSessionUsage(instanceId: string, since?: Date): Promise<UsageRecord[]> {
    this.calls.push({ instanceId, since })
    return []
  }
  async listSessions() { return [] }
  async healthCheck() { return { ok: true, kind: 'local' as const, latencyMs: 0 } }
}

let readers: SpyReader[] = []
function spyFactory() {
  return (lookbackDays: number) => {
    const r = new SpyReader(lookbackDays)
    readers.push(r)
    return r
  }
}

async function enrol(): Promise<string> {
  const instanceId = randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
       tool, ts_start, last_bearer_at, attestation_state, region_id, org_unit_id, cost_owning_unit_id)
    VALUES ('${instanceId}','oid-tr','tr-dev@x.test','${devId}','h-tr','TR',
       'claude-code', NOW() - INTERVAL '60 days', NOW(), 'attested','${regionId}','${ouId}','${ouId}')`)
  return instanceId
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'tr-r', displayName: 'TR' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'tr.svc', code: 'tr-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = o!.id
  const [f] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-tr-fin', email: 'tr-fin@x.test', role: 'global-finops', regionId, orgUnitId: ouId }).returning()
  finopsId = f!.id
  const [a] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-tr-admin', email: 'tr-admin@x.test', role: 'admin', regionId, orgUnitId: ouId }).returning()
  adminId = a!.id
  const [d] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-tr-dev', email: 'tr-dev@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  devId = d!.id
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM telemetry_recovery_request`
  readers = []
})

describe('enqueue endpoint — RBAC and validation', () => {
  it('global-finops enqueues a scoped, widened recovery', async () => {
    const id = await enrol()
    const res = (await recoveryPost(
      ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 60, reason: 'dead-zone backlog' } }),
    )) as { id: string; status: string; instanceCount: number; lookbackDays: number }
    expect(res.status).toBe('pending')
    expect(res.instanceCount).toBe(1)
    expect(res.lookbackDays).toBe(60)
    const [row] = await t.client<{
      id: string
      status: string
      lookback_days: number
      reason: string
      requested_by: string
      instance_ids: string[]
    }[]>`
      SELECT id::text AS id, status, lookback_days, reason,
             requested_by::text AS requested_by, instance_ids::text[] AS instance_ids
        FROM telemetry_recovery_request`
    expect(row!.lookback_days).toBe(60)
    expect(row!.reason).toBe('dead-zone backlog')
    // The row records WHO asked and for WHICH devices. A recovery spends real
    // query budget and rewrites the ledger; an unattributed one, or one whose
    // recorded scope differs from what was asked for, is not auditable afterwards.
    expect(row!.requested_by).toBe(finopsId)
    expect(row!.instance_ids).toEqual([id])
    // The caller is handed the id it must poll, not just a 2xx.
    expect(res.id).toBe(row!.id)
    // And the response must not let 'accepted' be read as 'recovered' — the whole
    // bug class this feature removes is a 2xx taken for completed work.
    expect((res as unknown as { note: string }).note).toMatch(/not mean recovered/i)
  })

  it('REJECTS a developer', async () => {
    const id = await enrol()
    await expect(
      recoveryPost(ev({ method: 'POST', session: dev(), body: { instanceIds: [id], lookbackDays: 30 } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('REJECTS a region-scoped admin — a recovery is not region-bounded and spends query budget', async () => {
    const id = await enrol()
    await expect(
      recoveryPost(ev({ method: 'POST', session: admin(), body: { instanceIds: [id], lookbackDays: 30 } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects a cross-origin write (CSRF)', async () => {
    const id = await enrol()
    const e = ev({
      method: 'POST',
      session: finops(),
      origin: 'http://evil.test',
      body: { instanceIds: [id], lookbackDays: 30 },
    })
    await expect(recoveryPost(e)).rejects.toMatchObject({ statusCode: 403 })
    // …and nothing was enqueued by the rejected request.
    expect(await t.client`SELECT id FROM telemetry_recovery_request`).toHaveLength(0)
  })

  it('rejects a lookback beyond the retention ceiling', async () => {
    const id = await enrol()
    await expect(
      recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 91 } })),
    ).rejects.toBeTruthy()
  })

  it('rejects an UNSCOPED request — there is no fleet-wide widened read', async () => {
    await expect(
      recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [], lookbackDays: 30 } })),
    ).rejects.toBeTruthy()
  })

  it('rejects unknown instance ids instead of accepting a request that can recover nothing', async () => {
    // The joiner silently skips ids it cannot resolve, so a typo would run to
    // 'succeeded' having read nothing — the false-green this feature removes.
    const good = await enrol()
    await expect(
      recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [good, randomUUID()], lookbackDays: 30 } })),
    ).rejects.toMatchObject({ statusCode: 400 })
    const rows = await t.client`SELECT id FROM telemetry_recovery_request`
    expect(rows).toHaveLength(0)
  })

  it('de-duplicates instance ids so the progress figure cannot overstate coverage', async () => {
    const id = await enrol()
    const res = (await recoveryPost(
      ev({ method: 'POST', session: finops(), body: { instanceIds: [id, id, id], lookbackDays: 30 } }),
    )) as { instanceCount: number }
    expect(res.instanceCount).toBe(1)
  })

  it('409s a second recovery while one is in flight', async () => {
    const id = await enrol()
    await recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 30 } }))
    await expect(
      recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 30 } })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('the DB backstop for that check actually exists (the pre-check alone is a TOCTOU)', async () => {
    // The endpoint's SELECT-then-INSERT is racy by construction, and the handler
    // says the partial unique index is the real guard. That claim is only worth
    // making if the constraint fires — asserted directly, since two concurrent
    // POSTs cannot be reliably staged from a test.
    const id = await enrol()
    await recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 30 } }))
    await expect(
      t.client`INSERT INTO telemetry_recovery_request (instance_ids, lookback_days)
               VALUES (ARRAY[${id}::uuid], 30)`,
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('a FINISHED recovery does not block the next one', async () => {
    // The partial predicate is what stops one campaign wedging recovery forever.
    // If it ever widened to all statuses, the first successful run would be the
    // last recovery this deployment could ever perform.
    const id = await enrol()
    await recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 30 } }))
    await t.client`UPDATE telemetry_recovery_request SET status = 'succeeded', finished_at = now()`
    const again = (await recoveryPost(
      ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 30 } }),
    )) as { status: string }
    expect(again.status).toBe('pending')
  })

  it('audits the enqueue with the scope and window', async () => {
    const id = await enrol()
    await recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 45, reason: 'why' } }))
    const [audit] = await t.client<{ event_type: string; payload: Record<string, unknown>; actor_teammate_id: string; subject_kind: string; subject_id: string }[]>`
      SELECT event_type, payload, actor_teammate_id::text AS actor_teammate_id,
             subject_kind, subject_id::text AS subject_id
        FROM audit_event WHERE event_type = 'telemetry-recovery-requested' ORDER BY ts_recorded DESC LIMIT 1`
    expect(audit!.actor_teammate_id).toBe(finopsId)
    expect(audit!.payload.lookback_days).toBe(45)
    expect(audit!.payload.instance_count).toBe(1)
    expect(audit!.payload.reason).toBe('why')
    // The SCOPE, not just its size: "someone re-read 1 device at 45 days" is not
    // an audit trail — which device is the whole question afterwards.
    expect(audit!.payload.instance_ids).toEqual([id])
    // And the row it refers to, so the audit event and the request are joinable.
    const [req] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM telemetry_recovery_request`
    expect(audit!.subject_kind).toBe('telemetry-recovery')
    expect(audit!.subject_id).toBe(req!.id)
  })
})

describe('the drain worker', () => {
  it('is a clean no-op when the queue is empty', async () => {
    // The WHOLE shape, not just claimed/status: this result lands in
    // worker_run.result and a consumer reading rowsWritten must get 0, not
    // undefined. It runs every 5 minutes with an empty queue, so it is by far the
    // most common result this worker produces.
    const res = await runTelemetryRecovery(t.db, { readerFor: spyFactory() })
    expect(res).toEqual({
      claimed: 0,
      requestId: null,
      status: null,
      instancesProcessed: 0,
      rowsWritten: 0,
      errors: 0,
      lookbackDaysApplied: null,
    })
    expect(readers, 'an empty queue must not build a reader or query Azure').toHaveLength(0)
  })

  it('applies the REQUESTED window — not the reader default', async () => {
    // The single most important assertion in this file. A run that quietly used 7
    // days would still process every instance, still return 'succeeded', and still
    // look identical in every count.
    const id = await enrol()
    await recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 60 } }))
    const res = await runTelemetryRecovery(t.db, { readerFor: spyFactory() })
    expect(res.status).toBe('succeeded')
    expect(readers.every((r) => r.appliedLookbackDays === 60)).toBe(true)
    // Reported from the reader, so a future drift between asked and applied
    // surfaces here rather than being restated from the request row.
    expect(res.lookbackDaysApplied).toBe(60)
  })

  it('always pairs the widened read with a deep re-scan (no watermark)', async () => {
    // Without deepRescan the per-instance watermark bounds the read to events
    // newer than the last attributed one — post-deploy that is already fresh, so
    // a 90-day query returns almost nothing while every field reads green.
    const id = await enrol()
    await t.db.insert(schema.attributionRecord).values({
      instanceId: id,
      teammateId: devId,
      regionId,
      orgUnitId: ouId,
      costOwningUnitId: ouId,
      tool: 'claude-code',
      model: 'claude-sonnet-4-7',
      tokenType: 'input',
      tokens: 100n,
      costUsd: '0.01',
      fidelityTier: 'tier-2',
      costBasis: 'telemetry-only',
      tsEvent: new Date(), // a FRESH watermark — the trap
    })
    await recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 90 } }))
    await runTelemetryRecovery(t.db, { readerFor: spyFactory() })
    const call = readers.flatMap((r) => r.calls).find((c) => c.instanceId === id)
    expect(call, 'the instance should have been read').toBeTruthy()
    expect(call!.since, 'a watermark here would silently bound the widened read').toBeUndefined()
  })

  it('RESUMES from the cursor when the budget runs out mid-campaign', async () => {
    // The reason this is a queue at all: a 90-day read across a set of instances
    // cannot be served inside the ~120s worker gateway.
    const ids: string[] = []
    for (let i = 0; i < RECOVERY_CHUNK_INSTANCES * 2 + 1; i++) ids.push(await enrol())
    await recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: ids, lookbackDays: 30 } }))

    // budgetMs 0 → the post-slice check trips immediately, so exactly ONE slice
    // runs per invocation. (The check is AFTER a slice by design: a claim must
    // always make progress, or a slow claim livelocks.)
    const first = await runTelemetryRecovery(t.db, { budgetMs: 0, readerFor: spyFactory() })
    expect(first.status).toBe('running')
    expect(first.instancesProcessed).toBe(RECOVERY_CHUNK_INSTANCES)

    const second = await runTelemetryRecovery(t.db, { budgetMs: 0, readerFor: spyFactory() })
    expect(second.status).toBe('running')
    expect(second.requestId).toBe(first.requestId) // continued, not a new claim

    const third = await runTelemetryRecovery(t.db, { budgetMs: 0, readerFor: spyFactory() })
    expect(third.status).toBe('succeeded')

    // Every instance read exactly once across the campaign: no restart, no skip.
    const readIds = readers.flatMap((r) => r.calls).map((c) => c.instanceId)
    expect(readIds.sort()).toEqual([...ids].sort())
  })

  it('advances the cursor past an instance the joiner SKIPS, so a campaign always terminates', async () => {
    // The joiner applies its own gates (purged, revoked teammate). Advancing by
    // sessionsProcessed rather than by slice size would park the cursor on a
    // skipped id forever — a campaign that never finishes.
    const skipped = await enrol()
    await t.client.unsafe(`UPDATE instance_attestation SET ts_purged = NOW() WHERE instance_id = '${skipped}'`)
    await recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [skipped], lookbackDays: 30 } }))
    const res = await runTelemetryRecovery(t.db, { readerFor: spyFactory() })
    expect(res.status).toBe('succeeded')
    expect(res.instancesProcessed).toBe(1)
  })

  it('records a failure on the row rather than throwing into the dispatcher', async () => {
    const id = await enrol()
    await recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 30 } }))
    const res = await runTelemetryRecovery(t.db, {
      readerFor: () => {
        throw new Error('reader exploded')
      },
    })
    expect(res.status).toBe('failed')
    const [row] = await t.client<{ status: string; error: string }[]>`
      SELECT status, error FROM telemetry_recovery_request`
    expect(row!.status).toBe('failed')
    expect(row!.error).toContain('reader exploded')
    // A failed request must free the queue, or one bad run wedges recovery forever.
    const again = await recoveryPost(
      ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 30 } }),
    )
    expect(again).toBeTruthy()
  })

  it('a crashed "running" claim is re-claimed and continued on the next tick', async () => {
    const ids = [await enrol(), await enrol()]
    await recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: ids, lookbackDays: 30 } }))
    // Simulate a hard crash mid-campaign: status left 'running', cursor at 1.
    await t.client`UPDATE telemetry_recovery_request SET status = 'running', cursor_index = 1`
    const res = await runTelemetryRecovery(t.db, { readerFor: spyFactory() })
    expect(res.status).toBe('succeeded')
    // Only the REMAINING instance was re-read — the cursor was honoured.
    expect(readers.flatMap((r) => r.calls).map((c) => c.instanceId)).toEqual([ids[1]])
  })
})

describe('status endpoint', () => {
  it('reports progress and outcome SEPARATELY (100% processed with 0 rows is a real result)', async () => {
    const id = await enrol()
    await recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 30 } }))
    await runTelemetryRecovery(t.db, { readerFor: spyFactory() })
    const res = (await recoveryGet(ev({ method: 'GET', session: admin() }))) as {
      requests: Array<{ status: string; percentComplete: number; rowsWritten: number; instanceCount: number }>
      inFlight: boolean
    }
    expect(res.requests[0]!.status).toBe('succeeded')
    expect(res.requests[0]!.percentComplete).toBe(100)
    expect(res.requests[0]!.rowsWritten).toBe(0) // the stub reader returned no usage
    expect(res.inFlight).toBe(false)
  })

  it('flags an in-flight recovery so the UI can withhold a second enqueue', async () => {
    const id = await enrol()
    await recoveryPost(ev({ method: 'POST', session: finops(), body: { instanceIds: [id], lookbackDays: 30 } }))
    const res = (await recoveryGet(ev({ method: 'GET', session: admin() }))) as { inFlight: boolean }
    expect(res.inFlight).toBe(true)
  })

  it('REJECTS a developer', async () => {
    await expect(recoveryGet(ev({ method: 'GET', session: dev() }))).rejects.toMatchObject({ statusCode: 403 })
  })
})
