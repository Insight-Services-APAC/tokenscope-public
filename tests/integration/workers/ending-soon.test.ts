// @vitest-environment node
/*
 * Ending-soon worker (D3): warns devs assigned to a project entering its
 * end_date warning window (platform default 7 days), one inbox item per
 * (dev, project), deduped, and ignores projects whose end is far out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { runEndingSoon } from '../../../server/workers/ending-soon'

let t: TestDb
let devId: string
let regionId: string
let ouId: string
let soonId: string

const DAY = 86_400_000

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'es-r', displayName: 'ES R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'es.svc', code: 'es-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [dev] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-es-dev', email: 'es-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  devId = dev!.id

  // Ending in 3 days → inside the 7-day platform window.
  const [soon] = await t.db
    .insert(schema.project)
    .values({ code: 'ES-SOON', codeHash: 'h-es-soon', displayName: 'Soon', type: 'billable', regionId, costOwningUnitId: ouId, endDate: new Date(Date.now() + 3 * DAY) })
    .returning()
  soonId = soon!.id
  // Ending in 30 days → outside the window.
  const [far] = await t.db
    .insert(schema.project)
    .values({ code: 'ES-FAR', codeHash: 'h-es-far', displayName: 'Far', type: 'billable', regionId, costOwningUnitId: ouId, endDate: new Date(Date.now() + 30 * DAY) })
    .returning()
  for (const pid of [soonId, far!.id]) {
    await t.client.unsafe(`INSERT INTO project_assignment (project_id, teammate_id, effective) VALUES ('${pid}','${devId}','[2026-01-01,2099-01-01)'::tstzrange)`)
  }
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('runEndingSoon', () => {
  it('warns the assigned dev for the in-window project only, then dedups', async () => {
    const res1 = await runEndingSoon(t.db)
    expect(res1.projectsInWindow).toBe(1)
    expect(res1.warningsDispatched).toBe(1)

    const items = await t.client<{ n: string; rel: string | null }[]>`
      SELECT COUNT(*)::text AS n, MAX(related_entity_id::text) AS rel
      FROM inbox_item WHERE category = 'project-ending-soon'`
    expect(Number(items[0]!.n)).toBe(1)
    expect(items[0]!.rel).toBe(soonId)

    // Second run: the live item dedups — no new dispatch.
    const res2 = await runEndingSoon(t.db)
    expect(res2.warningsDispatched).toBe(0)
    expect(res2.skippedExisting).toBe(1)
    const after = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM inbox_item WHERE category = 'project-ending-soon'`
    expect(Number(after[0]!.n)).toBe(1)
  })
})
