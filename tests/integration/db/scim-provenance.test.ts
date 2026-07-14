/*
 * SCIM-style sync provenance — manual rows default pinned; un-pinning lets
 * sync workers touch them.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 2 testing: "SCIM-provenance
 * pinning rules". The integration-level claim is structural: rows default
 * `source='manual'` + `is_pinned=true`. Worker-side enforcement (the
 * "MUST NOT UPDATE pinned rows" rule) is implemented in sync workers that
 * land at Epic 6+; this test asserts the schema default that those
 * workers depend on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { eq } from 'drizzle-orm'
import * as schema from '../../../drizzle/schema'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('sync provenance defaults', () => {
  it('teammate rows default to manual + pinned', async () => {
    const [region] = await t.db
      .insert(schema.region)
      .values({ code: 'apac-scim', displayName: 'APAC' })
      .returning()
    const [orgUnit] = await t.db
      .insert(schema.orgUnit)
      .values({
        regionId: region!.id,
        path: 'apac.services.scim',
        code: 'scim-unit',
        displayName: 'SCIM',
        unitType: 'bu',
      })
      .returning()
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: 'oid-scim',
        email: 'scim@example.com',
        regionId: region!.id,
        orgUnitId: orgUnit!.id,
      })
      .returning()

    expect(tm!.source).toBe('manual')
    expect(tm!.isPinned).toBe(true)
    expect(tm!.lastSyncAt).toBeNull()
  })

  it('admin can un-pin a manual row (source stays manual; sync may now touch)', async () => {
    const tm = (
      await t.db
        .select()
        .from(schema.teammate)
        .where(eq(schema.teammate.email, 'scim@example.com'))
    )[0]
    if (!tm) throw new Error('precondition: scim teammate missing')

    const [updated] = await t.db
      .update(schema.teammate)
      .set({ isPinned: false })
      .where(eq(schema.teammate.id, tm.id))
      .returning()

    expect(updated!.isPinned).toBe(false)
    // Source is left alone so audit trail preserves origin.
    expect(updated!.source).toBe('manual')
  })

  it('a sync worker can set source=sync:<connector> + is_pinned=false on a fresh row', async () => {
    const region = (
      await t.db.select().from(schema.region).where(eq(schema.region.code, 'apac-scim'))
    )[0]
    const orgUnit = (
      await t.db.select().from(schema.orgUnit).where(eq(schema.orgUnit.code, 'scim-unit'))
    )[0]
    if (!region || !orgUnit) throw new Error('precondition: region or org unit missing')

    const [syncTm] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: 'oid-sync',
        email: 'sync@example.com',
        regionId: region.id,
        orgUnitId: orgUnit.id,
        source: 'sync:scim-entra',
        isPinned: false,
      })
      .returning()

    expect(syncTm!.source).toBe('sync:scim-entra')
    expect(syncTm!.isPinned).toBe(false)
  })
})
