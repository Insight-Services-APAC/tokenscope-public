// @vitest-environment node
/*
 * Joiner project-lifecycle spill (D2): events past end_date + grace are written
 * UNALLOCATED (project_id/cou nulled), per-event, so a conversation spanning the
 * boundary SPLITS — pre-end events keep the project, post-end events spill.
 * grace comes from the project's region policy (platform default 2h here).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReadJoiner } from '../../../server/workers/azure-monitor-reader'
import { WATERMARK_LOOKBACK_MS, type TelemetryReader, type UsageRecord } from '../../../server/azure/reader'

let t: TestDb
const INSTANCE = '66666666-6666-6666-6666-666666666666'
const PROJECT = '44444444-4444-4444-4444-444444444444'
// end_date 2026-06-01T00:00 + platform grace 2h → boundary 2026-06-01T02:00.
const PRE = '2026-05-31T23:00:00Z' // before end → attributed
const IN_GRACE = '2026-06-01T01:00:00Z' // within grace → attributed
const POST = '2026-06-01T05:00:00Z' // past boundary → spilled

class StubReader {
  constructor(public readonly map: Map<string, UsageRecord[]>) {}
  async getSessionUsage(sessionId: string, sinceTsEvent?: Date): Promise<UsageRecord[]> {
    const all = this.map.get(sessionId) ?? []
    if (!sinceTsEvent) return all
    const cutoff = sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS
    return all.filter((u) => new Date(u.tsEvent).getTime() > cutoff)
  }
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('11111111-1111-1111-1111-111111111111','apac','APAC');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
      VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',
              'apac.services'::ltree,'apac-svcs','APAC Services','bu');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES ('33333333-3333-3333-3333-333333333333','oid','dev@i.com',
              '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222');
    -- Project ENDED 2026-06-01.
    INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id, end_date)
      VALUES ('${PROJECT}','CSL-AII','h-afl-aii','Contoso League','billable',
              '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
              '2026-06-01T00:00:00Z');
    INSERT INTO project_assignment (project_id, teammate_id, effective)
      VALUES ('${PROJECT}','33333333-3333-3333-3333-333333333333','[2026-01-01,2099-01-01)'::tstzrange);
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
       tool, session_token_hash, ts_start, ts_actual_end, region_id, org_unit_id, cost_owning_unit_id)
    VALUES
      ('${INSTANCE}','oid','dev@i.com','33333333-3333-3333-3333-333333333333','h-afl-aii','CSL-AII',
       'claude-code','hashS','2026-05-31T22:00:00Z','2026-06-01T06:00:00Z',
       '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
       '22222222-2222-2222-2222-222222222222');
  `)
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('runReadJoiner — end_date spill', () => {
  it('splits a boundary-spanning conversation: pre-end attributed, post-end spilled', async () => {
    const reader = new StubReader(
      new Map([
        [
          INSTANCE,
          [
            { tokens: 1000, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: PRE, projectCodeHash: 'h-afl-aii' },
            { tokens: 1000, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: IN_GRACE, projectCodeHash: 'h-afl-aii' },
            { tokens: 1000, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: POST, projectCodeHash: 'h-afl-aii' },
          ],
        ],
      ]),
    ) as unknown as TelemetryReader

    const res = await runReadJoiner(t.db, reader, { sessionIds: [INSTANCE] })
    expect(res.attributionRowsWritten).toBe(3)
    expect(res.spansSpilledEnded).toBe(1)

    const attributed = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM attribution_record
      WHERE instance_id = ${INSTANCE}::uuid AND project_id = ${PROJECT}::uuid`
    expect(Number(attributed[0]!.n)).toBe(2)

    const spilled = await t.client<{ n: string; cou: string | null }[]>`
      SELECT COUNT(*)::text AS n, MAX(cost_owning_unit_id::text) AS cou FROM attribution_record
      WHERE instance_id = ${INSTANCE}::uuid AND project_id IS NULL`
    expect(Number(spilled[0]!.n)).toBe(1)
    expect(spilled[0]!.cou).toBeNull()
  })

  it('honors a REGION grace=0 override — an in-grace event that stayed attributed now spills', async () => {
    // Region grace=0 override: the boundary collapses to end_date itself, so the
    // IN_GRACE event (end+1h) that stayed attributed under the 2h platform grace
    // now spills. Proves the joiner resolves grace by the project's region (D9).
    await t.client.unsafe(`
      INSERT INTO project_lifecycle_policy (scope_type, scope_id, grace_hours, warn_days)
      VALUES ('region', '11111111-1111-1111-1111-111111111111', 0, 7)`)
    const inst2 = '77777777-7777-7777-7777-777777777777'
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
         tool, session_token_hash, ts_start, ts_actual_end, region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${inst2}','oid','dev@i.com','33333333-3333-3333-3333-333333333333','h-afl-aii','CSL-AII',
         'claude-code','hashS2','2026-05-31T22:00:00Z','2026-06-01T06:00:00Z',
         '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
         '22222222-2222-2222-2222-222222222222')`)
    const reader = new StubReader(
      new Map([[inst2, [{ tokens: 1000, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: IN_GRACE, projectCodeHash: 'h-afl-aii' }]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [inst2] })
    expect(res.spansSpilledEnded).toBe(1) // grace=0 → end+1h is past the boundary
    const spilled = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM attribution_record WHERE instance_id = ${inst2}::uuid AND project_id IS NULL`
    expect(Number(spilled[0]!.n)).toBe(1)
  })

  it('re-run does NOT re-count, re-audit, or re-notify (gated on newly-written rows)', async () => {
    const inboxBefore = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM inbox_item WHERE category = 'project-ended-retag'`
    const auditBefore = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event WHERE event_type = 'attribution-spill-ended'`
    // Re-feed the already-written POST event. It conflicts (onConflictDoNothing),
    // so nothing is newly written → the counter, the append-only audit, and the
    // inbox must all stay put. This guards the R1 ins.length gating directly.
    const reader = new StubReader(
      new Map([[INSTANCE, [{ tokens: 1000, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: POST, projectCodeHash: 'h-afl-aii' }]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [INSTANCE] })
    expect(res.spansSpilledEnded).toBe(0) // re-read row is not newly written

    const inboxAfter = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM inbox_item WHERE category = 'project-ended-retag'`
    const auditAfter = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event WHERE event_type = 'attribution-spill-ended'`
    expect(Number(inboxAfter[0]!.n)).toBe(Number(inboxBefore[0]!.n)) // not re-emitted
    expect(Number(auditAfter[0]!.n)).toBe(Number(auditBefore[0]!.n)) // not re-audited
  })
})
