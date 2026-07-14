/*
 * Session GC + soft-purge workers — time-skipped end-to-end against
 * testcontainers Postgres.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 4 EVS:
 *   - Session GC worker closes abandoned sessions on its 5-min cadence
 *     (integration with time-skip).
 *   - Soft-purge worker clears PII per 12-month rule.
 *
 * We don't actually skip time — we pass an explicit `now` argument so
 * the worker compares against a far-future date.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runSessionGc } from '../../../server/workers/session-gc'
import { runSoftPurge } from '../../../server/workers/soft-purge'
import * as schema from '../../../drizzle/schema'

let t: TestDb
const TS_NOW = new Date('2026-05-24T00:00:00Z')
const TS_LONG_AGO = new Date('2026-05-22T00:00:00Z') // > 12h before TS_NOW
const TS_VERY_LONG_AGO = new Date('2025-04-01T00:00:00Z') // > 365 days ago

beforeAll(async () => {
  t = await startTestDb()

  // Seed minimal scaffolding: region, org_unit, teammate, project.
  const [region] = await t.db.insert(schema.region).values({ code: 'apac-w', displayName: 'APAC' }).returning()
  const [orgUnit] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: region!.id,
      path: 'apac.w',
      code: 'w-bu',
      displayName: 'W BU',
      unitType: 'bu',
    })
    .returning()
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-w',
      email: 'w@example.com',
      regionId: region!.id,
      orgUnitId: orgUnit!.id,
    })
    .returning()

  // Insert sessions (TS_NOW = 2026-05-24; durable NULL-expiry fallback = 90d):
  //   A — open, ts_start 2 days before TS_NOW, NO expected_end → NOT abandoned
  //       under the 90d fallback. (Was a GC candidate under the old 12h fallback —
  //       the bug this fix removes: a recent durable instance must NOT be closed.)
  //   B — open, ts_expected_end after TS_NOW → still alive
  //   C — open, ts_expected_end before TS_NOW → GC candidate (explicit expiry)
  //   D — open, ts_start > 365 days ago, NO expected_end → GC candidate (90d fallback)
  await t.client.unsafe(`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
       raw_project_code, tool, session_token_hash, ts_start, ts_expected_end,
       ts_actual_end, region_id, org_unit_id, cost_owning_unit_id)
    VALUES
      ('00000000-0000-4000-8000-00000000000a', 'oid-a', 'a@i.com', '${tm!.id}', 'h',
       'PRJ-A', 'claude-code', 'hashA', '${TS_LONG_AGO.toISOString()}', NULL,
       NULL, '${region!.id}', '${orgUnit!.id}', '${orgUnit!.id}'),
      ('00000000-0000-4000-8000-00000000000b', 'oid-b', 'b@i.com', '${tm!.id}', 'h',
       'PRJ-B', 'claude-code', 'hashB', '${TS_NOW.toISOString()}',
       '2099-01-01 00:00:00+00', NULL, '${region!.id}', '${orgUnit!.id}', '${orgUnit!.id}'),
      ('00000000-0000-4000-8000-00000000000c', 'oid-c', 'c@i.com', '${tm!.id}', 'h',
       'PRJ-C', 'claude-code', 'hashC', '${TS_NOW.toISOString()}',
       '${TS_LONG_AGO.toISOString()}', NULL, '${region!.id}', '${orgUnit!.id}', '${orgUnit!.id}'),
      ('00000000-0000-4000-8000-00000000000d', 'oid-d', 'd@i.com', '${tm!.id}', 'h',
       'PRJ-D', 'claude-code', 'hashD', '${TS_VERY_LONG_AGO.toISOString()}',
       NULL, NULL, '${region!.id}', '${orgUnit!.id}', '${orgUnit!.id}')
  `)
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('runSessionGc', () => {
  it('closes abandoned sessions (explicit expiry + >90d fallback), leaves recent + live ones open', async () => {
    const result = await runSessionGc(t.db, TS_NOW)
    expect(result.closedSessionIds.sort()).toEqual([
      // C — explicit ts_expected_end in the past.
      '00000000-0000-4000-8000-00000000000c',
      // D — NULL expected_end + ts_start > 90d ago → durable-fallback candidate.
      '00000000-0000-4000-8000-00000000000d',
    ].sort())

    // A (ts_start 2 days ago, NULL expected_end) must STAY OPEN under the 90d
    // fallback — closing such a recent durable instance at 12h was the outage.
    const [openA] = await t.db
      .select({ tsActualEnd: schema.instanceAttestation.tsActualEnd })
      .from(schema.instanceAttestation)
      .where(eq(schema.instanceAttestation.instanceId, '00000000-0000-4000-8000-00000000000a'))
      .limit(1)
    expect(openA!.tsActualEnd).toBeNull()

    const [openB] = await t.db
      .select({ tsActualEnd: schema.instanceAttestation.tsActualEnd })
      .from(schema.instanceAttestation)
      .where(eq(schema.instanceAttestation.instanceId, '00000000-0000-4000-8000-00000000000b'))
      .limit(1)
    expect(openB!.tsActualEnd).toBeNull()
  })

  it('writes one session-gc-closed audit_event per closed session', async () => {
    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_event WHERE event_type = 'session-gc-closed'
    `
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(2)
  })

  it('a second run does not re-close already-closed sessions', async () => {
    const result = await runSessionGc(t.db, TS_NOW)
    expect(result.closedSessionIds.length).toBe(0)
  })
})

describe('runSoftPurge', () => {
  it('clears PII on the > 12-month-old row only', async () => {
    // Re-insert a row that is over 12 months old and never ended — soft
    // purge candidate. Use a NEW session id so the prior GC doesn't
    // interfere with the assertion.
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_expected_end,
         ts_actual_end, ts_purged, region_id, org_unit_id, cost_owning_unit_id,
         notes)
      VALUES
        ('00000000-0000-4000-8000-00000000000e', 'oid-e', 'e@i.com',
         (SELECT id FROM teammate LIMIT 1), 'h', 'PRJ-E',
         'claude-code', 'hashE', '2025-04-01 00:00:00+00', NULL, NULL, NULL,
         (SELECT id FROM region LIMIT 1),
         (SELECT id FROM org_unit LIMIT 1),
         (SELECT id FROM org_unit LIMIT 1),
         '{"launcher_version":"1.0"}'::jsonb)
    `)

    const result = await runSoftPurge(t.db, TS_NOW)
    expect(result.purgedSessionIds).toContain('00000000-0000-4000-8000-00000000000e')

    const [row] = await t.client<{
      principal_email: string | null
      raw_project_code: string | null
      notes: unknown
      ts_purged: string | null
    }[]>`
      SELECT principal_email, raw_project_code, notes, ts_purged::text AS ts_purged
      FROM instance_attestation
      WHERE instance_id = '00000000-0000-4000-8000-00000000000e'
    `
    expect(row!.principal_email).toBeNull()
    expect(row!.raw_project_code).toBeNull()
    expect(row!.notes).toBeNull()
    expect(row!.ts_purged).not.toBeNull()
  })

  it('a second run is idempotent (already-purged rows are skipped)', async () => {
    const result = await runSoftPurge(t.db, TS_NOW)
    expect(result.purgedSessionIds).not.toContain('00000000-0000-4000-8000-00000000000e')
  })
})
