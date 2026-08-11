// @vitest-environment node
/*
 * mig 0129 backfill — report_access_grant preserves today's access EXACTLY.
 *
 * `startTestDb()` (tests/integration/helpers/db.ts) runs ALL migrations, so it
 * cannot prove a BACKFILL: by the time it hands back a connection,
 * `report_visibility_setting` never existed. This suite builds the PRE-0129
 * state by hand — replaying every migration up to (but excluding) 0129 against
 * a throwaway database, seeding the pre-state the backfill's CTE reads, then
 * applying 0129 and asserting the `report_access_grant` rows it wrote.
 *
 * Works under BOTH database providers: `startTestDb()` provisions the server
 * (a testcontainer in CI, the TEST_PG_URL server locally), and this suite
 * connects through the per-suite database it hands back to CREATE its own
 * throwaway pre-0129 databases beside it. One throwaway database per `it()`
 * so cases cannot see each other's pre-state; DROP DATABASE in teardown.
 *
 * Cases (migration 0129's own comment, verbatim):
 *   - mode row absent (standard): only org-wide-role teammates get rows.
 *   - mode 'region-admins-see-all': admins also get both.
 *   - mode 'all-admins-see-all': admins + active cou_owner holders get both.
 *   - after 0129, report_visibility_setting is gone.
 *   - no duplicate (teammate, permission) rows even when a teammate matches
 *     multiple eligibility arms (org-wide role + owner).
 */
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import postgres from 'postgres'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'drizzle', 'migrations')
const MIG_0129 = '0129_report_access_grant.sql'

type Sql = ReturnType<typeof postgres>

async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
}

interface PreMigrationDb {
  db: Sql
  dbName: string
}

/*
 * The server-admin connection rides the anchor TestDb's OWN url — CREATE/DROP
 * DATABASE only needs a connection to *some* database on the server with
 * sufficient privileges, and the anchor's per-suite database is exactly that,
 * with proven credentials in BOTH provider modes (testcontainer superuser in
 * CI, the TEST_PG_URL superuser locally). No assumption that a `postgres`
 * maintenance database exists or is connectable.
 *
 * Teardown MUST go through stopTestDb: only the TEST_PG_URL branch returns a
 * `teardown` callback — in container mode that property is absent and calling
 * it is a TypeError; stopTestDb handles both. Sibling databases are dropped
 * inside each it() before this afterAll runs.
 */
let anchor: TestDb
let serverAdminUrl = ''

beforeAll(async () => {
  anchor = await startTestDb()
  serverAdminUrl = anchor.url
}, 180_000)

afterAll(async () => {
  if (anchor) await stopTestDb(anchor)
})

/** CREATE a throwaway database and replay every migration BEFORE 0129. */
async function createPreMigrationDb(): Promise<PreMigrationDb> {
  const dbName = `tokenscope_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  if (!/^tokenscope_test_[0-9a-f]{12}$/.test(dbName)) {
    throw new Error(`test db name escaped its expected shape: ${dbName}`)
  }
  const admin = postgres(serverAdminUrl, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE ${dbName}`)
  } finally {
    await admin.end({ timeout: 5 })
  }
  const u = new URL(serverAdminUrl)
  u.pathname = `/${dbName}`
  const db = postgres(u.toString(), { max: 4, idle_timeout: 5, connection: { TimeZone: 'UTC' } })

  const files = await migrationFiles()
  const idx = files.indexOf(MIG_0129)
  if (idx === -1) throw new Error(`migration ${MIG_0129} not found on disk`)
  for (const file of files.slice(0, idx)) {
    const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    await db.unsafe(body)
  }
  return { db, dbName }
}

async function apply0129(db: Sql): Promise<void> {
  const body = await readFile(join(MIGRATIONS_DIR, MIG_0129), 'utf8')
  await db.unsafe(body)
}

