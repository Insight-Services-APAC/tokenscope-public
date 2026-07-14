/*
 * RLS — region + org-path scoping enforce visibility on attribution_record
 * + project; admin/global-finops bypass.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 2 testing: "RLS scope enforcement".
 *
 * Critical PostgreSQL behaviour: RLS policies don't apply to the table's
 * OWNER by default — we explicitly create a non-owner role inside the
 * test and run scoped queries as that role.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { withRlsContext } from '../../../server/db/rls'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let scopedClient: ReturnType<typeof postgres>
let scopedDb: PostgresJsDatabase<typeof schema>

beforeAll(async () => {
  t = await startTestDb()

  // Create a non-owner role so RLS actually applies. Roles are CLUSTER-global
  // (not per-database): on a fresh testcontainer they never pre-exist, but on
  // a shared TEST_PG_URL server they survive between runs — tolerate that.
  await t.client.unsafe(`
    DO $$ BEGIN
      CREATE ROLE tokenscope_app NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    GRANT USAGE ON SCHEMA public TO tokenscope_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tokenscope_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO tokenscope_app;
    DO $$ BEGIN
      CREATE USER tokenscope_login WITH LOGIN PASSWORD 'app';
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    GRANT tokenscope_app TO tokenscope_login;
  `)

  const url = new URL(t.url)
  url.username = 'tokenscope_login'
  url.password = 'app'
  scopedClient = postgres(url.toString(), { max: 2, idle_timeout: 5 })
  scopedDb = drizzle(scopedClient, { schema })

  // ── Two regions, two org units, two teammates, two projects, two records ──
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('11111111-1111-1111-1111-111111111111', 'apac', 'APAC'),
      ('22222222-2222-2222-2222-222222222222', 'emea', 'EMEA');

    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type) VALUES
      ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111',
       'apac.services'::ltree, 'apac-services', 'APAC Services', 'bu'),
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222',
       'emea.services'::ltree, 'emea-services', 'EMEA Services', 'bu');

    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id) VALUES
      ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'oid-apac', 'apac@example.com',
       '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'oid-emea', 'emea@example.com',
       '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

    INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id) VALUES
      ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'APAC-PRJ', 'h1', 'APAC Project', 'billable',
       '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'EMEA-PRJ', 'h2', 'EMEA Project', 'billable',
       '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

    INSERT INTO instance_attestation (
      instance_id, principal_oid, teammate_id, project_code_hash, tool,
      session_token_hash, region_id, org_unit_id, cost_owning_unit_id
    ) VALUES
      ('00000000-0000-0000-0000-000000000001', 'oid-apac',
       'cccccccc-cccc-cccc-cccc-cccccccccccc', 'h1', 'claude-code', 'tok-1',
       '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      ('00000000-0000-0000-0000-000000000002', 'oid-emea',
       'dddddddd-dddd-dddd-dddd-dddddddddddd', 'h2', 'claude-code', 'tok-2',
       '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

    INSERT INTO attribution_record (
      instance_id, teammate_id, project_id, region_id, org_unit_id, cost_owning_unit_id,
      tool, model, token_type, tokens, cost_usd, rate_card_id, rate_card_version,
      fidelity_tier, cost_basis, ts_event
    ) VALUES
      ('00000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
       'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       'claude-code', 'claude-sonnet', 'output', 100, 1.50,
       gen_random_uuid(), 1, 'tier-1', 'measured', NOW()),
      ('00000000-0000-0000-0000-000000000002', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
       'ffffffff-ffff-ffff-ffff-ffffffffffff', '22222222-2222-2222-2222-222222222222',
       'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
       'claude-code', 'claude-sonnet', 'output', 200, 3.00,
       gen_random_uuid(), 1, 'tier-1', 'measured', NOW());
  `)
}, 180_000)

afterAll(async () => {
  await scopedClient.end({ timeout: 5 })
  await stopTestDb(t)
}, 30_000)

describe('RLS — region + org_unit scope on attribution_record', () => {
  it('an APAC developer sees only APAC attribution rows', async () => {
    const rows = await withRlsContext(
      scopedDb,
      {
        userRegionId: '11111111-1111-1111-1111-111111111111',
        userOrgPath: 'apac.services',
        userRole: 'developer',
        userTeammateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
      async (tx) => tx.execute(sql`SELECT region_id::text FROM attribution_record`),
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.region_id).toBe('11111111-1111-1111-1111-111111111111')
  })

  it('an EMEA developer sees only EMEA attribution rows', async () => {
    const rows = await withRlsContext(
      scopedDb,
      {
        userRegionId: '22222222-2222-2222-2222-222222222222',
        userOrgPath: 'emea.services',
        userRole: 'developer',
        userTeammateId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      },
      async (tx) => tx.execute(sql`SELECT region_id::text FROM attribution_record`),
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.region_id).toBe('22222222-2222-2222-2222-222222222222')
  })

  it('global-finops sees both regions', async () => {
    const rows = await withRlsContext(
      scopedDb,
      {
        userRegionId: '11111111-1111-1111-1111-111111111111',
        userOrgPath: 'apac.services',
        userRole: 'global-finops',
        userTeammateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
      async (tx) => tx.execute(sql`SELECT region_id::text FROM attribution_record`),
    )
    expect(rows.length).toBe(2)
  })

  it('admin sees both regions', async () => {
    const rows = await withRlsContext(
      scopedDb,
      {
        userRegionId: '11111111-1111-1111-1111-111111111111',
        userOrgPath: 'apac.services',
        userRole: 'admin',
        userTeammateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
      async (tx) => tx.execute(sql`SELECT region_id::text FROM attribution_record`),
    )
    expect(rows.length).toBe(2)
  })
})
