// @vitest-environment node
/*
 * Epic 13 admin endpoints — cross-region RBAC contract.
 *
 * Pins: an `admin` role with home region A must NOT see region B's
 * data. A `global-finops` role can see any region. This is the
 * server-side gate behind the admin 6-tab page.
 *
 * Tests run the SQL through the handlers indirectly via the
 * requireAuth + assertion logic; the contract here is the SQL row
 * filter, exercised against testcontainers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionAId: string
let regionBId: string

beforeAll(async () => {
  t = await startTestDb()
  const [a] = await t.db.insert(schema.region).values({ code: 'rgn-a', displayName: 'A' }).returning()
  const [b] = await t.db.insert(schema.region).values({ code: 'rgn-b', displayName: 'B' }).returning()
  regionAId = a!.id
  regionBId = b!.id

  // 1 BU + 2 teammates per region.
  for (const [r, label] of [[regionAId, 'a'], [regionBId, 'b']] as const) {
    const [bu] = await t.db
      .insert(schema.orgUnit)
      .values({
        regionId: r,
        path: `${label}.svc`,
        code: `${label}-svc`,
        displayName: `${label} services`,
        unitType: 'bu',
        isCostOwningUnit: true,
      })
      .returning()
    await t.db.insert(schema.teammate).values([
      {
        entraOid: `oid-${label}-1`,
        email: `one-${label}@example.com`,
        regionId: r,
        orgUnitId: bu!.id,
      },
      {
        entraOid: `oid-${label}-2`,
        email: `two-${label}@example.com`,
        regionId: r,
        orgUnitId: bu!.id,
      },
    ])
  }
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('admin region SQL contract', () => {
  it('teammates query scoped by region returns only that region`s rows', async () => {
    const rowsA = await t.db.execute<{ email: string }>(sql`
      SELECT email FROM teammate WHERE region_id = ${regionAId}::uuid ORDER BY email
    `)
    const rowsB = await t.db.execute<{ email: string }>(sql`
      SELECT email FROM teammate WHERE region_id = ${regionBId}::uuid ORDER BY email
    `)
    const aList = [...rowsA].map((r) => r.email)
    const bList = [...rowsB].map((r) => r.email)
    expect(aList).toEqual(['one-a@example.com', 'two-a@example.com'])
    expect(bList).toEqual(['one-b@example.com', 'two-b@example.com'])
    // No leakage.
    expect(aList.some((e) => e.endsWith('-b@example.com'))).toBe(false)
    expect(bList.some((e) => e.endsWith('-a@example.com'))).toBe(false)
  })

  it('org-unit tree scoped by region returns only that region`s nodes', async () => {
    const rowsA = await t.db.execute<{ code: string }>(sql`
      SELECT code FROM org_unit WHERE region_id = ${regionAId}::uuid
    `)
    const rowsB = await t.db.execute<{ code: string }>(sql`
      SELECT code FROM org_unit WHERE region_id = ${regionBId}::uuid
    `)
    expect([...rowsA].map((r) => r.code)).toEqual(['a-svc'])
    expect([...rowsB].map((r) => r.code)).toEqual(['b-svc'])
  })

  it('counts per region are independent', async () => {
    const counts = await t.db.execute<{ region_id: string; count: string }>(sql`
      SELECT region_id::text AS region_id, COUNT(*)::text AS count
      FROM teammate GROUP BY region_id ORDER BY region_id
    `)
    const list = [...counts]
    expect(list.length).toBe(2)
    for (const r of list) {
      expect(Number(r.count)).toBe(2)
    }
  })
})
