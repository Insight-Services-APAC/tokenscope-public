// @vitest-environment node
/*
 * recordBearerAuthFailed atomicity (CORE-5, robustness review 2026-06-09).
 *
 * The INSERT … WHERE NOT EXISTS was not atomic under concurrency: two
 * transactions could both pass NOT EXISTS and both insert, and the 0029
 * partial index was non-unique — multiple open bearer-auth-failed rows per
 * instance double-counted the disaster signal. Migration 0043 makes the
 * partial index UNIQUE; the helper adds ON CONFLICT DO NOTHING.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { recordBearerAuthFailed, resolveBearerAuthFailed } from '../../../server/db/instance-health'

let t: TestDb
const TEAM = '33333333-3333-3333-3333-333333333333'
const INST = '66666666-6666-6666-6666-666666666666'

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('11111111-1111-1111-1111-111111111111', 'apac', 'APAC');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
              'apac.services'::ltree, 'apac-svcs', 'APAC Services', 'bu');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES ('${TEAM}', 'oid', 'dev@i.com',
              '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
       raw_project_code, tool, session_token_hash, ts_start,
       region_id, org_unit_id, cost_owning_unit_id, attestation_state)
    VALUES
      ('${INST}', 'oid', 'dev@i.com', '${TEAM}', NULL, NULL,
       'claude-code', 'hashS', NOW(),
       '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
       NULL, 'unassigned');
  `)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function openRows(): Promise<number> {
  const [r] = await t.client<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM instance_attestation_health
    WHERE instance_id = ${INST}::uuid AND status = 'bearer-auth-failed' AND resolved_at IS NULL`
  return Number(r!.c)
}

describe('recordBearerAuthFailed (CORE-5)', () => {
  it('concurrent failure reports open exactly ONE health row', async () => {
    await Promise.all([
      recordBearerAuthFailed(t.db, INST),
      recordBearerAuthFailed(t.db, INST),
      recordBearerAuthFailed(t.db, INST),
      recordBearerAuthFailed(t.db, INST),
    ])
    expect(await openRows()).toBe(1)
  })

  it('a direct duplicate insert (a path that forgets the NOT EXISTS) hits the unique index', async () => {
    await expect(
      t.client.unsafe(`
        INSERT INTO instance_attestation_health (instance_id, status, payload)
        VALUES ('${INST}', 'bearer-auth-failed', '{}'::jsonb)
      `),
    ).rejects.toThrow(/unique|duplicate/i)
  })

  it('resolve closes the episode; a NEW episode can open afterwards', async () => {
    await resolveBearerAuthFailed(t.db, INST)
    expect(await openRows()).toBe(0)
    await recordBearerAuthFailed(t.db, INST)
    expect(await openRows()).toBe(1)
  })
})