async function dropDb(state: PreMigrationDb): Promise<void> {
  await state.db.end({ timeout: 5 })
  const admin = postgres(serverAdminUrl, { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${state.dbName} WITH (FORCE)`)
  } finally {
    await admin.end({ timeout: 5 })
  }
}

/** Run `run` against a fresh pre-0129 database, guaranteeing teardown. */
async function withPreMigrationDb(run: (db: Sql) => Promise<void>): Promise<void> {
  const state = await createPreMigrationDb()
  try {
    await run(state.db)
  } finally {
    await dropDb(state)
  }
}

const mkRegion = async (db: Sql, code: string) => {
  await db`INSERT INTO region (code, display_name) VALUES (${code}, ${code})`
  const [r] = await db<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
  return r!.id
}

const mkUnit = async (
  db: Sql,
  regionId: string,
  path: string,
  code: string,
  opts: { retired?: boolean } = {},
) => {
  await db`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit, retired_at)
    VALUES (${regionId}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', true, ${opts.retired ? new Date().toISOString() : null})`
  const [r] = await db<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code=${code}`
  return r!.id
}

const mkTeammate = async (
  db: Sql,
  regionId: string,
  unitId: string,
  email: string,
  role: string,
  opts: { active?: boolean; provisional?: boolean } = {},
) => {
  await db`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, is_active, provisional)
    VALUES ('oid-'||${email}, ${email}, ${email}, ${regionId}::uuid, ${unitId}::uuid, ${role}, ${opts.active ?? true}, ${opts.provisional ?? false})`
  const [r] = await db<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
  return r!.id
}

const mkCouOwner = async (db: Sql, unitId: string, teammateId: string, opts: { revoked?: boolean } = {}) => {
  await db`INSERT INTO cou_owner (org_unit_id, teammate_id, revoked_at)
    VALUES (${unitId}::uuid, ${teammateId}::uuid, ${opts.revoked ? new Date().toISOString() : null})`
}

async function grantsByTeammate(db: Sql): Promise<Map<string, string[]>> {
  const rows = await db<{ teammate_id: string; permission: string }[]>`
    SELECT teammate_id::text AS teammate_id, permission FROM report_access_grant`
  const byTeammate = new Map<string, string[]>()
  for (const r of rows) {
    const arr = byTeammate.get(r.teammate_id) ?? []
    arr.push(r.permission)
    byTeammate.set(r.teammate_id, arr)
  }
  return byTeammate
}

const BOTH = new Set(['operational', 'finance'])

describe('mig 0129 backfill', () => {
  it(
    "mode row absent (standard): only org-wide-role teammates get rows",
    async () => {
      await withPreMigrationDb(async (db) => {
        const region = await mkRegion(db, 'bf-std')
        const unit = await mkUnit(db, region, 'bfstd', 'bf-std-unit')
        const adminId = await mkTeammate(db, region, unit, 'admin@bf-std.test', 'admin')
        const managerId = await mkTeammate(db, region, unit, 'manager@bf-std.test', 'manager')
        const ownerId = await mkTeammate(db, region, unit, 'owner@bf-std.test', 'developer')
        await mkCouOwner(db, unit, ownerId)
        const finopsId = await mkTeammate(db, region, unit, 'finops@bf-std.test', 'global-finops')
        const platformId = await mkTeammate(db, region, unit, 'platform@bf-std.test', 'platform-admin')
        const inactiveFinopsId = await mkTeammate(db, region, unit, 'inactive-finops@bf-std.test', 'global-finops', {
          active: false,
        })
        const provisionalAdminId = await mkTeammate(db, region, unit, 'prov-admin@bf-std.test', 'admin', {
          provisional: true,
        })

        // NO report_visibility_setting row — absent ⇒ 'standard', per the
        // migration's own `COALESCE(..., 'standard')`.
        await apply0129(db)

        const byTeammate = await grantsByTeammate(db)
        expect(new Set(byTeammate.get(adminId) ?? [])).toEqual(new Set())
        expect(new Set(byTeammate.get(managerId) ?? [])).toEqual(new Set())
        expect(new Set(byTeammate.get(ownerId) ?? [])).toEqual(new Set())
        expect(new Set(byTeammate.get(finopsId))).toEqual(BOTH)
        expect(new Set(byTeammate.get(platformId))).toEqual(BOTH)
        expect(byTeammate.get(inactiveFinopsId) ?? []).toEqual([])
        expect(byTeammate.get(provisionalAdminId) ?? []).toEqual([])
      })
    },
    120_000,
  )

  it(
    "mode 'region-admins-see-all': admins also get both",
    async () => {
      await withPreMigrationDb(async (db) => {
        const region = await mkRegion(db, 'bf-ras')
        const unit = await mkUnit(db, region, 'bfras', 'bf-ras-unit')
        const adminId = await mkTeammate(db, region, unit, 'admin@bf-ras.test', 'admin')
        const managerId = await mkTeammate(db, region, unit, 'manager@bf-ras.test', 'manager')
        const ownerId = await mkTeammate(db, region, unit, 'owner@bf-ras.test', 'developer')
        await mkCouOwner(db, unit, ownerId)
        const finopsId = await mkTeammate(db, region, unit, 'finops@bf-ras.test', 'global-finops')

        await db`INSERT INTO report_visibility_setting (key, mode) VALUES ('policy', 'region-admins-see-all')`
        await apply0129(db)

        const byTeammate = await grantsByTeammate(db)
        expect(new Set(byTeammate.get(adminId))).toEqual(BOTH)
        expect(new Set(byTeammate.get(finopsId))).toEqual(BOTH)
        // Ownership alone does NOT elevate under this mode — only
        // 'all-admins-see-all' adds the cou_owner arm.
        expect(new Set(byTeammate.get(ownerId) ?? [])).toEqual(new Set())
        expect(new Set(byTeammate.get(managerId) ?? [])).toEqual(new Set())
      })
    },
    120_000,
  )

  it(
    "mode 'all-admins-see-all': admins + ACTIVE cou_owner holders get both; a REVOKED owner and an owner of a RETIRED unit do not",
    async () => {
      await withPreMigrationDb(async (db) => {
        const region = await mkRegion(db, 'bf-aas')
        const unit = await mkUnit(db, region, 'bfaas', 'bf-aas-unit')
        const retiredUnit = await mkUnit(db, region, 'bfaasret', 'bf-aas-retired-unit', { retired: true })
        const adminId = await mkTeammate(db, region, unit, 'admin@bf-aas.test', 'admin')
        const managerId = await mkTeammate(db, region, unit, 'manager@bf-aas.test', 'manager')
        const ownerId = await mkTeammate(db, region, unit, 'owner@bf-aas.test', 'developer')
        await mkCouOwner(db, unit, ownerId)
        const revokedOwnerId = await mkTeammate(db, region, unit, 'revoked-owner@bf-aas.test', 'developer')
        await mkCouOwner(db, unit, revokedOwnerId, { revoked: true })
        const retiredUnitOwnerId = await mkTeammate(db, region, unit, 'retired-unit-owner@bf-aas.test', 'developer')
        await mkCouOwner(db, retiredUnit, retiredUnitOwnerId)

        await db`INSERT INTO report_visibility_setting (key, mode) VALUES ('policy', 'all-admins-see-all')`
        await apply0129(db)

        const byTeammate = await grantsByTeammate(db)
        expect(new Set(byTeammate.get(adminId))).toEqual(BOTH)
        expect(new Set(byTeammate.get(ownerId))).toEqual(BOTH)
        expect(new Set(byTeammate.get(revokedOwnerId) ?? [])).toEqual(new Set())
        expect(new Set(byTeammate.get(retiredUnitOwnerId) ?? [])).toEqual(new Set())
        expect(new Set(byTeammate.get(managerId) ?? [])).toEqual(new Set())
      })
    },
    120_000,
  )

  it(
    'after 0129, report_visibility_setting is gone (to_regclass IS NULL)',
    async () => {
      await withPreMigrationDb(async (db) => {
        const [present] = await db<{ present: boolean }[]>`
          SELECT to_regclass('report_visibility_setting') IS NOT NULL AS present`
        expect(present!.present).toBe(true) // sanity: it existed pre-migration

        await apply0129(db)

        const [after] = await db<{ present: boolean }[]>`
          SELECT to_regclass('report_visibility_setting') IS NOT NULL AS present`
        expect(after!.present).toBe(false)
      })
    },
    120_000,
  )

  it(
    'no duplicate (teammate, permission) rows even when a teammate matches multiple eligibility arms (org-wide role + owner)',
    async () => {
      await withPreMigrationDb(async (db) => {
        const region = await mkRegion(db, 'bf-dup')
        const unit = await mkUnit(db, region, 'bfdup', 'bf-dup-unit')
        // global-finops AND an active cou_owner row: eligible via the
        // unconditional org-wide-role arm AND (under 'all-admins-see-all') the
        // ownership arm. The backfill's `eligible` CTE is `SELECT DISTINCT`
        // before the permission cross-join, so this must still land exactly two
        // rows — never four.
        const bothArmsId = await mkTeammate(db, region, unit, 'both-arms@bf-dup.test', 'global-finops')
        await mkCouOwner(db, unit, bothArmsId)

        await db`INSERT INTO report_visibility_setting (key, mode) VALUES ('policy', 'all-admins-see-all')`
        await apply0129(db)

        const rows = await db<{ n: string }[]>`
          SELECT COUNT(*)::text AS n FROM report_access_grant WHERE teammate_id = ${bothArmsId}::uuid`
        expect(Number(rows[0]!.n)).toBe(2)
        const byTeammate = await grantsByTeammate(db)
        expect(new Set(byTeammate.get(bothArmsId))).toEqual(BOTH)
      })
    },
    120_000,
  )
})
