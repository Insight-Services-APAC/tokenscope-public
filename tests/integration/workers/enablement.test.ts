// @vitest-environment node
/*
 * worker_enablement — the admin kill-switch (mig 0090).
 *
 * Activation used to be an infra-only lever (edit bicep, redeploy). These pin the
 * contract that makes it a runtime, audited, product decision:
 *   - ABSENT ROW = ENABLED, so upgrading changes nothing and a dropped table
 *     degrades to "everything runs" rather than a silent fleet-wide stop;
 *   - a disabled worker does NOT run but DOES leave a 'skipped' worker_run, so the
 *     ledger shows why — a silent gap is indistinguishable from the
 *     never-scheduled trap this whole epic closed;
 *   - 'skipped' is not 'success' (read-path-health treats a recent success as
 *     evidence the read path is alive);
 *   - the check FAILS OPEN.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { isWorkerEnabled, setWorkerEnabled, listWorkerEnablement } from '../../../server/workers/enablement'
import { dispatchWorker } from '../../../server/workers/dispatch'
import type { WorkerEntry } from '../../../server/workers/registry'

let t: TestDb
let adminId: string

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.client.unsafe(
    `INSERT INTO region (code, display_name) VALUES ('we', 'WE') RETURNING id`,
  )
  const regionId = (r as { id: string }).id
  const [o] = await t.client.unsafe(
    `INSERT INTO org_unit (region_id, path, code, display_name, unit_type)
     VALUES ('${regionId}', 'we.svc'::ltree, 'we-svc', 'WE Svc', 'bu') RETURNING id`,
  )
  const ouId = (o as { id: string }).id
  const [a] = await t.client.unsafe(
    `INSERT INTO teammate (entra_oid, email, region_id, org_unit_id, role)
     VALUES ('oid-we-admin', 'we-admin@x.test', '${regionId}', '${ouId}', 'admin') RETURNING id`,
  )
  adminId = (a as { id: string }).id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(async () => {
  await t.client.unsafe(`DELETE FROM worker_enablement WHERE worker_name LIKE 'test-%'`)
})

/**
 * A trivial worker entry that records whether it actually ran. Satisfies WorkerEntry
 * STRUCTURALLY (no cast): an `as unknown as` here would hide real interface drift —
 * the registry could grow a required field and this would still compile while the
 * thing under test no longer resembles a real worker.
 */
function probeEntry(name: string, ran: { value: boolean }): WorkerEntry {
  return {
    name,
    run: async () => {
      ran.value = true
      return { ok: true }
    },
    recommendedCron: '*/5 * * * *',
    description: 'test probe',
  }
}

describe('worker enablement contract', () => {
  it('ABSENT ROW means ENABLED (upgrade-safe default)', async () => {
    expect(await isWorkerEnabled(t.db, `test-never-configured-${randomUUID().slice(0, 8)}`)).toBe(true)
  })

  it('the seeded heartbeat-coverage row ships DISABLED', async () => {
    // Shipped off on purpose: its false-positive rate has never been measured and
    // backfilled spend reads as uncovered. An admin turns it on after looking.
    expect(await isWorkerEnabled(t.db, 'heartbeat-coverage')).toBe(false)
  })

  it('setWorkerEnabled toggles both ways and stamps who/when', async () => {
    const name = 'test-toggle'
    await setWorkerEnabled(t.db, { workerName: name, enabled: false, reason: 'noisy', updatedBy: adminId })
    expect(await isWorkerEnabled(t.db, name)).toBe(false)
    const off = (await listWorkerEnablement(t.db)).find((r) => r.workerName === name)
    expect(off?.reason).toBe('noisy')
    expect(off?.updatedBy).toBe(adminId)
    expect(off?.updatedAt).toBeTruthy()

    // Re-enabling clears the reason — it described why it was OFF.
    await setWorkerEnabled(t.db, { workerName: name, enabled: true, updatedBy: adminId })
    expect(await isWorkerEnabled(t.db, name)).toBe(true)
    expect((await listWorkerEnablement(t.db)).find((r) => r.workerName === name)?.reason).toBeNull()
  })
})

describe('the check FAILS OPEN', () => {
  it('a broken enablement lookup lets the worker RUN', async () => {
    // A check whose failure silently stops the fleet is a worse outage than the one
    // it guards against — and "worker quietly stopped running" is exactly the class
    // this codebase keeps getting burned by. Simulate an unreadable table.
    const broken = {
      execute: async () => {
        throw new Error('relation "worker_enablement" does not exist')
      },
    } as unknown as Parameters<typeof isWorkerEnabled>[0]
    expect(await isWorkerEnabled(broken, 'anything')).toBe(true)
  })
})

describe('dispatchWorker honours the kill-switch', () => {
  it('an ENABLED worker runs normally', async () => {
    const ran = { value: false }
    const name = 'test-enabled'
    const res = await dispatchWorker(t.db, probeEntry(name, ran))
    expect(ran.value).toBe(true)
    expect(res.skipped).toBeFalsy()
  })

  it('a DISABLED worker does NOT run, and records a skipped run (not a silent gap)', async () => {
    const ran = { value: false }
    const name = 'test-disabled'
    await setWorkerEnabled(t.db, { workerName: name, enabled: false, reason: 'under review', updatedBy: adminId })

    const res = await dispatchWorker(t.db, probeEntry(name, ran))
    expect(ran.value).toBe(false) // the worker body never executed
    expect(res.skipped).toBe(true)

    const rows = await t.client<{ status: string }[]>`
      SELECT status FROM worker_run WHERE worker_name = ${name} ORDER BY started_at DESC LIMIT 1`
    // 'skipped', deliberately NOT 'success': read-path-health reads a recent
    // success as "the path is alive", so a disabled worker must not mask an outage.
    expect(rows[0]!.status).toBe('skipped')
  })

  it('re-enabling takes effect on the very next dispatch (no deploy)', async () => {
    const name = 'test-reenable'
    await setWorkerEnabled(t.db, { workerName: name, enabled: false, reason: 'x', updatedBy: adminId })
    const first = { value: false }
    await dispatchWorker(t.db, probeEntry(name, first))
    expect(first.value).toBe(false)

    await setWorkerEnabled(t.db, { workerName: name, enabled: true, updatedBy: adminId })
    const second = { value: false }
    await dispatchWorker(t.db, probeEntry(name, second))
    expect(second.value).toBe(true)
  })
})
