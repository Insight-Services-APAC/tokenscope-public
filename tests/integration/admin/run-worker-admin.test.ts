// @vitest-environment node
/*
 * POST /admin/workers/[name]/run — the admin-authed "Run now" trigger. This is the
 * NEW auth surface (the shared dispatch core is covered by
 * tests/integration/workers/dispatch-worker.test.ts); here we pin the endpoint's
 * gate + attribution, invoking the real handler against testcontainers Postgres:
 *   - a non-admin (developer) is rejected 403 and nothing runs;
 *   - a cross-origin POST is rejected (CSRF), nothing runs;
 *   - an un-safelisted worker 404s (not 403) and is never dispatched/audited;
 *   - happy path: a safelisted worker dispatches, returns its result, and the
 *     trigger is audited with the actor teammate + source IP;
 *   - a concurrent-run 409 still records the "attempted" audit (audit-intent-first,
 *     fail-closed) but writes NO new worker_run row.
 *
 * identity-sync is the happy-path worker: with zero reconciled enterprises it is a
 * pure SELECT no-op (no GitHub client, no external calls), so it always succeeds.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession, type Session } from '../../helpers/auth'
import runWorker from '../../../server/api/v1/admin/workers/[name]/run.post'
import { acquireWorkerDispatchLock } from '../../../server/workers/dispatch-lock'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId = ''
let ouId = ''
let adminId = ''
let devId = ''

function ev(opts: { session: Session; name: string; origin?: string }) {
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: opts.origin ?? 'http://localhost:3450',
    'content-type': 'application/json',
    'user-agent': 'vitest-agent',
  }
  const e = {
    method: 'POST',
    path: '/x',
    context: { params: { name: opts.name } },
    node: {
      req: { method: 'POST', url: '/x', socket: { remoteAddress: '10.1.2.3' }, get headers() { return headers } },
      res: {
        _headers: {} as Record<string, string | string[]>, statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof runWorker>[0]
}
const admin = (): Session => ({ teammateId: adminId, email: 'a@x.test', displayName: 'A', role: 'global-finops', regionId, orgPath: 'd.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'd@x.test', displayName: 'D', role: 'developer', regionId, orgPath: 'd.svc' })
// A region-scoped `admin` — NOT allowed: every safelisted worker is global.
const regionAdmin = (): Session => ({ teammateId: devId, email: 'ra@x.test', displayName: 'RA', role: 'admin', regionId, orgPath: 'd.svc' })

// audit_event is APPEND-ONLY (DELETE is trigger-denied), so beforeEach can't clear
// it — assert on the DELTA/newest row instead of an absolute count.
async function auditRows() {
  return t.client<{ actor_teammate_id: string | null; ip_address: string | null; payload: Record<string, unknown> }[]>`
    SELECT actor_teammate_id::text AS actor_teammate_id, ip_address::text AS ip_address, payload
    FROM audit_event WHERE event_type = 'admin-run-worker' ORDER BY ts_recorded ASC`
}
async function auditCount() {
  const [row] = await t.client<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'admin-run-worker'`
  return row!.n
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'w-r', displayName: 'W R' }).returning()
  regionId = r!.id
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'd.svc', code: 'd-svc', displayName: 'Svc', unitType: 'bu' }).returning()
  ouId = o!.id
  const [a] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-w-a', email: 'a@x.test', role: 'global-finops', regionId, orgUnitId: ouId }).returning()
  adminId = a!.id
  const [d] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-w-d', email: 'd@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  devId = d!.id
}, 180_000)

afterAll(async () => { await stopTestDb(t) }, 30_000)

beforeEach(async () => {
  // worker_run is operational (deletable); audit_event is append-only → delta-check.
  await t.client`DELETE FROM worker_run`
})

describe('POST /admin/workers/[name]/run', () => {
  it('a non-admin (developer) is rejected 403 and nothing runs', async () => {
    const n0 = await auditCount()
    await expect(runWorker(ev({ session: dev(), name: 'identity-sync' }))).rejects.toMatchObject({ statusCode: 403 })
    expect(await auditCount()).toBe(n0)
    expect((await t.client`SELECT id FROM worker_run`).length).toBe(0)
  })

  it('a region-scoped admin is rejected 403 (workers are global, global-finops only)', async () => {
    const n0 = await auditCount()
    await expect(runWorker(ev({ session: regionAdmin(), name: 'identity-sync' }))).rejects.toMatchObject({ statusCode: 403 })
    expect(await auditCount()).toBe(n0)
    expect((await t.client`SELECT id FROM worker_run`).length).toBe(0)
  })

  it('a cross-origin POST is rejected (CSRF) and nothing runs', async () => {
    const n0 = await auditCount()
    await expect(
      runWorker(ev({ session: admin(), name: 'identity-sync', origin: 'http://evil.test' })),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(await auditCount()).toBe(n0)
    expect((await t.client`SELECT id FROM worker_run`).length).toBe(0)
  })

  it('an un-safelisted worker 404s (not 403) and is never audited/dispatched', async () => {
    const n0 = await auditCount()
    await expect(runWorker(ev({ session: admin(), name: 'soft-purge' }))).rejects.toMatchObject({ statusCode: 404 })
    expect(await auditCount()).toBe(n0)
    expect((await t.client`SELECT id FROM worker_run`).length).toBe(0)
  })

  it('happy path: dispatches a safelisted worker, returns its result, audits actor + ip', async () => {
    const n0 = await auditCount()
    const out = (await runWorker(ev({ session: admin(), name: 'identity-sync' }))) as { worker: string; duration_ms: number }
    expect(out.worker).toBe('identity-sync')
    expect(typeof out.duration_ms).toBe('number')

    const audits = await auditRows()
    expect(audits.length).toBe(n0 + 1)
    const latest = audits[audits.length - 1]!
    expect(latest.actor_teammate_id).toBe(adminId)
    expect(latest.ip_address).toContain('10.1.2.3')
    expect(latest.payload).toMatchObject({ worker: 'identity-sync', trigger: 'ui' })

    const runs = await t.client<{ status: string }[]>`SELECT status FROM worker_run WHERE worker_name = 'identity-sync'`
    expect(runs[0]?.status).toBe('success')
  })

  it('lock held: returns 409 (attempt still audited, no new worker_run row)', async () => {
    const n0 = await auditCount()
    const held = await acquireWorkerDispatchLock(t.db, 'identity-sync')
    expect(held.acquired).toBe(true)
    try {
      await expect(runWorker(ev({ session: admin(), name: 'identity-sync' }))).rejects.toMatchObject({ statusCode: 409 })
    } finally {
      await held.release()
    }
    // audit-intent-first: the attempt is recorded even though the dispatch 409'd...
    expect(await auditCount()).toBe(n0 + 1)
    // ...but the blocked dispatch wrote no worker_run row.
    expect((await t.client`SELECT id FROM worker_run WHERE worker_name = 'identity-sync'`).length).toBe(0)
  })
})
